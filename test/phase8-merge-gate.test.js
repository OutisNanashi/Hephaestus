import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { evaluateMergeReadiness } from "../src/merge-gate.js";
import { loadState } from "../src/state.js";
import { loadTestDeclaration, projectFingerprint, saveTestEvidence } from "../src/test-gate.js";

const timestamp = "2026-07-02T12:00:00.000Z";
const state = Object.freeze({ currentPhase: "8", currentTask: "merge-gate", currentBranch: "phase8", currentPr: "https://fixture.invalid/pr/8", assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: "review-ingestion", reviewStatus: "ingested", mergeStatus: "blocked", containerStatus: "healthy", lastGptDecision: null, nextAction: "merge-readiness" });

function json(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }
function reviewSummary(overrides = {}) { return { attempted: true, ingestionStatus: "succeeded", unresolvedBlockers: 0, dismissedCount: 0, resolvedCount: 1, activeSources: ["CodeRabbit"], unavailableSources: ["Qodo"], mergeBlocked: false, ingestedAt: timestamp, failureReason: null, ...overrides }; }
function reviewItems(list = [{ source: "CodeRabbit", externalId: "cr-1", body: "Fixed", actionable: true, status: "resolved", firstSeenAt: timestamp, lastSeenAt: timestamp }]) { return { version: 1, items: list }; }
function mergeInput(overrides = {}) {
  return {
    now: timestamp, project: "demo", phase: "8", currentBranch: "phase8", dirty: false,
    retest: { implementation: true, review: true },
    pr: { number: 8, url: "https://fixture.invalid/pr/8", headBranch: "phase8", baseBranch: "master", status: "OPEN", mergeable: true, headCommit: "abc123" },
    approval: { approved: true, approvedBy: "GPT", project: "demo", phase: "8", pr: 8, branch: "phase8", headCommit: "abc123", decidedAt: "2026-07-02T11:00:00.000Z", stale: false },
    ...overrides
  };
}

// Build a fully merge-ready project inside a registered config so the merge-check CLI can run against it.
function context({ review = reviewSummary(), items = reviewItems(), evidence = true, input = mergeInput() } = {}) {
  const directory = fs.mkdtempSync(path.join(path.resolve("test"), "tmp-p8-"));
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(path.join(project, "merge-inbox"), { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, name), "fixture\n");
  fs.writeFileSync(path.join(project, "source.txt"), "source\n");
  json(path.join(project, "STATE.json"), { ...state, review });
  json(path.join(project, "TESTS.json"), { requiredCommands: [{ id: "unit", outputRequired: true }], watchedFiles: ["source.txt"] });
  fs.mkdirSync(path.join(project, "out", "review_reports"), { recursive: true });
  json(path.join(project, "out", "review_reports", "review-items.json"), items);
  if (evidence) saveTestEvidence(project, { projectFingerprint: projectFingerprint(project, loadTestDeclaration(project)), commands: [{ id: "unit", exitCode: 0, stdout: "ok\n", stderr: "" }] });
  json(path.join(project, "merge-inbox", "mocked.json"), input);
  const config = path.join(directory, "config.json");
  json(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  json(path.join(directory, "projects.json"), { projects: [{ id: "demo", path: "demo" }] });
  return { directory, project, config };
}
function cleanup(c) { fs.rmSync(c.directory, { recursive: true, force: true }); }

function mergeCheck(c) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  let exit;
  try { exit = run(["merge-check", "--project", "demo", "--config", c.config]); }
  finally { process.stdout.write = original; }
  return { exit, output: JSON.parse(output) };
}
// Re-evaluate the same project directly with an overridden merge input (avoids re-seeding fixtures).
function gate(c, overrides = {}) { return evaluateMergeReadiness({ projectPath: c.project, state: loadState(c.project), input: mergeInput(overrides), now: timestamp }); }
function blockers(result) { return result.blockers.map((b) => b.code); }

test("golden path: merge-check allows when every local gate passes and writes a deterministic report", () => {
  const c = context();
  try {
    const { exit, output } = mergeCheck(c);
    assert.equal(exit, 0);
    assert.equal(output.ready, true);
    assert.deepEqual(output.blockers, []);
    assert.equal(output.headSha.match, true);
    const expected = path.join(c.project, "out", "merge_reports", "phase-8-pr-8.json");
    assert.equal(output.reportPath, expected);
    const report = JSON.parse(fs.readFileSync(expected, "utf8"));
    assert.equal(report.ready, true);
    assert.equal(report.allowed, true);
    // Deterministic: a second run produces byte-identical report content.
    const first = fs.readFileSync(expected, "utf8");
    mergeCheck(c);
    assert.equal(fs.readFileSync(expected, "utf8"), first);
  } finally { cleanup(c); }
});

test("merge-check blocks (exit 1) and reports blockers when local gates fail", () => {
  const c = context({ evidence: false });
  try {
    const { exit, output } = mergeCheck(c);
    assert.equal(exit, 1);
    assert.equal(output.ready, false);
    assert.ok(output.blockers.includes("MISSING_TEST_EVIDENCE"));
  } finally { cleanup(c); }
});

