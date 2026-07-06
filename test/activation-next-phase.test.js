import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import { requestNextPhasePlan } from "../src/phase-plan.js";
import { advanceToNextPhase, ensureTaskBranch } from "../src/phase-transition.js";
import { loadState } from "../src/state.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const PLAN = `# Demo\n\nPhase 1: first\nPhase 2: second\nPhase 3: third\n`;

const mergedState = Object.freeze({
  currentPhase: "1", currentTask: "first-task", currentBranch: "hephaestus/demo/first-task", currentPr: null,
  assignedAgent: "codex", attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: "agent-run", mergeStatus: "merged",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "next-phase-eligible",
  agent: {
    lastRunId: "codex-1", adapterId: "codex", status: "completed", exitCode: 0,
    startedAt: "2026-07-06T00:00:00.000Z", finishedAt: "2026-07-06T00:00:10.000Z",
    promptPath: "out/agent_runs/current/prompt.md", outputPath: "AGENT_OUTPUT.md",
    outputSummary: "done", usageLimitDetected: false, blockerDetected: false, errorCategory: null
  }
});

function git(repo, args) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

// A real project clone with a bare origin, sitting on a task branch after a
// "merged" phase — the exact shape next-phase must reset and advance.
function makeProject({ state = mergedState } = {}) {
  const directory = writableTemporaryDirectory("hephaestus-next-phase-");
  const origin = path.join(directory, "origin.git");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "master", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", origin, project], { stdio: "pipe" });
  git(project, ["config", "user.email", "t@local"]);
  git(project, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(project, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(project, "BUILDING_REFERENCE.md"), "rules\n");
  fs.writeFileSync(path.join(project, "BUILD_LOG.md"), "# Build log\n[phase-7-merge] pr=1 phase 1 merged\n");
  fs.writeFileSync(path.join(project, "CURRENT_TASK.md"), "# Phase 1 task\n");
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(path.join(project, ".gitignore"), "AGENT_OUTPUT.md\nout/\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "phase 1 merged"]);
  git(project, ["push", "-q", "origin", "master"]);
  // Sit on a leftover task branch with uncommitted conductor churn, as after a real merge.
  git(project, ["switch", "-qc", "hephaestus/demo/first-task"]);
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(path.join(project, "AGENT_OUTPUT.md"), "stale report from phase 1\n");
  return { directory, root, project };
}

function cleanup(context) {
  fs.rmSync(context.directory, { recursive: true, force: true });
}

function phaseFetch(plan, capture = {}) {
  capture.requests = [];
  return async (url, options) => {
    capture.requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ output_text: JSON.stringify(plan) }) };
  };
}

const readyPlan = Object.freeze({
  status: "phase-ready",
  phase: "2",
  taskId: "second-task",
  taskMarkdown: "# Current task: second-task (Phase 2)\n\nImplement Phase 2.\n",
  rationale: "Phase 1 is merged, so Phase 2 is next."
});

function advance(context, plan, capture) {
  return advanceToNextPhase({
    allowedRoot: context.root,
    projectPath: context.project,
    projectId: "demo",
    brain: { provider: "openai", model: "m" },
    env: { OPENAI_API_KEY: "k" },
    fetchImpl: phaseFetch(plan, capture)
  });
}

function code(error, expected) {
  assert.ok(error instanceof HephaestusError, `expected HephaestusError, got ${error}`);
  assert.equal(error.code, expected);
  return true;
}

test("phase plan validation accepts both shapes and rejects malformed output", () => {
  const capture = {};
  return (async () => {
    const ready = await requestNextPhasePlan({ apiKey: "k", model: "m", planContext: PLAN, buildLog: "phase 1 merged", currentPhase: "1", fetchImpl: phaseFetch(readyPlan, capture) });
    assert.equal(ready.status, "phase-ready");
    assert.equal(ready.taskId, "second-task");
    assert.match(capture.requests[0].input, /phase planner/u);
    const done = await requestNextPhasePlan({ apiKey: "k", model: "m", planContext: PLAN, currentPhase: "3", fetchImpl: phaseFetch({ status: "all-complete", rationale: "All three phases built." }) });
    assert.equal(done.status, "all-complete");
    // Bad slug, oversized/secret markdown, and unknown status are all rejected after the strict retry.
    await assert.rejects(() => requestNextPhasePlan({ apiKey: "k", model: "m", planContext: PLAN, currentPhase: "1", fetchImpl: phaseFetch({ ...readyPlan, taskId: "Bad Slug!" }) }), (error) => code(error, "INVALID_PHASE_PLAN"));
    await assert.rejects(() => requestNextPhasePlan({ apiKey: "k", model: "m", planContext: PLAN, currentPhase: "1", fetchImpl: phaseFetch({ ...readyPlan, taskMarkdown: "sk-abcdef0123456789abcdef" }) }), (error) => code(error, "INVALID_PHASE_PLAN"));
    await assert.rejects(() => requestNextPhasePlan({ apiKey: "k", model: "m", planContext: PLAN, currentPhase: "1", fetchImpl: phaseFetch({ status: "weird" }) }), (error) => code(error, "INVALID_PHASE_PLAN"));
  })();
});

