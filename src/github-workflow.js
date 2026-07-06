import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { git, recordGitMetadata } from "./git-workflow.js";
import { evaluateMergeReadiness, recordMergeResult } from "./merge-gate.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { verifyTestEvidence } from "./test-gate.js";

const GH_TIMEOUT_MS = 60_000;
const APPROVAL_RELATIVE_PATH = path.join("merge-inbox", "approval.json");

function defaultSpawn(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false });
}

/** Run one gh CLI command inside the project repo; gh brings its own stored auth. */
function runGh(projectPath, args, spawn = defaultSpawn) {
  const result = spawn("gh", args, {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGTERM",
    shell: false,
    cwd: projectPath,
    env: process.env,
    input: ""
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    fail("GitHub CLI command timed out.", "GITHUB_WORKFLOW_TIMED_OUT");
  }
  if (result.error) fail(`GitHub CLI could not start: ${result.error.message}`, "GITHUB_CLI_UNAVAILABLE");
  if (result.status !== 0) fail((result.stderr ?? "").trim() || "GitHub CLI command failed.", "GITHUB_WORKFLOW_FAILED");
  return (result.stdout ?? "").trim();
}

/** Publish the branch with a normal (never force) push through the injectable spawn. */
function runGitPush(projectPath, branch, spawn = defaultSpawn) {
  const result = spawn("git", ["push", "--set-upstream", "origin", branch], {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGTERM",
    shell: false,
    cwd: projectPath,
    env: process.env,
    input: ""
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    fail("Git push timed out.", "GIT_WORKFLOW_TIMED_OUT");
  }
  if (result.error) fail(`Git push could not start: ${result.error.message}`, "GIT_WORKFLOW_FAILED");
  if (result.status !== 0) fail((result.stderr ?? "").trim() || "Git push failed.", "GIT_WORKFLOW_FAILED");
}

function ghJson(projectPath, args, spawn) {
  const output = runGh(projectPath, args, spawn);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`GitHub CLI returned invalid JSON: ${error.message}`, "GITHUB_WORKFLOW_FAILED");
  }
}

function mergeableFlag(value) {
  if (value === "MERGEABLE") return true;
  if (value === "CONFLICTING") return false;
  return null;
}

// GitHub computes mergeability asynchronously: immediately after a PR is
// created or pushed to, `gh pr view` reports UNKNOWN, which the gate and the
// approval brain must treat as not-mergeable. Poll briefly for a real verdict.
const MERGEABILITY_POLL_ATTEMPTS = 5;
const MERGEABILITY_POLL_DELAY_MS = 3_000;

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The conductor constantly rewrites its own state/log/report files inside the
// project, so they are always newer than the last commit. Only non-conductor
// changes count as a dirty tree; real uncommitted code still blocks the merge.
const CONDUCTOR_ARTIFACT_PATHS = Object.freeze([
  "STATE.json", "BUILD_LOG.md", "AGENT_OUTPUT.md", "HUMAN_NEEDED.md", "out/", "merge-inbox/", "logs/"
]);

export function dirtyIgnoringConductorArtifacts(porcelain) {
  return porcelain
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim().replace(/^"|"$/gu, "").replace(/\\/gu, "/"))
    .some((file) => !CONDUCTOR_ARTIFACT_PATHS.some((artifact) => artifact.endsWith("/") ? file.startsWith(artifact) : file === artifact));
}

/** Open the PR for the current branch, or return the existing one; merge stays blocked. */
export function openGithubPr({ projectPath, state, title, body = "", base = "master", spawn = defaultSpawn }) {
  const branch = git(projectPath, ["branch", "--show-current"]);
  if (branch === "") fail("A PR requires a checked-out branch.", "GITHUB_WORKFLOW_FAILED");
  // gh pr create refuses branches that only exist locally, and an existing PR
  // must see the latest commits; publish them first with a normal push.
  runGitPush(projectPath, branch, spawn);
  let existing = null;
  try {
    existing = ghJson(projectPath, ["pr", "view", branch, "--json", "number,url,state"], spawn);
  } catch (error) {
    if (error?.code !== "GITHUB_WORKFLOW_FAILED") throw error;
  }
  let url;
  let status;
  if (existing && existing.state === "OPEN") {
    url = existing.url;
    status = "updated";
  } else {
    if (typeof title !== "string" || title.trim() === "") fail("PR creation requires a title.", "INVALID_ARGUMENT");
    runGh(projectPath, ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base], spawn);
    url = ghJson(projectPath, ["pr", "view", branch, "--json", "url"], spawn).url;
    status = "open";
  }
  const metadata = Object.freeze({ url, status, branch, mergeBlocked: true, forcePushAllowed: false });
  recordGitMetadata(projectPath, state, metadata);
  return metadata;
}

