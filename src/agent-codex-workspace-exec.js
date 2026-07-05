import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  agentDetails, appendLog, completedState, deliverPrompt, failedState, pausedState,
  readPrompt, safePromptPath, stateForRunning, writeAgentOutput
} from "./agent.js";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { saveState } from "./state.js";

// The work sandbox is Codex's native OS-level sandbox: writes are confined to the
// project workspace (cwd), `codex exec` is inherently non-interactive (no approval
// prompts exist), and the dangerous bypass flags below are rejected outright. On
// Linux (the VPS target) this is enforced by Landlock/seccomp; Docker can be layered later.
// The sandbox flag must come after the exec subcommand — codex ignores it top-level.
export const WORKSPACE_EXEC_FLAGS = Object.freeze({
  sandbox: "workspace-write",
  subcommand: "exec",
  sandboxScope: "exec-subcommand",
  approvalPolicy: "non-interactive-exec",
  shell: false
});

const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--skip-git-repo-check",
  "--search",
  "-c"
]);

const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["danger-full-access"]);

// Files the coding agent must never modify: the owner's plan/reference/task files
// and the conductor-owned state and log. The agent reports; the conductor records.
export const PROTECTED_PROJECT_FILES = Object.freeze([
  "PLAN.md", "BUILDING_REFERENCE.md", "CURRENT_TASK.md", "STATE.json", "BUILD_LOG.md", "TESTS.json", ".env"
]);

const WORKSPACE_EXEC_TIMEOUT_MS = 1_200_000; // real coding tasks: 20 minutes by default
const OUTPUT_SUMMARY_LIMIT = 240;

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "promptPath",
  "env", "spawn", "explicitWorkspaceExecPermit", "timeoutMs", "now"
]);

export const WORKSPACE_CLASSIFICATIONS = Object.freeze({
  PASS: "CODEX_EXEC_PASS",
  NOT_INSTALLED: "CODEX_EXEC_BLOCKED_NOT_INSTALLED",
  NOT_AUTHENTICATED: "CODEX_EXEC_BLOCKED_NOT_AUTHENTICATED",
  USAGE_LIMIT: "CODEX_EXEC_PAUSED_USAGE_LIMIT",
  TIMEOUT: "CODEX_EXEC_BLOCKED_TIMEOUT",
  EXIT_NONZERO: "CODEX_EXEC_BLOCKED_EXIT_NONZERO",
  EMPTY_OUTPUT: "CODEX_EXEC_BLOCKED_EMPTY_OUTPUT",
  AGENT_BLOCKER: "CODEX_EXEC_BLOCKED_AGENT_REPORTED",
  PROTECTED_MUTATION: "CODEX_EXEC_BLOCKED_PROTECTED_FILES_MODIFIED",
  INTERACTIVE: "CODEX_EXEC_BLOCKED_INTERACTIVE",
  GIT_REPO_REQUIRED: "CODEX_EXEC_BLOCKED_GIT_REPO_REQUIRED",
  SANDBOX_DOWNGRADED: "CODEX_EXEC_BLOCKED_SANDBOX_DOWNGRADED"
});

const AUTH_REQUIRED_PATTERNS = [
  /please\s+(?:sign\s+in|log\s+in|login)/iu,
  /not\s+authenticated/iu,
  /authentication\s+required/iu,
  /run\s+`?codex\s+login`?/iu,
  /unauthorized/iu,
  /401\b/u
];