test("blocked without test evidence and with failed / missing-command / outputless tests", () => {
  const c = context();
  try {
    saveTestEvidence(c.project, { projectFingerprint: projectFingerprint(c.project, loadTestDeclaration(c.project)), commands: [{ id: "unit", exitCode: 1, stdout: "", stderr: "boom" }] });
    assert.ok(blockers(gate(c)).includes("FAILED_TESTS"));
    saveTestEvidence(c.project, { projectFingerprint: projectFingerprint(c.project, loadTestDeclaration(c.project)), commands: [] });
    assert.ok(blockers(gate(c)).includes("MISSING_REQUIRED_TEST_COMMAND"));
  } finally { cleanup(c); }
});

test("blocked when implementation changes after the last test run (retest-after-fix)", () => {
  const c = context();
  try {
    assert.ok(blockers(gate(c, { retest: { implementation: false, review: true } })).includes("RETEST_AFTER_IMPLEMENTATION_REQUIRED"));
    assert.ok(blockers(gate(c, { retest: { implementation: true, review: false } })).includes("RETEST_AFTER_REVIEW_REQUIRED"));
    fs.writeFileSync(path.join(c.project, "source.txt"), "changed\n");
    assert.ok(blockers(gate(c)).includes("RETEST_AFTER_IMPLEMENTATION_REQUIRED"));
  } finally { cleanup(c); }
});

test("blocked on unresolved actionable review and on dismissal lacking a GPT decision", () => {
  const unresolved = context({ review: reviewSummary({ unresolvedBlockers: 1, mergeBlocked: true }), items: reviewItems([{ source: "CodeRabbit", externalId: "cr-open", body: "Fix", actionable: true, status: "unresolved", firstSeenAt: timestamp, lastSeenAt: timestamp }]) });
  try { assert.ok(blockers(gate(unresolved)).includes("UNRESOLVED_ACTIONABLE_REVIEW")); } finally { cleanup(unresolved); }
  const badDismiss = context({ items: reviewItems([{ source: "GPT", externalId: "d1", body: "Skip", actionable: false, status: "dismissed", firstSeenAt: timestamp, lastSeenAt: timestamp }]) });
  try { assert.ok(blockers(gate(badDismiss)).includes("DISMISSED_REVIEW_MISSING_GPT_DECISION")); } finally { cleanup(badDismiss); }
});

test("disabled/unavailable external review tools (Qodo paused) do not block by themselves", () => {
  const c = context();
  try {
    const result = gate(c);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.evidence.review.unavailableSources, ["Qodo"]);
  } finally { cleanup(c); }
});

test("blocked without explicit GPT approval and when the approval head SHA no longer matches", () => {
  const c = context();
  try {
    assert.ok(blockers(gate(c, { approval: null })).includes("MISSING_GPT_APPROVAL"));
    assert.ok(blockers(gate(c, { approval: { ...mergeInput().approval, headCommit: "different-sha" } })).includes("GPT_APPROVAL_SCOPE_MISMATCH"));
    assert.ok(blockers(gate(c, { approval: { ...mergeInput().approval, stale: true } })).includes("STALE_GPT_APPROVAL"));
  } finally { cleanup(c); }
});

test("blocked on dirty tree, wrong branch, and missing/unmergeable PR metadata", () => {
  const c = context();
  try {
    assert.ok(blockers(gate(c, { dirty: true })).includes("DIRTY_WORKTREE"));
    assert.ok(blockers(gate(c, { currentBranch: "other" })).includes("WRONG_BRANCH"));
    assert.ok(blockers(gate(c, { pr: null })).includes("MISSING_PR_METADATA"));
    assert.ok(blockers(gate(c, { pr: { ...mergeInput().pr, mergeable: false } })).includes("PR_UNMERGEABLE"));
  } finally { cleanup(c); }
});

test("merge-check requires --project", () => {
  const c = context();
  try { assert.throws(() => run(["merge-check", "--config", c.config]), (error) => code(error, "INVALID_ARGUMENT")); } finally { cleanup(c); }
});

test("missing local merge evidence file fails safely with a typed error (no silent pass)", () => {
  const c = context();
  try {
    fs.rmSync(path.join(c.project, "merge-inbox", "mocked.json"));
    assert.throws(() => mergeCheck(c), (error) => code(error, "MERGE_FIXTURE_READ_FAILED"));
  } finally { cleanup(c); }
});

test("merge-check writes only inside the project; no root STATE.json or BUILD_LOG.md and PLAN.md unchanged", () => {
  const c = context();
  const rootStateBefore = fs.existsSync(path.resolve("STATE.json"));
  const rootLogBefore = fs.existsSync(path.resolve("BUILD_LOG.md"));
  const planBefore = fs.readFileSync(path.resolve("PLAN.md"), "utf8");
  try {
    mergeCheck(c);
    assert.equal(fs.existsSync(path.resolve("STATE.json")), rootStateBefore);
    assert.equal(fs.existsSync(path.resolve("BUILD_LOG.md")), rootLogBefore);
    assert.equal(fs.readFileSync(path.resolve("PLAN.md"), "utf8"), planBefore);
    assert.ok(fs.existsSync(path.join(c.project, "out", "merge_reports", "phase-8-pr-8.json")));
  } finally { cleanup(c); }
});
