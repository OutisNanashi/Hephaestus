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

const NETWORK_RETRY_ATTEMPTS = 4;
const NETWORK_RETRY_BASE_MS = 2_000;
const NETWORK_RETRY_CAP_MS = 15_000;

// Transient GitHub/network conditions an unattended run should ride out rather
// than abort on: gateway timeouts, 5xx, "try again", dropped connections, DNS
// blips. Auth, permission, and validation failures deliberately are NOT here —
// those are real and must stop the run.
const TRANSIENT_NETWORK = /\b(50[0234])\b|gateway timeout|bad gateway|service unavailable|temporarily unavailable|timed? ?out|try again|connection reset|connection refused|could not resolve host|network is unreachable|econnreset|etimedout|eai_again|remote end hung up|early eof/iu;

export function isTransientNetworkError(text) {
  return TRANSIENT_NETWORK.test(text ?? "");
}

// Run one external command inside the repo, retrying transient network failures
// with capped exponential backoff. A missing executable or a non-transient
// non-zero exit fails immediately; the last transient failure keeps its code.
function runRepoCommand({ projectPath, executable, args, timeoutCode, failCode, notStartedCode, spawn = defaultSpawn, sleep = defaultSleep, attempts = NETWORK_RETRY_ATTEMPTS }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = spawn(executable, args, {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGTERM",
      shell: false,
      cwd: projectPath,
      env: process.env,
      input: ""
    });
    const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
    if (!timedOut && result.error) fail(`${executable} could not start: ${result.error.message}`, notStartedCode);
    if (!timedOut && result.status === 0) return (result.stdout ?? "").trim();
    const message = timedOut ? `${executable} command timed out.` : ((result.stderr ?? "").trim() || `${executable} command failed.`);
    const transient = timedOut || isTransientNetworkError(message);
    if (!transient || attempt === attempts - 1) fail(message, timedOut ? timeoutCode : failCode);
    sleep(Math.min(NETWORK_RETRY_BASE_MS * (2 ** attempt), NETWORK_RETRY_CAP_MS));
  }
}

/** Run one gh CLI command inside the project repo; gh brings its own stored auth. */
function runGh(projectPath, args, spawn = defaultSpawn, sleep = defaultSleep) {
  return runRepoCommand({ projectPath, executable: "gh", args, timeoutCode: "GITHUB_WORKFLOW_TIMED_OUT", failCode: "GITHUB_WORKFLOW_FAILED", notStartedCode: "GITHUB_CLI_UNAVAILABLE", spawn, sleep });
}

/** Publish the branch with a normal (never force) push through the injectable spawn. */
function runGitPush(projectPath, branch, spawn = defaultSpawn, sleep = defaultSleep) {
  runRepoCommand({ projectPath, executable: "git", args: ["push", "--set-upstream", "origin", branch], timeoutCode: "GIT_WORKFLOW_TIMED_OUT", failCode: "GIT_WORKFLOW_FAILED", notStartedCode: "GIT_WORKFLOW_FAILED", spawn, sleep });
}

function ghJson(projectPath, args, spawn, sleep = defaultSleep) {
  const output = runGh(projectPath, args, spawn, sleep);
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
  // The git() helper trims its output, so the first line may have lost the
  // leading space of its two-column status (" M foo" -> "M foo"); strip the
  // status token by pattern instead of by fixed offset.
  return porcelain
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^\S{1,2}\s+/u, "").trim().replace(/^"|"$/gu, "").replace(/\\/gu, "/"))
    .some((file) => !CONDUCTOR_ARTIFACT_PATHS.some((artifact) => artifact.endsWith("/") ? file.startsWith(artifact) : file === artifact));
}

/** Open the PR for the current branch, or return the existing one; merge stays blocked. */
export function openGithubPr({ projectPath, state, title, body = "", base = "master", spawn = defaultSpawn, sleep = defaultSleep }) {
  const branch = git(projectPath, ["branch", "--show-current"]);
  if (branch === "") fail("A PR requires a checked-out branch.", "GITHUB_WORKFLOW_FAILED");
  // Never push or PR the base branch: a task branch is always required, so a
  // build that landed on base is caught here instead of pushing straight to it.
  if (branch === base) fail(`Refusing to open a PR from the base branch "${base}"; a task branch is required.`, "GITHUB_WORKFLOW_FAILED");
  // gh pr create refuses branches that only exist locally, and an existing PR
  // must see the latest commits; publish them first with a normal push.
  runGitPush(projectPath, branch, spawn, sleep);
  let existing = null;
  try {
    existing = ghJson(projectPath, ["pr", "view", branch, "--json", "number,url,state"], spawn, sleep);
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
    runGh(projectPath, ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base], spawn, sleep);
    url = ghJson(projectPath, ["pr", "view", branch, "--json", "url"], spawn, sleep).url;
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
  // Merge remotely only: gh's --delete-branch also checks out the base branch
  // locally, which fails on conductor-artifact churn and would crash the run
  // AFTER the remote merge succeeded, losing the merge record.
  runGh(projectPath, ["pr", "merge", String(report.pr.number), "--merge"], spawn);
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
  // Best-effort remote branch cleanup after the result is safely recorded;
  // the local checkout is never touched.
  let branchDeleted = false;
  try {
    runGh(projectPath, ["api", "--method", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${report.pr.headBranch}`], spawn);
    branchDeleted = true;
  } catch {
    branchDeleted = false;
  }
  return Object.freeze({ merged: true, mergeCommit, blockers: [], report, recorded, branchDeleted });
}