const USAGE_LIMIT_PATTERNS = [
  /you(?:'|`|’)?ve\s+hit\s+your\s+usage\s+limit/iu,
  /\busage\s+limit\b/iu,
  /purchase\s+more\s+credits/iu,
  /codex\/settings\/usage/iu,
  /\btry\s+again\s+at\b/iu,
  /\brate\s+limit\b/iu,
  /\btoo\s+many\s+requests\b/iu,
  /\bquota\s+exceeded\b/iu
];

const INTERACTIVE_PATTERNS = [
  /requires?\s+a\s+terminal/iu,
  /tty\s+required/iu,
  /interactive\s+mode\s+only/iu,
  /interactive\s+login\s+required/iu,
  /press\s+(?:enter|any\s+key)/iu,
  /waiting\s+for\s+approval/iu,
  /approval\s+required/iu
];

const RETRY_AFTER_PATTERN = /try\s+again\s+at\s+([^.\n]{1,80})/iu;

// Codex refuses to work in folders without version control; we keep that safety
// net (never pass --skip-git-repo-check) and surface it as its own blocker.
const GIT_REPO_REQUIRED_PATTERNS = [
  /not\s+inside\s+a\s+trusted\s+directory/iu,
  /--skip-git-repo-check/u
];

// Codex prints a session banner naming the effective sandbox. If we requested
// workspace-write but the session ran read-only (e.g. native Windows without the
// sandbox runtime), the agent could not edit files — that run must never count as done.
const SANDBOX_DOWNGRADED_PATTERNS = [
  /^sandbox:\s*read-only\s*$/imu,
  /read-only\s+sandbox/iu
];

export function buildWorkspaceExecArgv(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    fail("Workspace exec prompt must be non-empty.", "INVALID_WORKSPACE_EXEC_PROMPT");
  }
  return Object.freeze([
    "exec",
    "--sandbox", WORKSPACE_EXEC_FLAGS.sandbox,
    "--color", "never",
    prompt
  ]);
}

export function assertWorkspaceArgvSafety(argv, prompt) {
  const flat = argv.map((entry) => String(entry));
  if (flat[0] !== "exec") fail("Workspace exec argv must start with the exec subcommand.", "INVALID_WORKSPACE_EXEC_ARGV");
  const sandboxIndex = flat.indexOf("--sandbox");
  if (sandboxIndex === -1 || flat[sandboxIndex + 1] !== WORKSPACE_EXEC_FLAGS.sandbox) {
    fail("Workspace exec argv must include `--sandbox workspace-write`.", "INVALID_WORKSPACE_EXEC_ARGV");
  }
  if (sandboxIndex >= flat.length - 1 || sandboxIndex < 1) {
    fail("Workspace exec argv must place --sandbox after the exec subcommand and before the prompt.", "INVALID_WORKSPACE_EXEC_ARGV");
  }
  if (flat[flat.length - 1] !== prompt || flat.lastIndexOf(prompt) !== flat.length - 1) {
    fail("Workspace exec argv must end with the delivered prompt.", "INVALID_WORKSPACE_EXEC_ARGV");
  }
  for (const forbidden of FORBIDDEN_ARGV_TOKENS) {
    if (flat.slice(0, -1).includes(forbidden)) {
      fail(`Workspace exec argv contains a forbidden token: ${forbidden}.`, "INVALID_WORKSPACE_EXEC_ARGV");
    }
  }
  for (const forbiddenSandbox of FORBIDDEN_SANDBOX_VALUES) {
    if (flat.slice(0, -1).includes(forbiddenSandbox)) {
      fail(`Workspace exec argv contains a forbidden sandbox mode: ${forbiddenSandbox}.`, "INVALID_WORKSPACE_EXEC_ARGV");
    }
  }
  return argv;
}

// Windows npm installs codex as a .cmd shim that shell-less spawn cannot resolve
// (and Node refuses .cmd without a shell). Locate the package's JS launcher next to
// the shim and run it with Node directly — a real executable, still no shell.
// The Linux VPS has a real `codex` binary and never takes this branch.
function windowsCodexLauncher(env) {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === "") continue;
    const shim = path.join(directory, "codex.cmd");
    const launcher = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(shim) && fs.existsSync(launcher)) return launcher;
  }
  return null;
}

function defaultSpawn(executable, args, options) {
  const result = spawnSync(executable, args, { ...options, shell: false });
  if (process.platform === "win32" && ["ENOENT", "EINVAL", "EACCES"].includes(result.error?.code)) {
    const launcher = windowsCodexLauncher(options.env ?? {});
    if (launcher !== null) return spawnSync(process.execPath, [launcher, ...args], { ...options, shell: false });
  }
  return result;
}

function hashFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotProtectedFiles(projectPath) {
  const entries = {};
  for (const name of PROTECTED_PROJECT_FILES) {
    entries[name] = hashFile(path.join(projectPath, name));
  }
  return entries;
}

function diffSnapshots(before, after) {
  return Object.keys(before).filter((key) => before[key] !== after[key]).sort();
}

function summarize(text) {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed === "") return "No output captured.";
  return trimmed.length > OUTPUT_SUMMARY_LIMIT ? `${trimmed.slice(0, OUTPUT_SUMMARY_LIMIT)}...` : trimmed;
}

