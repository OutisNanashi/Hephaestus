import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { checkSandboxHealth, runSandboxCommand, sandboxContainerExists } from "../src/sandbox.js";

const validState = Object.freeze({
  currentPhase: "3",
  currentTask: "run-sandbox-command",
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
  nextAction: "sandbox-run"
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeContext() {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "PLAN.md"), "# Sandbox project\n");
  fs.writeFileSync(path.join(projectPath, "BUILDING_REFERENCE.md"), "# Reference\n");
  fs.writeFileSync(path.join(projectPath, "BUILD_LOG.md"), "# Build log\n");
  fs.writeFileSync(path.join(projectPath, "CURRENT_TASK.md"), "# Current task\n");
  writeJson(path.join(projectPath, "STATE.json"), validState);
  const configPath = path.join(directory, "config.json");
  writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  writeJson(path.join(directory, "projects.json"), { projects: [{ id: "demo-project", path: "demo-project" }] });
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

test("container sandbox starts and reports a healthy mounted workspace", () => {
  const context = makeContext();
  try {
    const health = checkSandboxHealth(context.allowedRoot, context.projectPath);
    assert.equal(health.healthy, true);
    assert.equal(health.workspace, "/workspace");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("allowlisted command runs and captures stdout", () => {
  const context = makeContext();
  try {
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-echo" });
    assert.equal(report.status, "passed");
    assert.equal(report.stdout, "sandbox-ok\n");
    assert.equal(report.exitCode, 0);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("allowlisted npm test runs inside the mounted project and captures output", () => {
  const context = makeContext();
  try {
    fs.writeFileSync(path.join(context.projectPath, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('sandbox-npm-ok')\"" } }));
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-npm" });
    assert.equal(report.status, "passed");
    assert.match(report.stdout, /sandbox-npm-ok/u);
    assert.equal(report.sandbox.workspace, "/workspace");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("allowlisted identity probe proves the container workspace", () => {
  const context = makeContext();
  try {
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-identity" });
    assert.equal(report.status, "passed");
    assert.match(report.stdout, /^workspace=\/workspace$/mu);
    assert.match(report.stdout, /^hostname=.+$/mu);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("forbidden command is rejected before sandbox startup", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "echo arbitrary host text" }),
      (error) => assertCode(error, "COMMAND_NOT_ALLOWED")
    );
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("failed command captures stderr and exit code", () => {
  const context = makeContext();
  try {
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-stderr" });
    assert.equal(report.status, "failed");
    assert.equal(report.stdout, "sandbox-out\n");
    assert.equal(report.stderr, "sandbox-err\n");
    assert.equal(report.exitCode, 7);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("timeout is recorded as a failed sandbox command", () => {
  const context = makeContext();
  try {
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-timeout" });
    assert.equal(report.status, "timed_out");
    assert.equal(report.timedOut, true);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("path escape fails through safe project resolution", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.directory, commandId: "test-echo" }),
      (error) => assertCode(error, "OUTSIDE_ALLOWED_ROOT")
    );
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("sandboxed command cannot access unrelated host folders", () => {
  const context = makeContext();
  try {
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-host-inaccessible" });
    assert.equal(report.status, "passed");
    assert.equal(report.sandbox.network, "none");
    assert.equal(report.sandbox.projectMountedReadOnly, true);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("structured command report is saved under the selected project", () => {
  const context = makeContext();
  try {
    const result = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-echo" });
    const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
    assert.equal(result.reportPath, path.join(context.projectPath, "out", "test_reports", "command-test-echo.json"));
    assert.equal(report.stdout, "sandbox-ok\n");
    assert.equal(report.exitCode, 0);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("sandbox cleanup removes the disposable container", () => {
  const context = makeContext();
  try {
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-echo" });
    assert.equal(report.cleanup.attempted, true);
    assert.equal(sandboxContainerExists(report.containerName), false);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("unsafe host environment variables are not passed into the sandbox", () => {
  const context = makeContext();
  try {
    process.env.HEPHAESTUS_TEST_SECRET = "must-not-enter-container";
    const report = runSandboxCommand({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, commandId: "test-echo" });
    assert.deepEqual(report.sandbox.environment, { LANG: "C.UTF-8" });
    assert.equal("HEPHAESTUS_TEST_SECRET" in report.sandbox.environment, false);
  } finally {
    delete process.env.HEPHAESTUS_TEST_SECRET;
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("sandbox-run CLI accepts an allowlisted command id only", () => {
  const context = makeContext();
  try {
    const output = captureOutput(() => assert.equal(run([
      "sandbox-run", "--config", context.configPath, "--project", "demo-project", "--command", "test-echo"
    ]), 0));
    assert.equal(JSON.parse(output).stdout, "sandbox-ok\n");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});
