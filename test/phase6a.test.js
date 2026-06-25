import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runAgentTask } from "../src/agent.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { loadState, saveState, validateState } from "../src/state.js";

const validState = Object.freeze({
  currentPhase: "6A",
  currentTask: "fixture-agent-harness",
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
  nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext(prompt = "# Delivered prompt\n\nDo the declared task.\n") {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(path.join(projectPath, "out", "prompts"), { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Agent project\n",
    "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n\nExisting entry.\n",
    "CURRENT_TASK.md": "# Run task\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  fs.writeFileSync(path.join(projectPath, "out", "prompts", "next-task.md"), prompt);
  return { directory, allowedRoot, projectPath, promptPath: "out/prompts/next-task.md" };
}

function runFixture(context, adapterId = "fixture-agent") {
  return runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId, promptPath: context.promptPath });
}

test("fixture adapter receives inert prompt text and captures stdout, stderr, and exit code", () => {
  const context = makeContext("# Prompt\n\n$(touch SHOULD_NOT_EXIST)\n");
  try {
    const result = runFixture(context);
    assert.equal(result.status, "completed");
    assert.match(result.stdout, /fixture-agent received prompt/u);
    assert.match(result.stdout, /\$\(touch SHOULD_NOT_EXIST\)/u);
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(path.join(context.projectPath, "SHOULD_NOT_EXIST")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fixture adapter stderr and nonzero exit are captured as failed", () => {
  const context = makeContext();
  try {
    const result = runFixture(context, "fixture-agent-crash");
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 23);
    assert.match(result.stderr, /fixture-agent crashed/u);
    assert.equal(loadState(context.projectPath).agent.errorCategory, "nonzero-exit");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("missing prompt, empty prompt, unknown adapter, and real adapter are rejected", () => {
  const context = makeContext("");
  try {
    assert.throws(() => runFixture(context), (error) => code(error, "EMPTY_AGENT_PROMPT"));
    fs.rmSync(path.join(context.projectPath, context.promptPath));
    assert.throws(() => runFixture(context), (error) => code(error, "PATH_RESOLUTION_FAILED"));
    fs.writeFileSync(path.join(context.projectPath, context.promptPath), "# Prompt\n");
    assert.throws(() => runFixture(context, "unknown-agent"), (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE"));
    assert.throws(() => runFixture(context, "codex"), (error) => code(error, "REAL_AGENT_EXECUTION_DISABLED"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("structured AGENT_OUTPUT, append-only BUILD_LOG, and validated completed state are written", () => {
  const context = makeContext();
  try {
    const before = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    const result = runFixture(context);
    const output = fs.readFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "utf8");
    const after = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    const state = loadState(context.projectPath);
    assert.ok(after.startsWith(before));
    assert.equal((after.match(/\[phase-6a-agent-run\]/gu) ?? []).length, 1);
    assert.match(output, /Run id: agent-/u);
    assert.match(output, /Status: completed/u);
    assert.match(output, /## Stdout/u);
    assert.equal(state.nextAction, "agent-completed");
    assert.equal(state.agent.status, "completed");
    assert.equal(state.agent.outputPath, "AGENT_OUTPUT.md");
    assert.doesNotThrow(() => validateState(state));
    assert.equal(result.agentOutputPath, path.join(context.projectPath, "AGENT_OUTPUT.md"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("empty output, explicit blocker text, usage limit, and timeout classify safely", () => {
  const scenarios = [
    ["fixture-agent-empty", "blocked", "agent-output-empty", "empty-output"],
    ["fixture-agent-blocker", "blocked", "agent-blocked", "agent-blocker"],
    ["fixture-agent-usage-limit", "paused", "agent-usage-limit-paused", "usage-limit"],
    ["fixture-agent-timeout", "failed", "agent-timeout", "timeout"]
  ];
  for (const [adapter, status, nextAction, category] of scenarios) {
    const context = makeContext();
    try {
      const result = runFixture(context, adapter);
      const state = loadState(context.projectPath);
      assert.equal(result.status, status);
      assert.equal(state.nextAction, nextAction);
      assert.equal(state.agent.errorCategory, category);
      if (status === "paused") assert.equal(state.usageLimitPaused, true);
      if (status !== "paused") assert.equal(state.attemptCount, 1);
    } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
  }
});

test("same task, prompt traversal, unsafe project path, and outside-root project are rejected", () => {
  const context = makeContext();
  try {
    saveState(context.projectPath, { ...validState, nextAction: "agent-running" });
    assert.throws(() => runFixture(context), (error) => code(error, "AGENT_TASK_ALREADY_RUNNING"));
    saveState(context.projectPath, validState);
    assert.throws(
      () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId: "fixture-agent", promptPath: "../outside.md" }),
      (error) => code(error, "INVALID_AGENT_PROMPT_PATH")
    );
    assert.throws(
      () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.directory, adapterId: "fixture-agent", promptPath: context.promptPath }),
      (error) => code(error, "OUTSIDE_ALLOWED_ROOT")
    );
    const outsideProject = temporaryDirectory();
    try {
      assert.throws(
        () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: outsideProject, adapterId: "fixture-agent", promptPath: context.promptPath }),
        (error) => code(error, "OUTSIDE_ALLOWED_ROOT")
      );
    } finally { fs.rmSync(outsideProject, { recursive: true, force: true }); }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-run can deliver an allowed-root runtime prompt without printing prompt content", () => {
  const context = makeContext();
  const runtimePrompt = path.join(context.allowedRoot, "runtime-prompt.md");
  const configPath = path.join(context.directory, "config.json");
  const registryPath = path.join(context.directory, "projects.json");
  fs.writeFileSync(runtimePrompt, "# Runtime prompt\n\nDo not execute this text.\n");
  writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
  let stdout = "";
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    const exitCode = runCli(["agent-run", "--config", configPath, "--project", "demo-project", "--adapter", "fixture-agent", "--prompt", runtimePrompt]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.exitCode, 0);
    assert.equal(stdout.includes("Runtime prompt"), false);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});