function extractRetryAfter(text) {
  const match = RETRY_AFTER_PATTERN.exec(text);
  if (match === null) return null;
  const trimmed = match[1].trim().replace(/[\s,]+$/u, "");
  return trimmed.length === 0 || trimmed.length > 80 ? null : trimmed;
}

// Codex must locate its login (~/.codex) via the home variables; nothing else is
// passed through — in particular no OPENAI_API_KEY, so the brain key never reaches the agent.
function safeEnvironment(env) {
  const safe = { LANG: "C.UTF-8", PATH: env.PATH ?? env.Path ?? env.path ?? "" };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"]) {
    if (typeof env[key] === "string" && env[key] !== "") safe[key] = env[key];
  }
  return safe;
}

function classify({ spawnError, errorCode, timedOut, exitCode, combined, protectedMutated }) {
  if (spawnError !== null || errorCode === "ENOENT" || errorCode === "EACCES") return WORKSPACE_CLASSIFICATIONS.NOT_INSTALLED;
  if (timedOut) return WORKSPACE_CLASSIFICATIONS.TIMEOUT;
  if (protectedMutated) return WORKSPACE_CLASSIFICATIONS.PROTECTED_MUTATION;
  if (GIT_REPO_REQUIRED_PATTERNS.some((rx) => rx.test(combined))) return WORKSPACE_CLASSIFICATIONS.GIT_REPO_REQUIRED;
  if (AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(combined))) return WORKSPACE_CLASSIFICATIONS.NOT_AUTHENTICATED;
  if (USAGE_LIMIT_PATTERNS.some((rx) => rx.test(combined))) return WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT;
  if (INTERACTIVE_PATTERNS.some((rx) => rx.test(combined))) return WORKSPACE_CLASSIFICATIONS.INTERACTIVE;
  if (SANDBOX_DOWNGRADED_PATTERNS.some((rx) => rx.test(combined))) return WORKSPACE_CLASSIFICATIONS.SANDBOX_DOWNGRADED;
  if (typeof exitCode !== "number" || exitCode !== 0) return WORKSPACE_CLASSIFICATIONS.EXIT_NONZERO;
  if (combined.trim() === "") return WORKSPACE_CLASSIFICATIONS.EMPTY_OUTPUT;
  if (/(^|\n)\s*BLOCKED:/iu.test(combined)) return WORKSPACE_CLASSIFICATIONS.AGENT_BLOCKER;
  return WORKSPACE_CLASSIFICATIONS.PASS;
}

const CLASSIFICATION_OUTCOMES = Object.freeze({
  [WORKSPACE_CLASSIFICATIONS.PASS]: { status: "completed", nextAction: "agent-completed", errorCategory: null },
  [WORKSPACE_CLASSIFICATIONS.NOT_INSTALLED]: { status: "failed", nextAction: "agent-adapter-unavailable", errorCategory: "codex-not-installed" },
  [WORKSPACE_CLASSIFICATIONS.NOT_AUTHENTICATED]: { status: "failed", nextAction: "agent-authentication-required", errorCategory: "codex-not-authenticated" },
  [WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT]: { status: "paused", nextAction: "agent-usage-limit-paused", errorCategory: "usage-limit" },
  [WORKSPACE_CLASSIFICATIONS.TIMEOUT]: { status: "failed", nextAction: "agent-timeout", errorCategory: "timeout" },
  [WORKSPACE_CLASSIFICATIONS.EXIT_NONZERO]: { status: "failed", nextAction: "agent-failed", errorCategory: "nonzero-exit" },
  [WORKSPACE_CLASSIFICATIONS.EMPTY_OUTPUT]: { status: "blocked", nextAction: "agent-output-empty", errorCategory: "empty-output" },
  [WORKSPACE_CLASSIFICATIONS.AGENT_BLOCKER]: { status: "blocked", nextAction: "agent-blocked", errorCategory: "agent-blocker" },
  [WORKSPACE_CLASSIFICATIONS.PROTECTED_MUTATION]: { status: "blocked", nextAction: "agent-protected-files-modified", errorCategory: "protected-mutation" },
  [WORKSPACE_CLASSIFICATIONS.INTERACTIVE]: { status: "failed", nextAction: "agent-interactive-required", errorCategory: "interactive-required" },
  [WORKSPACE_CLASSIFICATIONS.GIT_REPO_REQUIRED]: { status: "blocked", nextAction: "agent-git-repo-required", errorCategory: "git-repo-required" },
  [WORKSPACE_CLASSIFICATIONS.SANDBOX_DOWNGRADED]: { status: "blocked", nextAction: "agent-sandbox-downgraded", errorCategory: "sandbox-downgraded" }
});