/** Collect real merge evidence from git and GitHub in the exact shape the merge gate expects. */
export function fetchGithubMergeEvidence({ projectPath, state, projectId, spawn = defaultSpawn, now = () => new Date().toISOString(), sleep = defaultSleep }) {
  const currentBranch = git(projectPath, ["branch", "--show-current"]);
  const dirty = dirtyIgnoringConductorArtifacts(git(projectPath, ["status", "--porcelain"]));
  const prViewArgs = ["pr", "view", currentBranch, "--json", "number,url,state,headRefName,baseRefName,mergeable,headRefOid"];
  let pr = ghJson(projectPath, prViewArgs, spawn);
  for (let attempt = 0; mergeableFlag(pr.mergeable) === null && attempt < MERGEABILITY_POLL_ATTEMPTS; attempt += 1) {
    sleep(MERGEABILITY_POLL_DELAY_MS);
    pr = ghJson(projectPath, prViewArgs, spawn);
  }
  let testsPassed = false;
  try {
    testsPassed = verifyTestEvidence(projectPath).status === "passed";
  } catch {
    testsPassed = false;
  }
  return Object.freeze({
    now: now(),
    project: projectId,
    phase: state.currentPhase,
    currentBranch,
    dirty,
    retest: Object.freeze({ implementation: testsPassed }),
    pr: Object.freeze({
      number: pr.number,
      url: pr.url,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      status: pr.state,
      mergeable: mergeableFlag(pr.mergeable),
      headCommit: pr.headRefOid
    })
  });
}

export function approvalPath(projectPath) {
  return path.join(projectPath, APPROVAL_RELATIVE_PATH);
}

export function saveApproval(projectPath, approval) {
  const destination = approvalPath(projectPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertRealPathWithinRoot(projectPath, path.dirname(destination));
  fs.writeFileSync(destination, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  return destination;
}

export function loadApproval(projectPath) {
  const source = approvalPath(projectPath);
  if (!fs.existsSync(source)) return null;
  assertRealPathWithinRoot(projectPath, source);
  try {
    return JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (error) {
    fail(`Stored merge approval is invalid JSON: ${error.message}`, "INVALID_MERGE_APPROVAL");
  }
}

/**
 * Execute one real PR merge, but only when the full merge gate allows it.
 * The gate requires scoped GPT approval, passing test evidence, a clean tree,
 * the right branch, and an open mergeable PR — exactly as in the mocked path.
 */
export function executeGithubMerge({ projectPath, state, projectId, approval, spawn = defaultSpawn, now = () => new Date().toISOString() }) {
  const evidence = fetchGithubMergeEvidence({ projectPath, state, projectId, spawn, now });
  const input = { ...evidence, approval: approval ?? loadApproval(projectPath) };
  const report = evaluateMergeReadiness({ projectPath, state, input, now: input.now });
  if (!report.allowed) {
    return Object.freeze({ merged: false, blockers: report.blockers.map((item) => item.code), report });
  }
  runGh(projectPath, ["pr", "merge", String(report.pr.number), "--merge", "--delete-branch"], spawn);
  const merged = ghJson(projectPath, ["pr", "view", String(report.pr.number), "--json", "mergeCommit,mergedAt"], spawn);
  const mergeCommit = merged.mergeCommit?.oid ?? null;
  if (typeof mergeCommit !== "string" || mergeCommit.trim() === "") {
    fail("GitHub reported the merge but no merge commit could be read; verify the PR manually.", "MERGE_RESULT_UNVERIFIED");
  }
  const recorded = recordMergeResult({
    projectPath,
    state,
    report,
    mergeCommit,
    actor: "conductor-merge-relay",
    mergedAt: merged.mergedAt ?? input.now
  });
  return Object.freeze({ merged: true, mergeCommit, blockers: [], report, recorded });
}
