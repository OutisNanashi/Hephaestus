import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { HephaestusError } from "../src/errors.js";
import { fixturePr, taskBranchName } from "../src/git-workflow.js";
import { inspectProject } from "../src/inspection.js";
import { requestMockDecision } from "../src/mock-provider.js";
import { loadProjectRegistry } from "../src/registry.js";
import { sandboxArgs } from "../src/sandbox.js";
import { saveState } from "../src/state.js";
import { verifyTestEvidence } from "../src/test-gate.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const validState = Object.freeze({
  currentPhase: "0",
  currentTask: "regression",
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
const SYMLINK_TEST_SKIP = process.platform === "win32" ? "requires symlink creation permission" : false;

function temporaryDirectory() {
  return writableTemporaryDirectory("hephaestus-repair-");
}

function permissionTestDirectory() {
  return writableTemporaryDirectory("hephaestus-permission-");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertCode(error, code) {
  assert.ok(error instanceof HephaestusError, `expected HephaestusError, got ${error}`);
  assert.equal(error.code, code);
  return true;
}

function makeProject(root, name = "demo-project") {
  const projectPath = path.join(root, name);
  fs.mkdirSync(projectPath, { recursive: true });
  for (const file of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) {
    fs.writeFileSync(path.join(projectPath, file), "fixture\n");
  }
  writeJson(path.join(projectPath, "STATE.json"), validState);
  return projectPath;
}

function makeContext() {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = makeProject(allowedRoot);
  const configPath = path.join(directory, "config.json");
  writeJson(configPath, {
    allowedRoot: "./projects",
    registryPath: "./projects.json",
    logDirectory: "./logs"
  });
  writeJson(path.join(directory, "projects.json"), {
    projects: [{ id: "demo-project", path: "demo-project" }]
  });
  return { directory, allowedRoot, projectPath, configPath };
}

test("CLI rejects flag-token option values", () => {
  assert.throws(
    () => run(["cycle", "--project", "--task"]),
    (error) => assertCode(error, "INVALID_ARGUMENT")
  );
});

test("CLI rejects an option with no following value", () => {
  assert.throws(
    () => run(["cycle", "--project"]),
    (error) => assertCode(error, "INVALID_ARGUMENT")
  );
});

test("CLI git-branch validates the project directory before mutating Git state", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, "PLAN.md"));
    const headBefore = fs.existsSync(path.join(context.projectPath, ".git"));
    assert.throws(
      () => run(["git-branch", "--config", context.configPath, "--project", "demo-project", "--task", "demo-task"]),
      (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE")
    );
    assert.equal(fs.existsSync(path.join(context.projectPath, ".git")), headBefore);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("CLI git-commit validates the project directory before mutating Git state", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, "BUILD_LOG.md"));
    const before = fs.existsSync(path.join(context.projectPath, ".git"));
    assert.throws(
      () => run(["git-commit", "--config", context.configPath, "--project", "demo-project", "--message", "x"]),
      (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE")
    );
    assert.equal(fs.existsSync(path.join(context.projectPath, ".git")), before);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("CLI HELP advertises every implemented command", () => {
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
  for (const command of ["validate", "inspect", "cycle", "sandbox-run", "agent-run", "verify-tests", "git-branch", "git-commit", "pr-open"]) {
    assert.match(output, new RegExp(`\\b${command}\\b`, "u"));
  }
});

test("config loader maps allowedRoot stat failures to a domain error", () => {
  const directory = temporaryDirectory();
  try {
    const configPath = path.join(directory, "config.json");
    writeJson(configPath, {
      allowedRoot: "./does-not-exist",
      registryPath: "./registry.json",
      logDirectory: "./logs"
    });
    assert.throws(
      () => loadConfig(configPath),
      (error) => assertCode(error, "INVALID_CONFIG")
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("git workflow source applies timeout and a non-interactive Git environment", () => {
  const source = fs.readFileSync(path.resolve("src/git-workflow.js"), "utf8");
  assert.match(source, /GIT_TERMINAL_PROMPT.*"0"/u);
  assert.match(source, /timeout:\s*GIT_TIMEOUT_MS/u);
  assert.match(source, /GIT_TIMEOUT_MS\s*=\s*\d/u);
});

test("fixture PR URL encodes special characters in projectId and task", () => {
  const taskName = "hot fix?with#chars";
  const projectName = "demo-project";
  const pr = fixturePr(projectName, taskName);
  assert.equal(pr.branch, taskBranchName(projectName, taskName));
  assert.equal(pr.url.startsWith("https://fixture.invalid/"), true);
  const pathSegments = pr.url.slice("https://fixture.invalid/".length).split("/");
  for (const segment of pathSegments) {
    for (const banned of [" ", "?", "#", "&", "%", "+", ","]) {
      assert.equal(segment.includes(banned), false, `URL segment '${segment}' must not contain raw '${banned}'`);
    }
  }
});

test("inspection maps a missing required file to MISSING_REQUIRED_PROJECT_FILE (not a raw fs error)", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, "PLAN.md"));
    assert.throws(
      () => inspectProject(context.allowedRoot, context.projectPath),
      (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE")
    );
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("mock-provider fixture read failure surfaces a Hephaestus domain error (never a raw fs error)", () => {
  const directory = temporaryDirectory();
  try {
    const allowedRoot = path.join(directory, "projects");
    fs.mkdirSync(allowedRoot, { recursive: true });
    assert.throws(
      () => requestMockDecision(allowedRoot, "missing-fixture.json"),
      (error) => {
        assert.ok(error instanceof HephaestusError, "fixture read failure must produce a HephaestusError");
        assert.ok(
          ["MOCK_FIXTURE_READ_FAILED", "PATH_RESOLUTION_FAILED", "OUTSIDE_ALLOWED_ROOT"].includes(error.code),
          `unexpected error code ${error.code}`
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mock-provider source maps unwrapped fs errors to MOCK_FIXTURE_READ_FAILED", () => {
  const source = fs.readFileSync(path.resolve("src/mock-provider.js"), "utf8");
  assert.match(source, /MOCK_FIXTURE_READ_FAILED/u);
  assert.match(source, /error instanceof HephaestusError/u);
});

test("registry refuses a project entry missing a path field with INVALID_REGISTRY", () => {
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "projects");
    fs.mkdirSync(root);
    writeJson(path.join(directory, "registry.json"), { projects: [{ id: "demo-project" }] });
    assert.throws(
      () => loadProjectRegistry(path.join(directory, "registry.json"), root),
      (error) => assertCode(error, "INVALID_REGISTRY")
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sandboxArgs rejects projectPath containing a comma", () => {
  assert.throws(
    () => sandboxArgs("/tmp/evil,readonly=false", "container", "true"),
    (error) => assertCode(error, "UNSAFE_SANDBOX_MOUNT_PATH")
  );
});

test("sandboxArgs rejects projectPath containing an equals sign", () => {
  assert.throws(
    () => sandboxArgs("/tmp/evil=x", "container", "true"),
    (error) => assertCode(error, "UNSAFE_SANDBOX_MOUNT_PATH")
  );
});

test("sandboxArgs accepts a normal projectPath", () => {
  const args = sandboxArgs("/tmp/project", "container", "true");
  assert.ok(args.includes("--mount"));
  const mountIndex = args.indexOf("--mount");
  assert.equal(args[mountIndex + 1], "type=bind,src=/tmp/project,dst=/workspace,readonly");
});

test("saveState writes to the resolved real path so a symlink swap cannot redirect writes outside the project", { skip: SYMLINK_TEST_SKIP }, () => {
  const directory = temporaryDirectory();
  try {
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    const outside = path.join(directory, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, path.join(project, "STATE.json"));
    assert.throws(
      () => saveState(project, validState),
      (error) => assertCode(error, "OUTSIDE_ALLOWED_ROOT")
    );
    assert.equal(fs.readFileSync(outside, "utf8"), "{}\n");
    assert.equal(fs.lstatSync(path.join(project, "STATE.json")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("saveState refuses an in-project STATE.json symlink instead of following it", { skip: SYMLINK_TEST_SKIP }, () => {
  const directory = temporaryDirectory();
  try {
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    const alternate = path.join(project, "alternate-state.json");
    fs.writeFileSync(alternate, "{}\n");
    fs.symlinkSync(alternate, path.join(project, "STATE.json"));
    assert.throws(
      () => saveState(project, validState),
      (error) => assertCode(error, "OUTSIDE_ALLOWED_ROOT")
    );
    assert.equal(fs.readFileSync(alternate, "utf8"), "{}\n");
    assert.equal(fs.lstatSync(path.join(project, "STATE.json")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("saveState bootstraps STATE.json into the resolved real project path when no file exists yet", () => {
  const directory = temporaryDirectory();
  try {
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    saveState(project, validState);
    const written = JSON.parse(fs.readFileSync(path.join(project, "STATE.json"), "utf8"));
    assert.equal(written.currentPhase, validState.currentPhase);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("saveState updates an existing normal STATE.json", () => {
  const directory = temporaryDirectory();
  try {
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(validState)}\n`);
    const updatedState = { ...validState, nextAction: "updated" };
    saveState(project, updatedState);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, "STATE.json"), "utf8")), updatedState);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("saveState preserves restrictive permissions on an existing normal STATE.json", { skip: process.platform === "win32" ? "POSIX file modes are not available" : false }, (t) => {
  const directory = permissionTestDirectory();
  try {
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    const statePath = path.join(project, "STATE.json");
    fs.writeFileSync(statePath, `${JSON.stringify(validState)}\n`, { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);

    if ((fs.statSync(statePath).mode & 0o777) !== 0o600) {
      t.skip("filesystem does not honor POSIX chmod");
      return;
    }

    saveState(project, { ...validState, nextAction: "preserve-mode" });

    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("test-gate validates report path before fs.existsSync (source order check)", () => {
  const source = fs.readFileSync(path.resolve("src/test-gate.js"), "utf8");
  const readJsonStart = source.indexOf("function readJson");
  assert.ok(readJsonStart >= 0, "readJson definition not found");
  const readJsonEnd = source.indexOf("\n}", readJsonStart);
  assert.ok(readJsonEnd > readJsonStart);
  const body = source.slice(readJsonStart, readJsonEnd);
  const resolveAt = body.indexOf("resolveSafePath");
  const existsAt = body.indexOf("fs.existsSync");
  assert.ok(resolveAt >= 0, "readJson should call resolveSafePath");
  assert.ok(existsAt >= 0, "readJson should still check existence");
  assert.ok(resolveAt < existsAt, "resolveSafePath must run before fs.existsSync");
});

test("verifyTestEvidence still surfaces missing-evidence as a domain error", () => {
  const directory = temporaryDirectory();
  try {
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    assert.throws(
      () => verifyTestEvidence(project),
      (error) => assertCode(error, "MISSING_TEST_EVIDENCE")
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("phase 6 tests use the writable temporary-directory helper", () => {
  const source = fs.readFileSync(path.resolve("test/phase6.test.js"), "utf8");
  assert.match(source, /writableTemporaryDirectory/u);
  assert.equal(source.includes('"/tmp/hephaestus-git-"'), false);
});