export function manualActionForWorkspaceClassification(classification) {
  switch (classification) {
    case WORKSPACE_CLASSIFICATIONS.NOT_INSTALLED:
      return "Install the Codex CLI on this machine and ensure `codex` resolves on PATH.";
    case WORKSPACE_CLASSIFICATIONS.NOT_AUTHENTICATED:
      return "Authenticate the Codex CLI (`codex login`) in an interactive session, then retry.";
    case WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT:
      return "Codex usage limit reached; the project is paused until the limit resets.";
    case WORKSPACE_CLASSIFICATIONS.TIMEOUT:
      return "Codex exceeded the run timeout; inspect the captured output and consider a longer --timeout-ms.";
    case WORKSPACE_CLASSIFICATIONS.PROTECTED_MUTATION:
      return "Codex modified protected project files (plan/state/log); inspect the diff before resuming.";
    case WORKSPACE_CLASSIFICATIONS.INTERACTIVE:
      return "Codex requested interactive approval; non-interactive exec must be reliable before automation continues.";
    case WORKSPACE_CLASSIFICATIONS.GIT_REPO_REQUIRED:
      return "The project folder must be a Git repository (run `git init` and commit) before Codex may edit it.";
    case WORKSPACE_CLASSIFICATIONS.SANDBOX_DOWNGRADED:
      return "Codex ran with a read-only sandbox even though workspace-write was requested; on this platform the writable sandbox is unavailable (run on the Linux VPS, or set up the Codex Windows sandbox runtime).";
    default:
      return null;
  }
}

function saveRunReport(projectPath, runId, report) {
  const directory = path.join(projectPath, "out", "agent_runs");
  fs.mkdirSync(directory, { recursive: true });
  assertRealPathWithinRoot(projectPath, directory);
  const destination = path.join(directory, `${runId}.json`);
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return destination;
}

/**
 * Run one real Codex task with write access confined to the selected project.
 * The prompt must already exist inside the project (saved there by the brain).
 */
