import { fail } from "./errors.js";
import { commitTask, hasPendingChanges } from "./git-workflow.js";
import { executeGithubMerge, fetchGithubMergeEvidence, openGithubPr, saveApproval } from "./github-workflow.js";
import { requestMergeApproval } from "./merge-approval.js";
import { validateProjectDirectory } from "./project.js";
import { recordDeclaredTests, verifyTestEvidence } from "./test-gate.js";

export const MANUAL_MERGE_MODE = "Manual-merge Mode";
export const AUTO_MERGE_MODE = "Auto-merge Mode";
export const MERGE_PIPELINE = Object.freeze(["pr-open", "merge-approve", "merge-execute"]);

const DEFAULT_DEPS = Object.freeze({
  validateProjectDirectory,
  hasPendingChanges,
  commitTask,
  recordDeclaredTests,
  openGithubPr,
  fetchGithubMergeEvidence,
  verifyTestEvidence,
  requestMergeApproval,
  saveApproval,
  executeGithubMerge
});

async function runAutoMergePipeline({ config, project, loop, deps = DEFAULT_DEPS }) {
  if (loop.status !== "task-complete") {
    return Object.freeze({
      merged: false,
      stage: "skipped",
      reason: `Auto-merge Mode requires task-complete; got ${loop.status}.`
    });
  }

  const validated = deps.validateProjectDirectory(config.allowedRoot, project.path);
  // The loop leaves Codex's edits uncommitted: commit them (normal commit on the
  // current task branch), then run the declared tests and record fresh evidence
  // so the merge gate verifies conductor-run results, never agent claims.
  if (deps.hasPendingChanges(validated.path)) {
    deps.commitTask(validated.path, `Hephaestus: ${validated.state.currentTask}`);
  }
  deps.recordDeclaredTests(validated.path);
  const pr = deps.openGithubPr({
    projectPath: validated.path,
    state: validated.state,
    title: `Hephaestus: ${validated.state.currentTask}`
  });
  const withPr = deps.validateProjectDirectory(config.allowedRoot, project.path);
  const evidence = deps.fetchGithubMergeEvidence({
    projectPath: withPr.path,
    state: withPr.state,
    projectId: project.id
  });
  const testEvidence = deps.verifyTestEvidence(withPr.path);
  if (testEvidence.status !== "passed") {
    fail(`Auto-merge Mode stopped: test evidence status is ${testEvidence.status}.`, "AUTO_MERGE_TESTS_NOT_PASSED");
  }
  const approval = await deps.requestMergeApproval({
    apiKey: process.env.OPENAI_API_KEY,
    model: config.brain?.model,
    evidence,
    testStatus: testEvidence.status
  });
  if (approval.approved !== true) {
    return Object.freeze({
      merged: false,
      stage: "merge-approve",
      approved: false,
      rationale: approval.rationale,
      pr: evidence.pr.number,
      headCommit: evidence.pr.headCommit
    });
  }
  const approvalPath = deps.saveApproval(withPr.path, approval);
  const withApproval = deps.validateProjectDirectory(config.allowedRoot, project.path);
  const merge = deps.executeGithubMerge({
    projectPath: withApproval.path,
    state: withApproval.state,
    projectId: project.id,
    approval
  });
  return Object.freeze({
    merged: merge.merged,
    stage: "merge-execute",
    pr: evidence.pr.number,
    prStatus: pr.status,
    approvalPath,
    mergeCommit: merge.mergeCommit ?? null,
    blockers: merge.blockers
  });
}

export async function finishRunLive({ mode = MANUAL_MERGE_MODE, config, project, loop, deps = DEFAULT_DEPS }) {
  if (mode === MANUAL_MERGE_MODE) {
    return Object.freeze({ mode, autoMerge: false, mergePipeline: MERGE_PIPELINE, loop });
  }
  if (mode !== AUTO_MERGE_MODE) fail(`Unknown merge mode: ${mode}.`, "INVALID_ARGUMENT");
  return Object.freeze({
    mode,
    autoMerge: true,
    mergePipeline: MERGE_PIPELINE,
    loop,
    merge: await runAutoMergePipeline({ config, project, loop, deps })
  });
}