test("advancing a merged project resets to base, branches, writes the task, and advances state", async () => {
  const context = makeProject();
  const capture = {};
  try {
    const result = await advance(context, readyPlan, capture);
    assert.equal(result.status, "phase-ready");
    assert.equal(result.phase, "2");
    assert.equal(result.taskId, "second-task");
    assert.equal(result.branch, "hephaestus/demo/second-task");
    // The brain saw PLAN.md and the build log.
    assert.match(capture.requests[0].input, /Phase 2: second/u);

    const state = loadState(context.project);
    assert.equal(state.currentPhase, "2");
    assert.equal(state.currentTask, "second-task");
    assert.equal(state.currentBranch, "hephaestus/demo/second-task");
    assert.equal(state.nextAction, "run-agent");
    assert.equal(state.mergeStatus, "not-started");
    assert.equal(state.lastSuccessfulStep, "phase-1-merged");
    assert.equal("agent" in state, false, "stale agent report must be cleared");

    // On the new branch, with the fresh task and no stale agent report.
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: context.project }).toString().trim(), "hephaestus/demo/second-task");
    assert.match(fs.readFileSync(path.join(context.project, "CURRENT_TASK.md"), "utf8"), /second-task \(Phase 2\)/u);
    assert.equal(fs.existsSync(path.join(context.project, "AGENT_OUTPUT.md")), false);
    assert.match(fs.readFileSync(path.join(context.project, "BUILD_LOG.md"), "utf8"), /\[next-phase\] phase=2 task=second-task/u);
  } finally { cleanup(context); }
});

test("advancing refuses a project whose current phase is not merged and changes nothing", async () => {
  const context = makeProject({ state: { ...mergedState, mergeStatus: "blocked", nextAction: "agent-completed" } });
  const capture = {};
  try {
    await assert.rejects(() => advance(context, readyPlan, capture), (error) => code(error, "PHASE_NOT_MERGED"));
    assert.equal(capture.requests.length, 0, "the brain must not be called when the guard fails");
    assert.equal(loadState(context.project).currentPhase, "1");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: context.project }).toString().trim(), "hephaestus/demo/first-task");
  } finally { cleanup(context); }
});

test("all-complete marks the project done on base without creating a branch", async () => {
  const context = makeProject();
  try {
    const result = await advance(context, { status: "all-complete", rationale: "Every phase in PLAN.md is built and merged." });
    assert.equal(result.status, "all-complete");
    const state = loadState(context.project);
    assert.equal(state.nextAction, "project-complete");
    assert.equal(state.currentBranch, "master");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: context.project }).toString().trim(), "master");
    assert.match(fs.readFileSync(path.join(context.project, "BUILD_LOG.md"), "utf8"), /\[next-phase\] all phases complete/u);
  } finally { cleanup(context); }
});

test("ensureTaskBranch creates a branch on the base branch and is a no-op once on one", () => {
  const directory = writableTemporaryDirectory("hephaestus-ensure-branch-");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "master", project], { stdio: "pipe" });
  git(project, ["config", "user.email", "t@local"]);
  git(project, ["config", "user.name", "t"]);
  const freshState = { ...mergedState, currentPhase: "1", currentTask: "first-task", currentBranch: "master", mergeStatus: "not-started", nextAction: "run-agent" };
  delete freshState.agent;
  fs.writeFileSync(path.join(project, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(project, "BUILDING_REFERENCE.md"), "rules\n");
  fs.writeFileSync(path.join(project, "BUILD_LOG.md"), "# Build log\n");
  fs.writeFileSync(path.join(project, "CURRENT_TASK.md"), "# task\n");
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(freshState, null, 2)}\n`);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "init"]);
  try {
    const first = ensureTaskBranch({ allowedRoot: root, projectPath: project, projectId: "demo" });
    assert.equal(first.created, true);
    assert.equal(first.branch, "hephaestus/demo/first-task");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: project }).toString().trim(), "hephaestus/demo/first-task");
    assert.equal(loadState(project).currentBranch, "hephaestus/demo/first-task");
    const second = ensureTaskBranch({ allowedRoot: root, projectPath: project, projectId: "demo" });
    assert.equal(second.created, false, "already on a task branch");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a merge recorded only in mergeGate (not mergeStatus) still counts as merged", async () => {
  const context = makeProject({
    state: {
      ...mergedState, mergeStatus: "blocked",
      mergeGate: { readiness: "merged", implementationRetested: true, nextPhaseEligible: true, mergeResult: { project: "demo", phase: "1", pr: "1", headCommit: "abc", mergeCommit: "def", actor: "conductor-merge-relay", mergedAt: "2026-07-06T00:00:00.000Z", gateReportPath: "out/merge_reports/x.json" } }
    }
  });
  try {
    const result = await advance(context, readyPlan);
    assert.equal(result.status, "phase-ready");
  } finally { cleanup(context); }
});
