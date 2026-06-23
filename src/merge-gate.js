import fs from "node:fs";
import path from "node:path";
import { fail, HephaestusError } from "./errors.js";
import { normalizeReviewItem } from "./review.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { saveState, validateState } from "./state.js";
import { verifyTestEvidence } from "./test-gate.js";

const REPORT_DIRECTORY = path.join("out", "merge_reports");

function blocker(code, source, message, requiredAction) {
  return Object.freeze({ code, severity: "blocker", source, message, requiredAction });
}

function add(blockers, code, source, message, requiredAction) {
  blockers.push(blocker(code, source, message, requiredAction));
}

function text(value) { return typeof value === "string" && value.trim() !== ""; }
function same(a, b) { return String(a) === String(b); }

function reviewItems(projectPath) {
  const file = path.join(projectPath, "out", "review_reports", "review-items.json");
  if (!fs.existsSync(file)) return { status: "missing", items: [] };
  try {
    assertRealPathWithinRoot(projectPath, file);
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!report || Array.isArray(report) || !Array.isArray(report.items)) return { status: "invalid", items: [] };
    return { status: "ok", items: report.items.map((item) => normalizeReviewItem(item, { timestamp: item.lastSeenAt })) };
  } catch (error) {
    return { status: error?.code === "MISSING_GPT_DISMISSAL_DECISION" ? "dismissal-invalid" : "invalid", items: [] };
  }
}

function inspectTests(projectPath, blockers) {
  try {
    const result = verifyTestEvidence(projectPath);
    if (result.status === "passed") return result;
    const code = result.reason === "post-fix-retest-required" ? "RETEST_AFTER_IMPLEMENTATION_REQUIRED" : result.reason === "required-command-missing" ? "MISSING_REQUIRED_TEST_COMMAND" : result.reason === "required-output-missing" ? "MISSING_TEST_OUTPUT" : "FAILED_TESTS";
    add(blockers, code, "tests", `Test evidence is blocked: ${result.reason}.`, "Run every required test command and save structured evidence.");
    return result;
  } catch (error) {
    const code = error?.code === "MISSING_TEST_EVIDENCE" ? "MISSING_TEST_EVIDENCE" : error?.code === "MALFORMED_TEST_EVIDENCE" ? "MALFORMED_TEST_EVIDENCE" : "TEST_EVIDENCE_UNCLEAR";
    add(blockers, code, "tests", "Structured test evidence cannot be verified.", "Record valid command, exit-code, and output evidence.");
    return { status: "blocked", reason: code };
  }
}

function inspectReview(projectPath, state, blockers) {
  if (!state.review || state.review.ingestionStatus !== "succeeded") {
    add(blockers, "REVIEW_STATUS_UNCLEAR", "reviews", "Review ingestion has not completed successfully.", "Ingest active review sources and resolve any fetch failure.");
    return;
  }
  const report = reviewItems(projectPath);
  if (report.status === "dismissal-invalid") add(blockers, "DISMISSED_REVIEW_MISSING_GPT_DECISION", "reviews", "A dismissed review item lacks required GPT decision metadata.", "Record a GPT dismissal reason and timestamp.");
  else if (report.status !== "ok") add(blockers, "REVIEW_STATUS_UNCLEAR", "reviews", "Review item evidence is missing or malformed.", "Re-ingest review evidence before merge.");
  else if (report.items.some((item) => item.blocksMerge)) add(blockers, "UNRESOLVED_ACTIONABLE_REVIEW", "reviews", "Required actionable review comments remain unresolved.", "Resolve or explicitly dismiss every actionable review item.");
  if (state.review.mergeBlocked || state.review.unresolvedBlockers > 0) add(blockers, "UNRESOLVED_ACTIONABLE_REVIEW", "reviews", "Review summary still blocks merging.", "Resolve actionable review comments and re-ingest them.");
}

function inspectApproval(approval, input, blockers, now) {
  if (!approval || approval.approved !== true) return add(blockers, "MISSING_GPT_APPROVAL", "approval", "Explicit GPT merge approval is required.", "Record a scoped GPT approval.");
  if (!text(approval.approvedBy) || approval.approvedBy.toLowerCase() !== "gpt") add(blockers, "INVALID_GPT_APPROVAL", "approval", "Approval is not attributed to GPT.", "Record explicit GPT approval.");
  if (approval.stale === true || !text(approval.decidedAt) || Number.isNaN(Date.parse(approval.decidedAt)) || Date.parse(approval.decidedAt) > Date.parse(now)) add(blockers, "STALE_GPT_APPROVAL", "approval", "GPT approval is stale or has an invalid decision timestamp.", "Obtain a current GPT approval.");
  if (!same(approval.project, input.project) || !same(approval.phase, input.phase) || !same(approval.pr, input.pr?.number) || approval.headCommit !== input.pr?.headCommit || approval.branch !== input.pr?.headBranch) add(blockers, "GPT_APPROVAL_SCOPE_MISMATCH", "approval", "GPT approval does not match the project, phase, PR, branch, and head commit.", "Obtain scoped approval for the current immutable head.");
}

