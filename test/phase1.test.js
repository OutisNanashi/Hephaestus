import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { inspectProject } from "../src/inspection.js";

const validState = Object.freeze({
  currentPhase: "1",
  currentTask: "read-project-state",
  currentBranch: "main",
  currentPr: null,
  assignedAgent: null,
  attemptCount: 0,
  blocked: false,
  usageLimitPaused: false,
  lastSuccessfulStep: null,
  reviewStatus: "not-started",
  mergeStatus: "not-started",
  containerStatus: "not-started",
  lastGptDecision: null,
  nextAction: "inspect"
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeProject(root, name = "demo-project") {
  const projectPath = path.join(root, name);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "PLAN.md"), "# Demo plan\n");
  fs.writeFileSync(path.join(projectPath, "BUILDING_REFERENCE.md"), "# Demo reference\n");
  fs.writeFileSync(path.join(projectPath, "BUILD_LOG.md"), "# Demo log\n");
  fs.writeFileSync(path.join(projectPath, "CURRENT_TASK.md"), "# Read project state\n");
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

function assertCode(error, code) {
  assert.ok(error instanceof HephaestusError);
  assert.equal(error.code, code);
  return true;
}

function captureOutput(action) {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...args) => {
    output += chunk;
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

test("reads a valid project fixture", () => {
  const projectPath = path.resolve("fixtures/projects/example-project");
  const projectState = inspectProject(path.resolve("fixtures/projects"), projectPath);
  assert.equal(projectState.documents.plan, "# Example project\n\nThis fixture exists solely to prove Phase 0 project-file validation.\n");
  assert.equal(projectState.documents.agentOutput, null);
  assert.equal(projectState.documents.reviewNotes, null);
});

test("fails safely when PLAN.md is missing", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, "PLAN.md"));
    assert.throws(() => inspectProject(context.allowedRoot, context.projectPath), (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("fails safely when STATE.json is missing", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, "STATE.json"));
    assert.throws(() => inspectProject(context.allowedRoot, context.projectPath), (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("fails safely when STATE.json is invalid", () => {
  const context = makeContext();
  try {
    fs.writeFileSync(path.join(context.projectPath, "STATE.json"), "{ invalid json\n");
    assert.throws(() => inspectProject(context.allowedRoot, context.projectPath), (error) => assertCode(error, "INVALID_JSON"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("fails safely when CURRENT_TASK.md is missing while state declares a task", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, "CURRENT_TASK.md"));
    assert.throws(() => inspectProject(context.allowedRoot, context.projectPath), (error) => assertCode(error, "MISSING_REQUIRED_PROJECT_FILE"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("preserves the exact resolved project path", () => {
  const context = makeContext();
  try {
    assert.equal(inspectProject(context.allowedRoot, context.projectPath).projectPath, fs.realpathSync(context.projectPath));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("preserves the exact current phase", () => {
  const context = makeContext();
  try {
    assert.equal(inspectProject(context.allowedRoot, context.projectPath).currentPhase, validState.currentPhase);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("preserves the exact current task", () => {
  const context = makeContext();
  try {
    assert.equal(inspectProject(context.allowedRoot, context.projectPath).currentTask, validState.currentTask);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("read-only inspection does not modify project files", () => {
  const context = makeContext();
  try {
    const before = Object.fromEntries(fs.readdirSync(context.projectPath).map((name) => [name, fs.readFileSync(path.join(context.projectPath, name), "utf8")]));
    inspectProject(context.allowedRoot, context.projectPath);
    const after = Object.fromEntries(fs.readdirSync(context.projectPath).map((name) => [name, fs.readFileSync(path.join(context.projectPath, name), "utf8")]));
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "summaries")), false);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("produces deterministic normalized state for the same project", () => {
  const context = makeContext();
  try {
    assert.deepEqual(
      inspectProject(context.allowedRoot, context.projectPath),
      inspectProject(context.allowedRoot, context.projectPath)
    );
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("reads optional AGENT_OUTPUT.md when present", () => {
  const context = makeContext();
  try {
    fs.writeFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "agent result\n");
    assert.equal(inspectProject(context.allowedRoot, context.projectPath).documents.agentOutput, "agent result\n");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("reads optional REVIEW_NOTES.md when present", () => {
  const context = makeContext();
  try {
    fs.writeFileSync(path.join(context.projectPath, "REVIEW_NOTES.md"), "review note\n");
    assert.equal(inspectProject(context.allowedRoot, context.projectPath).documents.reviewNotes, "review note\n");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("inspect command does not create out/summaries unless requested", () => {
  const context = makeContext();
  try {
    const output = captureOutput(() => assert.equal(run(["inspect", "--config", context.configPath, "--project", "demo-project"]), 0));
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "summaries")), false);
    assert.equal(JSON.parse(output).reportPath, undefined);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("inspect command creates an inspection report only when requested", () => {
  const context = makeContext();
  try {
    const output = captureOutput(() => assert.equal(run(["inspect", "--config", context.configPath, "--project", "demo-project", "--save-report"]), 0));
    const summary = JSON.parse(output);
    const reportPath = path.join(context.projectPath, "out", "summaries", "inspection.json");
    assert.equal(summary.reportPath, reportPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")).state, validState);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});
