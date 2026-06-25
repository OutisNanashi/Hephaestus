import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runAgentTask } from "../src/agent.js";
import { HephaestusError } from "../src/errors.js";
import { loadState, saveState } from "../src/state.js";

const validState = Object.freeze({
  currentPhase: "4", currentTask: "run-one-agent-task", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function assertCode(error, code) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, code); return true; }

function makeContext() {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(path.join(projectPath, "out", "prompts"), { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Agent project\n", "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n\nExisting entry.\n", "CURRENT_TASK.md": "# Run task\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  fs.writeFileSync(path.join(projectPath, "out", "prompts", "next-task.md"), "# Delivered prompt\n\nDo the declared task.\n");
  return { directory, allowedRoot, projectPath, promptPath: "out/prompts/next-task.md" };
}

function runFixture(context, adapterId = "fixture-agent") {
  return runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId, promptPath: context.promptPath });
}

test("fixture process adapter receives the delivered prompt and captures output", () => {
  const context = makeContext();
  try {
    const result = runFixture(context);
    assert.equal(result.status, "completed");
    assert.match(result.output, /fixture-agent received prompt/u);
    assert.match(result.output, /Delivered prompt/u);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("agent output is saved and BUILD_LOG.md is appended without overwrite", () => {
  const context = makeContext();
  try {
    const before = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    runFixture(context);
    assert.match(fs.readFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "utf8"), /fixture-agent completed/u);
    const after = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    assert.ok(after.startsWith(before));
    assert.match(after, /\[phase-6a-agent-run\].*status=completed/u);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("completed agent task records completed state", () => {
  const context = makeContext();
  try {
    runFixture(context);
    const state = loadState(context.projectPath);
    assert.equal(state.nextAction, "agent-completed");
    assert.equal(state.lastSuccessfulStep, "agent-run");
    assert.equal(state.blocked, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("empty agent output becomes blocked and increments retry count", () => {
  const context = makeContext();
  try {
    const result = runFixture(context, "fixture-agent-empty");
    const state = loadState(context.projectPath);
    assert.equal(result.status, "blocked");
    assert.equal(state.blocked, true);
    assert.equal(state.nextAction, "agent-output-empty");
    assert.equal(state.attemptCount, 1);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("agent crash is failed rather than success and increments retry count", () => {
  const context = makeContext();
  try {
    const result = runFixture(context, "fixture-agent-crash");
    const state = loadState(context.projectPath);
    assert.equal(result.status, "failed");
    assert.equal(state.blocked, true);
    assert.equal(state.nextAction, "agent-failed");
    assert.equal(state.attemptCount, 1);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("usage-limit output becomes paused state", () => {
  const context = makeContext();
  try {
    const result = runFixture(context, "fixture-agent-usage-limit");
    const state = loadState(context.projectPath);
    assert.equal(result.status, "paused");
    assert.equal(state.usageLimitPaused, true);
    assert.equal(state.nextAction, "agent-usage-limit-paused");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("same task is not duplicated when state is already running", () => {
  const context = makeContext();
  try {
    saveState(context.projectPath, { ...validState, nextAction: "agent-running" });
    assert.throws(() => runFixture(context), (error) => assertCode(error, "AGENT_TASK_ALREADY_RUNNING"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("agent prompt cannot escape the selected project boundary", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId: "fixture-agent", promptPath: "../outside.md" }),
      (error) => assertCode(error, "INVALID_AGENT_PROMPT_PATH")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("fixture agent runs in the sandbox with no unsafe environment", () => {
  const context = makeContext();
  try {
    process.env.HEPHAESTUS_AGENT_SECRET = "not-for-container";
    const result = runFixture(context);
    assert.deepEqual(result.report.sandbox.environment, { LANG: "C.UTF-8" });
    assert.equal("HEPHAESTUS_AGENT_SECRET" in result.report.sandbox.environment, false);
  } finally {
    delete process.env.HEPHAESTUS_AGENT_SECRET;
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});
