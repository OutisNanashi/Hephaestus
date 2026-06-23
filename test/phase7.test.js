import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { ingestReviewFixture, normalizeReviewItem } from "../src/review.js";
import { loadState } from "../src/state.js";

const state = Object.freeze({ currentPhase: "7", currentTask: "review-ingestion", currentBranch: "main", currentPr: "https://fixture.invalid/pr/7", assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "blocked", containerStatus: "healthy", lastGptDecision: null, nextAction: "review-ingest" });
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function context() {
  const directory = fs.mkdtempSync(path.join(path.resolve("test"), "tmp-review-")); const root = path.join(directory, "projects"); const project = path.join(root, "demo"); fs.mkdirSync(project, { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, name), "fixture\n");
  writeJson(path.join(project, "STATE.json"), state); writeJson(path.join(directory, "projects.json"), { projects: [{ id: "demo", path: "demo" }] }); writeJson(path.join(directory, "config.json"), { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, project, config: path.join(directory, "config.json") };
}
function fixture(c, name, value) { const directory = path.join(c.root, "reviews"); fs.mkdirSync(directory, { recursive: true }); writeJson(path.join(directory, name), value); return `reviews/${name}`; }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }
const base = { timestamp: "2026-06-23T10:00:00.000Z", sources: [{ source: "CodeRabbit", comments: [{ externalId: "cr-1", filePath: "src/a.js", line: 4, severity: "high", category: "correctness", body: "Protect the empty array case.", actionable: true }] }, { source: "Qodo", availability: "paused" }] };

test("imports review comments, records Qodo as unavailable, and blocks unresolved actionable work", () => {
  const c = context(); try {
    const result = ingestReviewFixture({ allowedRoot: c.root, projectPath: c.project, fixturePath: fixture(c, "review.json", base), state });
    assert.equal(result.status, "completed"); assert.equal(result.state.review.unresolvedBlockers, 1); assert.equal(result.state.review.mergeBlocked, true); assert.deepEqual(result.state.review.unavailableSources, ["Qodo"]); assert.equal(result.state.blocked, true);
    const notes = fs.readFileSync(path.join(c.project, "REVIEW_NOTES.md"), "utf8"); assert.match(notes, /Imported comments/u); assert.match(notes, /Current review-blocking status/u); assert.match(notes, /CodeRabbit/u);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("duplicate comments preserve one blocker and one original first-seen timestamp", () => {
  const c = context(); try {
    const first = fixture(c, "first.json", base); ingestReviewFixture({ allowedRoot: c.root, projectPath: c.project, fixturePath: first, state });
    const second = fixture(c, "second.json", { ...base, timestamp: "2026-06-23T11:00:00.000Z" }); const rerun = ingestReviewFixture({ allowedRoot: c.root, projectPath: c.project, fixturePath: second, state: loadState(c.project) });
    assert.equal(rerun.duplicateCount, 1); assert.equal(rerun.items.length, 1); assert.equal(rerun.items[0].firstSeenAt, "2026-06-23T10:00:00.000Z"); assert.equal(rerun.items[0].lastSeenAt, "2026-06-23T11:00:00.000Z");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dismissals require explicit GPT metadata and non-actionable dismissals do not block", () => {
  assert.throws(() => normalizeReviewItem({ source: "GPT", body: "Ignore this", status: "dismissed", actionable: false }, { timestamp: "2026-06-23T10:00:00.000Z" }), (error) => code(error, "MISSING_GPT_DISMISSAL_DECISION"));
  const item = normalizeReviewItem({ source: "GPT", body: "Style preference", status: "dismissed", actionable: false, gptDecision: { dismissed: true, reason: "Out of scope for this phase.", decidedAt: "2026-06-23T10:01:00.000Z" } }, { timestamp: "2026-06-23T10:00:00.000Z" });
  assert.equal(item.gptDecision.dismissed, true); assert.equal(item.blocksMerge, false);
});

test("comments without provider ids receive a stable generated id", () => {
  const raw = { source: "Codex", filePath: "src/a.js", lineStart: 3, body: "Check this condition." };
  const first = normalizeReviewItem(raw, { timestamp: "2026-06-23T10:00:00.000Z" });
  const second = normalizeReviewItem(raw, { timestamp: "2026-06-23T11:00:00.000Z" });
  assert.match(first.id, /^review-[a-f0-9]{24}$/u); assert.equal(first.id, second.id); assert.equal(first.gptDecisionRequired, true);
});

test("resolved comments and manual REVIEW_NOTES context are retained", () => {
  const c = context(); try {
    fs.writeFileSync(path.join(c.project, "REVIEW_NOTES.md"), "# Manual context\n\nKeep this text.\n");
    const review = { timestamp: "2026-06-23T10:00:00.000Z", sources: [{ source: "Copilot", comments: [{ externalId: "cp-1", body: "Already fixed.", status: "resolved", actionable: true }] }] };
    const result = ingestReviewFixture({ allowedRoot: c.root, projectPath: c.project, fixturePath: fixture(c, "resolved.json", review), state });
    assert.equal(result.state.review.resolvedCount, 1); assert.equal(result.state.review.mergeBlocked, false); assert.equal(result.state.blocked, false); assert.match(fs.readFileSync(path.join(c.project, "REVIEW_NOTES.md"), "utf8"), /Keep this text/u);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("fixture fetch failures become retryable blocked review state", () => {
  const c = context(); try {
    const result = ingestReviewFixture({ allowedRoot: c.root, projectPath: c.project, fixturePath: fixture(c, "failure.json", { providerFailure: true, message: "CodeRabbit fixture unavailable", retryable: true }), state });
    assert.equal(result.status, "failed"); assert.equal(result.state.review.ingestionStatus, "failed"); assert.equal(result.state.nextAction, "retry-review-ingestion"); assert.equal(result.state.review.mergeBlocked, true);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("review ingest CLI uses only a local fixture", () => {
  const c = context(); try {
    const reviewPath = fixture(c, "cli.json", base); let output = ""; const original = process.stdout.write; process.stdout.write = (chunk) => { output += chunk; return true; };
    try { assert.equal(run(["review", "ingest", "demo", "--config", c.config, "--fixture", reviewPath]), 0); } finally { process.stdout.write = original; }
    assert.equal(JSON.parse(output).review.unresolvedBlockers, 1);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
