import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { loadConfig, loadLocalEnvironment } from "../src/config.js";
import { HephaestusError } from "../src/errors.js";
import { ensureProjectLogDirectory } from "../src/logging.js";
import { validateProjectDirectory } from "../src/project.js";
import { loadProjectRegistry } from "../src/registry.js";
import { resolveSafePath } from "../src/safe-path.js";
import { validateState } from "../src/state.js";

const validState = Object.freeze({
  currentPhase: "0",
  currentTask: "test",
  currentBranch: "main",
  currentPr: null,
  assignedAgent: null,
  attemptCount: 0,
  blocked: false,
  usageLimitPaused: false,
  lastSuccessfulStep: null,
  mergeStatus: "not-started",
  containerStatus: "not-started",
  lastGptDecision: null,
  nextAction: "validate"
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(path.resolve("test"), "tmp-"));
  return directory;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeProject(root, name = "demo") {
  const project = path.join(root, name);
  fs.mkdirSync(project, { recursive: true });
  for (const file of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) {
    fs.writeFileSync(path.join(project, file), "fixture\n");
  }
  writeJson(path.join(project, "STATE.json"), validState);
  return project;
}

function assertCode(error, code) {
  assert.ok(error instanceof HephaestusError);
  assert.equal(error.code, code);
  return true;
}

test("config loading resolves a valid allowed root and local support paths", () => {
  const directory = temporaryDirectory();
  try {
    const allowedRoot = path.join(directory, "projects");
    fs.mkdirSync(allowedRoot);
    writeJson(path.join(directory, "config.json"), {
      allowedRoot: "./projects",
      registryPath: "./registry.json",
      logDirectory: "./logs"
    });
    const config = loadConfig(path.join(directory, "config.json"));
    assert.equal(config.allowedRoot, fs.realpathSync(allowedRoot));
    assert.equal(config.registryPath, path.join(directory, "registry.json"));
    assert.equal(config.logDirectory, path.join(directory, "logs"));
    writeJson(path.join(directory, "bad.json"), { allowedRoot: "./projects", registryPath: "./registry.json" });
    assert.throws(() => loadConfig(path.join(directory, "bad.json")), (error) => assertCode(error, "INVALID_CONFIG"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local .env values load through configuration without writing secrets to output", () => {
  const directory = temporaryDirectory();
  const envName = "HEPHAESTUS_LOCAL_ENV_TEST";
  const secretName = "HEPHAESTUS_LOCAL_ENV_SECRET";
  const secret = `local-secret-${"x".repeat(48)}`;
  let output = "";
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  delete process.env[envName];
  delete process.env[secretName];
  process.stdout.write = (chunk) => { output += chunk; return true; };
  process.stderr.write = (chunk) => { output += chunk; return true; };
  try {
    const allowedRoot = path.join(directory, "projects");
    fs.mkdirSync(allowedRoot);
    writeJson(path.join(directory, "config.json"), { allowedRoot: "./projects", registryPath: "./registry.json", logDirectory: "./logs" });
    fs.writeFileSync(path.join(directory, ".env"), `# local values\n${envName}=loaded\n${secretName}=${secret}\n`);
    loadConfig(path.join(directory, "config.json"));
    assert.equal(process.env[envName], "loaded");
    assert.equal(process.env[secretName].length, secret.length);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
    delete process.env[envName];
    delete process.env[secretName];
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(output, "");
});

test("local .env loading preserves existing values and safely ignores a missing file", () => {
  const directory = temporaryDirectory();
  const envName = "HEPHAESTUS_LOCAL_ENV_EXISTING";
  process.env[envName] = "already-set";
  try {
    const envFile = path.join(directory, ".env");
    fs.writeFileSync(envFile, `${envName}=from-file\n`);
    assert.deepEqual(loadLocalEnvironment(envFile), []);
    assert.equal(process.env[envName], "already-set");
    assert.doesNotThrow(() => loadLocalEnvironment(path.join(directory, "absent.env")));
  } finally {
    delete process.env[envName];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("STATE.json schema accepts a complete state and rejects missing fields", () => {
  assert.deepEqual(validateState(validState), validState);
  const invalid = { ...validState };
  delete invalid.nextAction;
  assert.throws(() => validateState(invalid), (error) => assertCode(error, "INVALID_STATE"));
});

test("project registry validates ids and resolves registered project paths", () => {
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "projects");
    fs.mkdirSync(root);
    writeJson(path.join(directory, "registry.json"), { projects: [{ id: "demo-project", path: "demo-project" }] });
    const projects = loadProjectRegistry(path.join(directory, "registry.json"), root);
    assert.deepEqual(projects, [{ id: "demo-project", path: path.join(root, "demo-project") }]);
    writeJson(path.join(directory, "bad-registry.json"), { projects: [{ id: "Bad Id", path: "demo-project" }] });
    assert.throws(() => loadProjectRegistry(path.join(directory, "bad-registry.json"), root), (error) => assertCode(error, "INVALID_REGISTRY"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("project folder detection validates required files and STATE.json", () => {
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "projects");
    const project = makeProject(root);
    const validation = validateProjectDirectory(root, project);
    assert.equal(validation.path, fs.realpathSync(project));
    assert.equal(validation.state.currentPhase, "0");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("safe path resolution remains under the configured root", () => {
  const root = path.resolve("fixtures/projects");
  assert.equal(resolveSafePath(root, "example-project"), path.join(root, "example-project"));
  assert.throws(() => resolveSafePath(root, path.resolve("unrelated-project")), (error) => assertCode(error, "OUTSIDE_ALLOWED_ROOT"));
});

test("missing required project files are refused", () => {
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "projects");
    const project = makeProject(root);
    fs.rmSync(path.join(project, "CURRENT_TASK.md"));
    assert.throws(() => validateProjectDirectory(root, project), (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("registry refuses a project path outside the allowed root", () => {
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "projects");
    fs.mkdirSync(root);
    writeJson(path.join(directory, "registry.json"), { projects: [{ id: "outside", path: path.join(directory, "unrelated") }] });
    assert.throws(() => loadProjectRegistry(path.join(directory, "registry.json"), root), (error) => assertCode(error, "OUTSIDE_ALLOWED_ROOT"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("safe path resolver refuses traversal before path normalization", () => {
  assert.throws(() => resolveSafePath(path.resolve("fixtures/projects"), "example-project/../other"), (error) => assertCode(error, "UNSAFE_PATH"));
});

test("log directory creation is scoped by project id", () => {
  const directory = temporaryDirectory();
  try {
    const logDirectory = ensureProjectLogDirectory(path.join(directory, "logs"), "demo-project");
    assert.ok(fs.statSync(logDirectory).isDirectory());
    assert.equal(logDirectory, path.join(directory, "logs", "demo-project"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI help command succeeds without reading configuration", () => {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...args) => {
    output += chunk;
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    assert.equal(run(["--help"]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(output, /Hephaestus Phase/u);
  assert.match(output, /validate/u);
});