export function runCodexWorkspaceExec(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Workspace exec request must be an object.", "INVALID_WORKSPACE_EXEC_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) fail(`Workspace exec request contains an unsupported field: ${key}.`, "INVALID_WORKSPACE_EXEC_REQUEST");
  }
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Workspace exec is only available for the codex adapter; received ${adapterId}.`, "WORKSPACE_EXEC_ADAPTER_NOT_ALLOWED");
  const adapter = requireAdapter(adapterId);
  if (adapter.kind !== "real" || adapter.id !== "codex") fail("Workspace exec requires the real codex adapter.", "WORKSPACE_EXEC_ADAPTER_NOT_ALLOWED");
  if (request.explicitWorkspaceExecPermit !== true) {
    fail("Workspace exec requires explicitWorkspaceExecPermit=true.", "WORKSPACE_EXEC_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) fail("Workspace exec requires allowedRoot.", "INVALID_WORKSPACE_EXEC_REQUEST");
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) fail("Workspace exec requires projectPath.", "INVALID_WORKSPACE_EXEC_REQUEST");
  if (typeof request.promptPath !== "string" || request.promptPath.length === 0) fail("Workspace exec requires promptPath.", "INVALID_WORKSPACE_EXEC_REQUEST");

  const projectState = inspectProject(request.allowedRoot, request.projectPath);
  const sourcePromptPath = safePromptPath({ allowedRoot: request.allowedRoot, projectPath: projectState.projectPath, promptPath: request.promptPath });
  const prompt = readPrompt(sourcePromptPath);
  const deliveredPromptPath = deliverPrompt(projectState.projectPath, prompt);
  const argv = assertWorkspaceArgvSafety(buildWorkspaceExecArgv(prompt), prompt);

  const env = request.env ?? process.env;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const now = typeof request.now === "function" ? request.now : () => new Date().toISOString();
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : WORKSPACE_EXEC_TIMEOUT_MS;

  const execRequest = Object.freeze({
    projectName: request.projectId ?? path.basename(projectState.projectPath),
    projectPath: projectState.projectPath,
    adapterId,
    promptPath: sourcePromptPath,
    deliveredPromptPath,
    runId: `codex-${randomUUID()}`
  });

  const startedAt = now();
  const runningState = stateForRunning(projectState.state, execRequest, startedAt);
  saveState(projectState.projectPath, runningState);

  const snapshotBefore = snapshotProtectedFiles(projectState.projectPath);
  let result;
  let spawnError = null;
  try {
    result = spawn(adapter.expectedExecutable, [...argv], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      env: safeEnvironment(env),
      cwd: projectState.projectPath,
      input: ""
    });
  } catch (error) {
    spawnError = error;
    result = { status: null, stdout: "", stderr: "", error };
  }
  const finishedAt = now();

  const stdout = redactPreflightText(result.stdout ?? "");
  const stderr = redactPreflightText(result.stderr ?? "");
  const combined = `${stdout}${stderr}`;
  const errorCode = spawnError?.code ?? result.error?.code ?? null;
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  const exitCode = typeof result.status === "number" ? result.status : null;

  const snapshotAfter = snapshotProtectedFiles(projectState.projectPath);
  const protectedMutatedFiles = diffSnapshots(snapshotBefore, snapshotAfter);

  const classification = classify({ spawnError, errorCode, timedOut, exitCode, combined, protectedMutated: protectedMutatedFiles.length > 0 });
  const outcome = CLASSIFICATION_OUTCOMES[classification];
  const usageLimitDetected = classification === WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT;
  const blockerDetected = outcome.status === "blocked";
  const outputSummary = summarize(combined);

  const outputResult = Object.freeze({
    status: outcome.status,
    taskId: path.basename(projectState.projectPath),
    runId: execRequest.runId,
    adapterId,
    exitCode,
    usageLimitDetected,
    blockerDetected,
    errorCategory: outcome.errorCategory,
    outputSummary,
    stdout,
    stderr
  });
  const agentOutputPath = writeAgentOutput(projectState.projectPath, outputResult);
  const agent = agentDetails({
    request: execRequest,
    status: outcome.status === "completed" ? "completed" : outcome.status === "paused" ? "paused" : outcome.status,
    exitCode,
    startedAt,
    finishedAt,
    outputPath: agentOutputPath,
    outputSummary,
    usageLimitDetected,
    blockerDetected,
    errorCategory: outcome.errorCategory
  });
  const nextState = outcome.status === "completed"
    ? completedState(runningState, agent)
    : outcome.status === "paused"
      ? pausedState(runningState, agent)
      : failedState(runningState, outcome.nextAction, agent);
  saveState(projectState.projectPath, nextState);

  const report = Object.freeze({
    classification,
    runId: execRequest.runId,
    adapterId,
    mode: "workspace-exec",
    executable: adapter.expectedExecutable,
    invocation: Object.freeze({
      shell: false,
      sandbox: WORKSPACE_EXEC_FLAGS.sandbox,
      approvalPolicy: WORKSPACE_EXEC_FLAGS.approvalPolicy,
      subcommand: WORKSPACE_EXEC_FLAGS.subcommand,
      autoApproval: true,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH, home locations; no API keys)",
      cwd: projectState.projectPath,
      timeoutMs
    }),
    promptPath: path.relative(projectState.projectPath, deliveredPromptPath),
    startedAt,
    finishedAt,
    exitCode,
    errorCode,
    timedOut,
    stdout,
    stderr,
    summary: outputSummary,
    usageLimitDetected,
    retryAfter: usageLimitDetected ? extractRetryAfter(combined) : null,
    protectedMutatedFiles: Object.freeze(protectedMutatedFiles),
    manualAction: manualActionForWorkspaceClassification(classification),
    stateNextAction: nextState.nextAction
  });
  const reportPath = saveRunReport(projectState.projectPath, execRequest.runId, report);
  appendLog(projectState.projectPath, `[codex-exec] timestamp=${finishedAt} runId=${execRequest.runId} classification=${classification} exitCode=${exitCode ?? "null"} prompt=${report.promptPath} output=${path.relative(projectState.projectPath, agentOutputPath)} nextAction=${nextState.nextAction}`);

  return Object.freeze({ ...report, reportPath, agentOutputPath, state: nextState });
}
