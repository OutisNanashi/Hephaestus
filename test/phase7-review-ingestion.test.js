import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { normalizeReviewItem } from "../src/review.js";
import { loadState } from "../src/state.js";

const state = Object.freeze({ currentPhase: "7", currentTask: "review-ingestion", currentBranch: "main", currentPr: "https://fixture.invalid/pr/7", assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "blocked", containerStatus: "healthy", lastGptDecision: null, nextAction: "review-ingest" });

const mockedSource = {
  timestamp: "2026-07-02T09:00:00.000Z",
  sources: [
    { source: "CodeRabbit", comments: [{ externalId: "cr-201", filePath: "src/example.js", line: 12, severity: "high", category: "correctness", body: "Guard the empty-input case.", actionable: true }] },
    { source: "Copilot", comments: [{ externalId: "cp-77", filePath: "src/example.js", line: 30, severity: "low", category: "style", body: "Prefer const here.", actionable: false, status: "dismissed", gptDecision: { dismissed: true, reason: "Style preference, out of scope.", decidedAt: "2026-07-02T09:05:00.000Z" } }] },
    { source: "Qodo", availability: "paused" }
  ]
};

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function context(source = mockedSource) {
  const directory = fs.mkdtempSync(path.join(path.resolve("test"), "tmp-p7-"));
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(path.join(project, "review-inbox"), { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, name), "fixture\n");
  writeJson(path.join(project, "STATE.json"), state);
  writeJson(path.join(project, "review-inbox", "mocked.json"), source);
  writeJson(path.join(directory, "projects.json"), { projects: [{ id: "demo", path: "demo" }] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, project, config };
}

function ingest(c, extraArgs = []) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  let exit;
  try { exit = run(["review-ingest", "--project", "demo", "--config", c.config, "--source", "mocked", ...extraArgs]); }
  finally { process.stdout.write = original; }
  return { exit, output: output ? JSON.parse(output) : null };
}

test("imports mocked review comments and updates REVIEW_NOTES.md", () => {
  const c = context();
  try {
    const { exit, output } = ingest(c);
    assert.equal(exit, 0); // ingestion completed; blocking is recorded in state, not the exit code
    assert.equal(output.status, "completed");
    assert.equal(output.source, "mocked");
    const notes = fs.readFileSync(path.join(c.project, "REVIEW_NOTES.md"), "utf8");
    assert.match(notes, /Imported comments/u);
    assert.match(notes, /CodeRabbit/u);
    assert.match(notes, /cr-201/u);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("unresolved actionable comment sets review-blocking status in STATE.json", () => {
  const c = context();
  try {
    ingest(c);
    const next = loadState(c.project);
    assert.equal(next.review.unresolvedBlockers, 1);
    assert.equal(next.review.mergeBlocked, true);
    assert.equal(next.blocked, true);
    assert.equal(next.mergeStatus, "blocked");
    assert.equal(next.reviewStatus, "blocked");
    assert.equal(next.nextAction, "review-decision-required");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("tracks unresolved, resolved, and dismissed items", () => {
  const source = { timestamp: "2026-07-02T09:00:00.000Z", sources: [
    { source: "CodeRabbit", comments: [
      { externalId: "cr-1", filePath: "a.js", line: 1, body: "Fix this.", actionable: true },
      { externalId: "cr-2", filePath: "b.js", line: 2, body: "Already fixed.", actionable: true, status: "resolved" },
      { externalId: "cr-3", filePath: "c.js", line: 3, body: "Nit.", actionable: false, status: "dismissed", gptDecision: { dismissed: true, reason: "Not needed.", decidedAt: "2026-07-02T09:01:00.000Z" } }
    ] }
  ] };
  const c = context(source);
  try {
    ingest(c);
    const r = loadState(c.project).review;
    assert.equal(r.unresolvedBlockers, 1);
    assert.equal(r.resolvedCount, 1);
    assert.equal(r.dismissedCount, 1);
    const notes = fs.readFileSync(path.join(c.project, "REVIEW_NOTES.md"), "utf8");
    assert.match(notes, /## Unresolved comments/u);
    assert.match(notes, /## Resolved comments/u);
    assert.match(notes, /## Dismissed comments/u);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("re-ingesting the same mocked source is idempotent and deduplicates", () => {
  const c = context();
  try {
    const first = ingest(c);
    const second = ingest(c);
    assert.equal(second.output.duplicateCount, 2); // both id-bearing comments already present
    const report = JSON.parse(fs.readFileSync(path.join(c.project, "out", "review_reports", "review-items.json"), "utf8"));
    assert.equal(report.items.length, 2);
    assert.equal(second.output.review.unresolvedBlockers, first.output.review.unresolvedBlockers);
    assert.equal(second.output.review.dismissedCount, first.output.review.dismissedCount);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dismissing a required actionable comment without a GPT decision is rejected", () => {
  assert.throws(
    () => normalizeReviewItem({ source: "CodeRabbit", body: "Must fix.", status: "dismissed", actionable: true }, { timestamp: "2026-07-02T09:00:00.000Z" }),
    (error) => code(error, "MISSING_GPT_DISMISSAL_DECISION")
  );
});

test("a non-actionable comment can be dismissed with an explicit GPT decision", () => {
  const item = normalizeReviewItem(
    { source: "Copilot", body: "Nit.", status: "dismissed", actionable: false, gptDecision: { dismissed: true, reason: "Out of scope.", decidedAt: "2026-07-02T09:05:00.000Z" } },
    { timestamp: "2026-07-02T09:00:00.000Z" }
  );
  assert.equal(item.gptDecision.dismissed, true);
  assert.equal(item.blocksMerge, false);
});

test("a missing/malformed mocked source becomes a clear domain error, not a silent pass", () => {
  const c = context();
  try {
    fs.rmSync(path.join(c.project, "review-inbox", "mocked.json"));
    assert.throws(() => ingest(c), (error) => code(error, "PATH_RESOLUTION_FAILED"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("a declared provider failure becomes retryable blocked review state", () => {
  const c = context({ providerFailure: true, message: "Mocked review source unavailable", retryable: true });
  try {
    const { exit, output } = ingest(c);
    assert.equal(exit, 1);
    assert.equal(output.status, "failed");
    assert.equal(output.review.ingestionStatus, "failed");
    assert.equal(output.review.mergeBlocked, true);
    assert.equal(loadState(c.project).nextAction, "retry-review-ingestion");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("review-ingest requires --project and rejects unknown --source", () => {
  const c = context();
  try {
    assert.throws(() => run(["review-ingest", "--config", c.config, "--source", "mocked"]), (error) => code(error, "INVALID_ARGUMENT"));
    assert.throws(() => run(["review-ingest", "--project", "demo", "--config", c.config, "--source", "github"]), (error) => code(error, "INVALID_ARGUMENT"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("ingestion writes only inside the project; no root STATE.json or BUILD_LOG.md is created", () => {
  const c = context();
  const rootStateBefore = fs.existsSync(path.resolve("STATE.json"));
  const rootLogBefore = fs.existsSync(path.resolve("BUILD_LOG.md"));
  const planBefore = fs.readFileSync(path.resolve("PLAN.md"), "utf8");
  try {
    ingest(c);
    assert.equal(fs.existsSync(path.resolve("STATE.json")), rootStateBefore);
    assert.equal(fs.existsSync(path.resolve("BUILD_LOG.md")), rootLogBefore);
    assert.equal(fs.readFileSync(path.resolve("PLAN.md"), "utf8"), planBefore);
    assert.ok(fs.existsSync(path.join(c.project, "STATE.json")));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