function inspectMetadata(input, state, blockers) {
  if (!input.pr || !Number.isSafeInteger(input.pr.number) || !text(input.pr.url) || !text(input.pr.headBranch) || !text(input.pr.baseBranch) || !text(input.pr.headCommit)) add(blockers, "MISSING_PR_METADATA", "git", "PR metadata is incomplete.", "Provide complete PR metadata from a trusted source.");
  else {
    if (input.pr.status !== "OPEN") add(blockers, input.pr.status ? "PR_NOT_OPEN" : "PR_STATUS_UNCLEAR", "git", "PR is not open or has an unclear status.", "Refresh PR state before merge.");
    if (input.pr.mergeable !== true) add(blockers, input.pr.mergeable === false ? "PR_UNMERGEABLE" : "PR_MERGEABILITY_UNCLEAR", "git", "PR is not confirmed mergeable.", "Resolve conflicts and refresh mergeability.");
  }
  if (input.dirty !== false) add(blockers, "DIRTY_WORKTREE", "git", "Merge readiness requires a clean working tree.", "Clean or commit intended changes before rechecking.");
  if (!text(input.currentBranch) || !input.pr || input.currentBranch !== input.pr.headBranch) add(blockers, "WRONG_BRANCH", "git", "Current branch does not match the PR head branch.", "Switch to the reviewed PR head branch.");
  if (String(state.currentPhase) !== String(input.phase)) add(blockers, "PHASE_MISMATCH", "state", "State phase does not match merge request phase.", "Use state and PR metadata for the same phase.");
  if (input.nextPhaseRequested === true && !state.mergeGate?.mergeResult) add(blockers, "NEXT_PHASE_BEFORE_MERGE_RECORDED", "state", "A next phase cannot start before merge result recording.", "Record the approved merge result first.");
}

/** Evaluate local structured evidence only; this function never invokes Git or GitHub. */
export function evaluateMergeReadiness({ projectPath, state, input, now = "2026-01-01T00:00:00.000Z" }) {
  const blockers = [];
  let validated;
  try { validated = validateState(state); } catch (error) { add(blockers, "INVALID_STATE", "state", "STATE.json is missing or invalid.", "Repair state through schema validation."); }
  const required = input && typeof input === "object" ? input : {};
  if (!validated) return Object.freeze({ allowed: false, phase: required.phase ?? null, project: required.project ?? null, pr: required.pr ?? null, approval: required.approval ?? null, blockers: Object.freeze(blockers), warnings: Object.freeze([]), evidence: Object.freeze({}) });
  inspectMetadata(required, validated, blockers);
  const tests = inspectTests(projectPath, blockers);
  if (required.retest?.implementation !== true) add(blockers, "RETEST_AFTER_IMPLEMENTATION_REQUIRED", "tests", "Implementation changes have not been explicitly retested.", "Record successful implementation retest evidence.");
  if (required.retest?.review !== true) add(blockers, "RETEST_AFTER_REVIEW_REQUIRED", "reviews", "Review fixes have not been explicitly retested.", "Record successful retest after review changes.");
  inspectReview(projectPath, validated, blockers);
  inspectApproval(required.approval, required, blockers, now);
  const result = { allowed: blockers.length === 0, phase: required.phase ?? null, project: required.project ?? null, pr: required.pr ?? null, approval: required.approval ?? null, blockers: Object.freeze(blockers), warnings: Object.freeze([]), evidence: Object.freeze({ tests, review: validated.review ?? null, retest: required.retest ?? null }) };
  return Object.freeze(result);
}

function mergeReportPath(projectPath, report) {
  const directory = path.join(projectPath, REPORT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  assertRealPathWithinRoot(projectPath, directory);
  const name = `phase-${report.phase}-pr-${report.pr?.number ?? "unknown"}.json`;
  return path.join(directory, name);
}

export function saveMergeReadinessReport(projectPath, report) {
  const destination = mergeReportPath(projectPath, report);
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return destination;
}

/** Return a human/executor relay instruction; this boundary has no merge side effect. */
export function createMergeRelay(report) {
  if (!report?.allowed) fail("Merge relay requires an allowed readiness result.", "MERGE_NOT_READY");
  return Object.freeze({ kind: "merge-relay", executable: false, pr: report.pr.number, headCommit: report.pr.headCommit, branch: report.pr.headBranch, instruction: "An approved executor may perform a normal PR merge after rechecking this exact head." });
}

export function recordMergeResult({ projectPath, state, report, mergeCommit, actor, mergedAt }) {
  if (!report?.allowed) fail("Merge result requires an allowed readiness report.", "MERGE_NOT_READY");
  if (![mergeCommit, actor, mergedAt].every(text) || Number.isNaN(Date.parse(mergedAt))) fail("Merge result metadata is invalid.", "INVALID_MERGE_RESULT");
  const gateReportPath = saveMergeReadinessReport(projectPath, report);
  const result = { project: report.project, phase: String(report.phase), pr: String(report.pr.number), headCommit: report.pr.headCommit, mergeCommit, actor, mergedAt, gateReportPath: path.relative(projectPath, gateReportPath) };
  const next = { ...validateState(state), blocked: false, mergeStatus: "merged", lastSuccessfulStep: "merge-recorded", nextAction: "next-phase-eligible", mergeGate: { readiness: "merged", implementationRetested: true, reviewRetested: true, nextPhaseEligible: true, mergeResult: result } };
  const saved = saveState(projectPath, next);
  fs.appendFileSync(path.join(projectPath, "BUILD_LOG.md"), `\n[phase-8-merge] pr=${result.pr} head=${result.headCommit} merge=${mergeCommit} actor=${actor} at=${mergedAt}\n`, "utf8");
  return Object.freeze({ state: saved, result: Object.freeze(result), reportPath: gateReportPath });
}
