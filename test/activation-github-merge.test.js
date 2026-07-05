import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeGithubMerge, fetchGithubMergeEvidence, loadApproval, saveApproval } from "../src/github-workflow.js";
import { requestMergeApproval } from "../src/merge-approval.js";
import { loadState } from "../src/state.js";
import { loadTestDeclaration, projectFingerprint, saveTestEvidence } from "../src/test-gate.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const HEAD_COMMIT = "abc123def456";

const baseState = Object.freeze({
  currentPhase: "1", currentTask: "demo-task", currentBranch: "hephaestus/demo/demo-task", currentPr: "https://github.com/demo/demo/pull/9",
  assignedAgent: "codex", attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: "agent-run", mergeStatus: "blocked",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "merge-readiness"
});

function prJson(overrides = {}) {
  return {
    number: 9,
    url: "https://github.com/demo/demo/pull/9",
    state: "OPEN",
    headRefName: "hephaestus/demo/demo-task",
    baseRefName: "master",
    mergeable: "MERGEABLE",
    headRefOid: HEAD_COMMIT,
    ...overrides
  };
}

// Fake gh spawn: answers `pr view` with the configured PR and records merges.
function ghSpawn({ pr = prJson(), mergeCommit = "merge789" } = {}, capture = {}) {
  capture.merges = [];
  return (executable, args) => {
    assert.equal(executable, "gh");
    if (args[0] === "pr" && args[1] === "view" && args.includes("number,url,state,headRefName,baseRefName,mergeable,headRefOid")) {
      return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("mergeCommit,mergedAt")) {
      return { status: 0, stdout: JSON.stringify({ mergeCommit: { oid: mergeCommit }, mergedAt: "2026-07-05T13:00:00.000Z" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      capture.merges.push(args);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
  };
}

function makeProject({ state = baseState, evidence = true } = {}) {
  const directory = writableTemporaryDirectory("hephaestus-gh-merge-");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(project, { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) {
    fs.writeFileSync(path.join(project, name), `${name} fixture\n`);
  }
  fs.writeFileSync(path.join(project, "source.txt"), "source\n");
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(path.join(project, "TESTS.json"), `${JSON.stringify({ requiredCommands: [{ id: "unit", outputRequired: true }], watchedFiles: ["source.txt"] })}\n`);
  if (evidence) saveTestEvidence(project, { projectFingerprint: projectFingerprint(project, loadTestDeclaration(project)), commands: [{ id: "unit", exitCode: 0, stdout: "ok\n", stderr: "" }] });
  // A real git repo on the task branch so branch/dirty evidence comes from real git.
  execFileSync("git", ["init", "-q", "-b", "hephaestus/demo/demo-task"], { cwd: project });
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: project });
  return { directory, root, project };
}

function cleanup(context) {
  fs.rmSync(context.directory, { recursive: true, force: true });
}

function approval(overrides = {}) {
  return {
    approved: true, approvedBy: "GPT", rationale: "All gates green.",
    project: "demo", phase: "1", pr: 9, branch: "hephaestus/demo/demo-task",
    headCommit: HEAD_COMMIT, decidedAt: "2026-07-05T12:30:00.000Z", stale: false,
    ...overrides
  };
}

function approvalFetch(verdict, capture = {}) {
  capture.requests = [];
  return async (url, options) => {
    capture.requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ output_text: JSON.stringify(verdict) }) };
  };
}

test("merge evidence is assembled from real git and GitHub data", () => {
  const context = makeProject();
  try {
    const evidence = fetchGithubMergeEvidence({ projectPath: context.project, state: loadState(context.project), projectId: "demo", spawn: ghSpawn(), now: () => "2026-07-05T12:00:00.000Z" });
    assert.equal(evidence.project, "demo");
    assert.equal(evidence.currentBranch, "hephaestus/demo/demo-task");
    assert.equal(evidence.dirty, false);
    assert.equal(evidence.retest.implementation, true);
    assert.deepEqual({ ...evidence.pr }, { number: 9, url: "https://github.com/demo/demo/pull/9", headBranch: "hephaestus/demo/demo-task", baseBranch: "master", status: "OPEN", mergeable: true, headCommit: HEAD_COMMIT });
  } finally { cleanup(context); }
});

test("merge executes only when every gate passes, then records the result", () => {
  const context = makeProject();
  const capture = {};
  try {
    saveApproval(context.project, approval());
    const result = executeGithubMerge({ projectPath: context.project, state: loadState(context.project), projectId: "demo", spawn: ghSpawn({}, capture), now: () => "2026-07-05T12:35:00.000Z" });
    assert.equal(result.merged, true);
    assert.equal(result.mergeCommit, "merge789");
    assert.equal(capture.merges.length, 1);
    assert.deepEqual(capture.merges[0], ["pr", "merge", "9", "--merge", "--delete-branch"]);
    const state = loadState(context.project);
    assert.equal(state.mergeStatus, "merged");
    assert.equal(state.mergeGate.nextPhaseEligible, true);
    assert.equal(state.mergeGate.mergeResult.actor, "conductor-merge-relay");
    assert.match(fs.readFileSync(path.join(context.project, "BUILD_LOG.md"), "utf8"), /\[phase-7-merge\]/u);
  } finally { cleanup(context); }
});

