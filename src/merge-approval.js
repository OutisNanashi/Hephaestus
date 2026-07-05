import { fail } from "./errors.js";
import { requestOpenAIStructured } from "./openai-provider.js";

const APPROVAL_JSON_SUFFIX = "\n\nRespond with ONLY one valid JSON object with exactly these keys: approved (boolean), rationale (string). No markdown, no code fences, no commentary.";

// The model only answers approve/reject with a reason. The conductor pins the
// approval scope (project, phase, PR, branch, head commit) to the exact evidence
// that was shown, so a confused model can never approve a different head.
function validateApprovalVerdict(raw) {
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") fail("Merge approval verdict must be a JSON object.", "INVALID_MERGE_APPROVAL");
  const keys = Object.keys(raw);
  if (!keys.includes("approved") || !keys.includes("rationale") || keys.some((key) => !["approved", "rationale"].includes(key))) {
    fail("Merge approval verdict must contain exactly approved and rationale.", "INVALID_MERGE_APPROVAL");
  }
  if (typeof raw.approved !== "boolean") fail("Merge approval approved must be a boolean.", "INVALID_MERGE_APPROVAL");
  if (typeof raw.rationale !== "string" || raw.rationale.trim() === "") fail("Merge approval rationale must be a non-empty string.", "INVALID_MERGE_APPROVAL");
  return Object.freeze({ approved: raw.approved, rationale: raw.rationale });
}

function approvalInput(evidence, testStatus) {
  return `You are the merge-approval authority for an automated build system. Approve the merge only when everything below is consistent and safe: required tests passed, the PR is open and mergeable, the working tree is clean, and nothing suggests unfinished or unsafe work. When in doubt, reject with a clear reason. Return only JSON with approved and rationale.

Project: ${evidence.project}
Phase: ${evidence.phase}
PR #${evidence.pr.number}: ${evidence.pr.url}
PR status: ${evidence.pr.status}, mergeable: ${evidence.pr.mergeable}
Head branch: ${evidence.pr.headBranch} -> base: ${evidence.pr.baseBranch}
Head commit: ${evidence.pr.headCommit}
Working tree dirty: ${evidence.dirty}
Structured test evidence status: ${testStatus}
Implementation retested after last change: ${evidence.retest.implementation}`;
}

/**
 * Ask GPT for a merge verdict on real evidence. Returns the full scoped approval
 * object when approved, or the rejection verdict when not; never merges anything.
 */
export async function requestMergeApproval({ apiKey, model, evidence, testStatus, fetchImpl, now = () => new Date().toISOString() }) {
  if (!evidence || typeof evidence !== "object" || !evidence.pr) fail("Merge approval requires merge evidence with PR metadata.", "INVALID_MERGE_APPROVAL_REQUEST");
  const verdict = await requestOpenAIStructured({
    apiKey,
    model,
    input: approvalInput(evidence, testStatus),
    validate: validateApprovalVerdict,
    strictSuffix: APPROVAL_JSON_SUFFIX,
    failureCode: "INVALID_MERGE_APPROVAL",
    fetchImpl
  });
  if (verdict.approved !== true) {
    return Object.freeze({ approved: false, rationale: verdict.rationale });
  }
  return Object.freeze({
    approved: true,
    approvedBy: "GPT",
    rationale: verdict.rationale,
    project: evidence.project,
    phase: evidence.phase,
    pr: evidence.pr.number,
    branch: evidence.pr.headBranch,
    headCommit: evidence.pr.headCommit,
    decidedAt: now(),
    stale: false
  });
}
