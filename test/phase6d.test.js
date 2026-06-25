import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runAgentTask } from "../src/agent.js";
import { SMOKE_PROMPT, runCodexSmoke } from "../src/agent-smoke.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const validState = Object.freeze({
  currentPhase: "6D", currentTask: "codex-readonly-smoke", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext() {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "test"), { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Agent project\n",
    "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n\nExisting entry.\n",
    "CURRENT_TASK.md": "# Run task\n",
    "package.json": `${JSON.stringify({ name: "demo-project", version: "0.0.0" }, null, 2)}\n`,
    "src/index.js": "export const greeting = 'hi';\n",
    "test/index.test.js": "import test from 'node:test'; test('noop', () => {});\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  return { directory, allowedRoot, projectPath };
}

function fakeSpawn(behavior) {
  const calls = [];
  const fn = (executable, args, options) => {
    calls.push(Object.freeze({ executable, args: [...args], shell: options?.shell, env: { ...options?.env }, cwd: options?.cwd }));
    return behavior(executable, args, options, calls);
  };
  fn.calls = calls;
  return fn;
}

function baseRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    explicitSmokePermit: true,
    autoApproval: false,
    env: { PATH: "/usr/bin" },
    ...overrides
  };
}

function snapshot(projectPath) {
  const out = {};
  for (const name of ["PLAN.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "src/index.js", "test/index.test.js"]) {
    const file = path.join(projectPath, name);
    out[name] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return out;
}

test("codex readonly-smoke succeeds when fake codex returns SMOKE_OK and mutates no project files", () => {
  const context = makeContext();
  try {
    const before = snapshot(context.projectPath);
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "SMOKE_OK Codex is reachable.\n", stderr: "" }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "completed");
    assert.equal(result.reason, "smoke-ok");
    assert.equal(result.projectMutated, false);
    assert.deepEqual(result.mutatedFiles, []);
    assert.equal(result.invocation.shell, false);
    assert.equal(result.invocation.autoApproval, false);
    assert.equal(result.executable, "codex");
    assert.deepEqual(result.argv, ["--help"]);
    assert.equal(result.promptKind, "smoke");
    assert.equal(result.promptSent, true);
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].executable, "codex");
    assert.equal(spawn.calls[0].shell, false);
    assert.deepEqual(spawn.calls[0].args, ["--help"]);
    assert.deepEqual(snapshot(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fake codex nonzero exit classifies as failed and reports the exit code", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 7, stdout: "", stderr: "codex error\n" }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "nonzero-exit");
    assert.equal(result.exitCode, 7);
    assert.equal(result.projectMutated, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fake codex timeout classifies as failed/timeout without raising", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "timeout");
    assert.equal(result.timedOut, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fake codex usage-limit text classifies as paused", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "usage limit reached; try again later\n", stderr: "" }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "paused");
    assert.equal(result.reason, "usage-limit");
    assert.equal(result.usageLimitDetected, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fake codex BLOCKED text classifies as blocked", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "BLOCKED: cannot proceed\n", stderr: "" }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "blocker");
    assert.equal(result.blockerDetected, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fake codex secret-looking output is redacted from stdout, stderr, and detail", () => {
  const context = makeContext();
  try {
    const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
    const spawn = fakeSpawn(() => ({ status: 0, stdout: `SMOKE_OK token=${secret}\n`, stderr: `gh=ghp_ABCDEFGHIJ1234567890zzzz\n` }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("ghp_ABCDEFGHIJ1234567890zzzz"), false);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes("ghp_ABCDEFGHIJ1234567890zzzz"), false);
    assert.equal(result.detail.includes(secret), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fake codex executable-not-found reports unavailable without crashing", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("not found"), { code: "ENOENT" }) }));
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "executable-not-found");
    assert.equal(result.projectMutated, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("smoke detects and rejects any project mutation introduced during the spawn", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "PLAN.md"), "# Mutated\n");
      return { status: 0, stdout: "SMOKE_OK\n", stderr: "" };
    });
    const result = runCodexSmoke(baseRequest(context, { spawn }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "project-mutated");
    assert.equal(result.projectMutated, true);
    assert.ok(result.mutatedFiles.includes("PLAN.md"));
    assert.equal(result.promptSent, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("smoke rejects non-codex adapters, including claude-code, opencode, and fixtures", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["claude-code", "opencode", "fixture-agent"]) {
      assert.throws(
        () => runCodexSmoke(baseRequest(context, { adapterId })),
        (error) => code(error, "SMOKE_ADAPTER_NOT_ALLOWED")
      );
    }
    assert.throws(
      () => runCodexSmoke(baseRequest(context, { adapterId: "made-up-agent" })),
      (error) => code(error, "SMOKE_ADAPTER_NOT_ALLOWED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("smoke rejects auto-approval, missing explicit permit, and arbitrary prompt input", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "SMOKE_OK\n", stderr: "" }));
    assert.throws(
      () => runCodexSmoke(baseRequest(context, { spawn, autoApproval: true })),
      (error) => code(error, "REAL_AGENT_AUTO_APPROVAL_DISABLED")
    );
    assert.throws(
      () => runCodexSmoke(baseRequest(context, { spawn, explicitSmokePermit: false })),
      (error) => code(error, "SMOKE_PERMIT_REQUIRED")
    );
    assert.throws(
      () => runCodexSmoke(baseRequest(context, { spawn, prompt: "build me a feature" })),
      (error) => code(error, "SMOKE_PROMPT_NOT_ALLOWED")
    );
    const okResult = runCodexSmoke(baseRequest(context, { spawn, prompt: SMOKE_PROMPT }));
    assert.equal(okResult.status, "completed");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("smoke rejects user-supplied executable, command, argv, env, or shellCommand", () => {
  const context = makeContext();
  try {
    for (const evilKey of ["executable", "command", "shellCommand", "argv"]) {
      assert.throws(
        () => runCodexSmoke({ ...baseRequest(context), [evilKey]: "/bin/sh -c rm" }),
        (error) => code(error, "INVALID_SMOKE_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("project outside allowed root is rejected before any spawn happens", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => { throw new Error("must not spawn"); });
    assert.throws(
      () => runCodexSmoke(baseRequest(context, { spawn, projectPath: context.directory })),
      (error) => code(error, "OUTSIDE_ALLOWED_ROOT")
    );
    assert.equal(spawn.calls.length, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("runAgentTask still rejects codex real-task execution with REAL_AGENT_EXECUTION_DISABLED", () => {
  const context = makeContext();
  fs.mkdirSync(path.join(context.projectPath, "out", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(context.projectPath, "out", "prompts", "next-task.md"), "# Prompt\n");
  try {
    assert.throws(
      () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId: "codex", promptPath: "out/prompts/next-task.md" }),
      (error) => code(error, "REAL_AGENT_EXECUTION_DISABLED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-smoke runs against the registered codex executable and returns nonzero when unavailable", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = runCli(["agent-smoke", "--config", configPath, "--project", "demo-project", "--adapter", "codex"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapterId, "codex");
    assert.equal(parsed.mode, "readonly-smoke");
    assert.equal(parsed.invocation.shell, false);
    assert.equal(parsed.invocation.autoApproval, false);
    assert.equal(parsed.executable, "codex");
    assert.deepEqual(parsed.argv, ["--help"]);
    assert.equal(parsed.projectMutated, false);
    assert.notEqual(exitCode, 0);
    assert.deepEqual(snapshot(context.projectPath), snapshot(context.projectPath));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-smoke rejects non-codex adapter selections", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      assert.throws(
        () => runCli(["agent-smoke", "--config", configPath, "--project", "demo-project", "--adapter", "claude-code"]),
        (error) => code(error, "INVALID_ARGUMENT")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("hardcoded smoke prompt is non-building and asks Codex only to reply SMOKE_OK", () => {
  assert.match(SMOKE_PROMPT, /SMOKE_OK/u);
  assert.match(SMOKE_PROMPT, /Do not edit files/u);
  assert.match(SMOKE_PROMPT, /Do not run commands/u);
  assert.equal(/(implement|build|create) (a|the|me)/iu.test(SMOKE_PROMPT), false);
});