test("merge is refused without approval and nothing is sent to GitHub", () => {
  const context = makeProject();
  const capture = {};
  try {
    const result = executeGithubMerge({ projectPath: context.project, state: loadState(context.project), projectId: "demo", spawn: ghSpawn({}, capture) });
    assert.equal(result.merged, false);
    assert.ok(result.blockers.includes("MISSING_GPT_APPROVAL"));
    assert.equal(capture.merges.length, 0);
  } finally { cleanup(context); }
});

test("merge is refused when the approved head no longer matches or evidence fails a gate", () => {
  const stale = makeProject();
  const staleCapture = {};
  try {
    saveApproval(stale.project, approval({ headCommit: "different-head" }));
    const result = executeGithubMerge({ projectPath: stale.project, state: loadState(stale.project), projectId: "demo", spawn: ghSpawn({}, staleCapture) });
    assert.equal(result.merged, false);
    assert.ok(result.blockers.includes("GPT_APPROVAL_SCOPE_MISMATCH"));
    assert.equal(staleCapture.merges.length, 0);
  } finally { cleanup(stale); }
  const noTests = makeProject({ evidence: false });
  const testsCapture = {};
  try {
    saveApproval(noTests.project, approval());
    const result = executeGithubMerge({ projectPath: noTests.project, state: loadState(noTests.project), projectId: "demo", spawn: ghSpawn({}, testsCapture) });
    assert.equal(result.merged, false);
    assert.ok(result.blockers.includes("MISSING_TEST_EVIDENCE"));
    assert.equal(testsCapture.merges.length, 0);
  } finally { cleanup(noTests); }
});

test("conductor artifacts never dirty the tree, but real uncommitted code does", () => {
  const context = makeProject();
  const capture = {};
  try {
    saveApproval(context.project, approval());
    // STATE.json, BUILD_LOG.md, out/, merge-inbox/ churn constantly; they must not block.
    fs.appendFileSync(path.join(context.project, "BUILD_LOG.md"), "\nconductor entry\n");
    fs.writeFileSync(path.join(context.project, "STATE.json"), fs.readFileSync(path.join(context.project, "STATE.json")));
    fs.writeFileSync(path.join(context.project, "source.txt"), "uncommitted real change\n");
    const result = executeGithubMerge({ projectPath: context.project, state: loadState(context.project), projectId: "demo", spawn: ghSpawn({}, capture) });
    assert.equal(result.merged, false);
    assert.ok(result.blockers.includes("DIRTY_WORKTREE"));
    assert.equal(capture.merges.length, 0);
  } finally { cleanup(context); }
});

test("an unmergeable or closed PR blocks the merge", () => {
  const context = makeProject();
  const capture = {};
  try {
    saveApproval(context.project, approval());
    const result = executeGithubMerge({ projectPath: context.project, state: loadState(context.project), projectId: "demo", spawn: ghSpawn({ pr: prJson({ mergeable: "CONFLICTING" }) }, capture) });
    assert.equal(result.merged, false);
    assert.ok(result.blockers.includes("PR_UNMERGEABLE"));
    assert.equal(capture.merges.length, 0);
  } finally { cleanup(context); }
});

test("GPT approval verdicts are strictly validated and scoped by the conductor", async () => {
  const context = makeProject();
  try {
    const evidence = fetchGithubMergeEvidence({ projectPath: context.project, state: loadState(context.project), projectId: "demo", spawn: ghSpawn() });
    const capture = {};
    const granted = await requestMergeApproval({ apiKey: "k", model: "m", evidence, testStatus: "passed", fetchImpl: approvalFetch({ approved: true, rationale: "Tests pass and the PR is clean." }, capture), now: () => "2026-07-05T12:30:00.000Z" });
    assert.equal(granted.approved, true);
    assert.equal(granted.approvedBy, "GPT");
    assert.equal(granted.headCommit, HEAD_COMMIT);
    assert.equal(granted.pr, 9);
    assert.match(capture.requests[0].input, /merge-approval authority/u);
    const rejected = await requestMergeApproval({ apiKey: "k", model: "m", evidence, testStatus: "blocked", fetchImpl: approvalFetch({ approved: false, rationale: "Tests are missing." }) });
    assert.equal(rejected.approved, false);
    assert.equal(rejected.headCommit, undefined);
    // A malformed verdict (extra keys) is rejected outright after the strict retry.
    await assert.rejects(() => requestMergeApproval({ apiKey: "k", model: "m", evidence, testStatus: "passed", fetchImpl: approvalFetch({ approved: true, rationale: "ok", headCommit: "attacker-chosen" }) }), (error) => error.code === "INVALID_MERGE_APPROVAL");
  } finally { cleanup(context); }
});

test("stored approvals round-trip and invalid stored approvals fail safely", () => {
  const context = makeProject();
  try {
    assert.equal(loadApproval(context.project), null);
    saveApproval(context.project, approval());
    assert.equal(loadApproval(context.project).headCommit, HEAD_COMMIT);
    fs.writeFileSync(path.join(context.project, "merge-inbox", "approval.json"), "not json");
    assert.throws(() => loadApproval(context.project), (error) => error.code === "INVALID_MERGE_APPROVAL");
  } finally { cleanup(context); }
});
