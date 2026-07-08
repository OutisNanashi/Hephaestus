import { randomUUID } from "node:crypto";
import path from "node:path";
import { readPrompt, safePromptPath } from "./agent.js";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { fail } from "./errors.js";
import { getProviderAdapter } from "./provider-adapters.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

// =============================================================================
// Factory Droid execution boundary — MOCK / DRY-RUN ONLY.
//
// This module mirrors the shape of the Codex workspace-exec boundary
// (src/agent-codex-workspace-exec.js) so the Factory lane can be exercised and
// tested BEFORE it is ever wired to the real `droid` CLI. It never spawns a real
// process: execution runs exclusively through an injected `spawn` (the test seam).
// There is deliberately no default/real spawn in this file, so real `droid` can
// never run from here, and it consumes no Factory credits.
//
// The planned command flags below are DESIGN PLACEHOLDERS. They have NOT been
// verified against the real Factory Droid CLI and must be confirmed (and the
// output contract pinned down) before any live execution adapter is built.
// =============================================================================

const PROVIDER_ID = "factory-droid";
const FACTORY_EXEC_TIMEOUT_MS = 1_200_000; // 20 minutes, matching the Codex default
const OUTPUT_SUMMARY_LIMIT = 240;

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "promptPath",
  "artifactPath", "env", "spawn", "explicitFactoryExecutionPermit", "timeoutMs", "now"
]);

// Planned, non-interactive, headless invocation. Prompt is delivered by file path
// (never inline), and the expected mission artifact is written to a project-local path.
export const FACTORY_DROID_EXEC_FLAGS = Object.freeze({
  subcommand: "exec",
  headless: "--headless",
  nonInteractive: "--non-interactive",
  outputFormat: "json",
  shell: false,
  mode: "mock-dry-run"
});

export const DEFAULT_ARTIFACT_PATH = "out/factory/mission.json";

// Flags that would let Factory act autonomously on git / bypass confinement. The
// planned argv is asserted to contain none of these; they must never be introduced.
const FORBIDDEN_FACTORY_TOKENS = Object.freeze([
  "--auto", "--auto-approve", "--yes", "-y", "--push", "--merge", "--commit",
  "--force", "--allow-all", "--no-sandbox", "--sudo", "--dangerously-bypass-approvals"
]);

export const FACTORY_DROID_CLASSIFICATIONS = Object.freeze({
  COMPLETED: "FACTORY_DROID_EXEC_COMPLETED",
  BLOCKED: "FACTORY_DROID_EXEC_BLOCKED",
  FAILED: "FACTORY_DROID_EXEC_FAILED",
  USAGE_LIMIT: "FACTORY_DROID_EXEC_USAGE_LIMIT",
  PROVIDER_NOT_ENABLED: "FACTORY_DROID_EXEC_PROVIDER_NOT_ENABLED",
  MALFORMED_OUTPUT: "FACTORY_DROID_EXEC_MALFORMED_OUTPUT"
});

const USAGE_LIMIT_PATTERNS = [
  /\busage\s+limit\b/iu,
  /purchase\s+more\s+credits/iu,
  /\btry\s+again\s+at\b/iu,
  /\brate\s+limit\b/iu,
  /\btoo\s+many\s+requests\b/iu,
  /\bquota\s+exceeded\b/iu,
  /\bconcurrency\s+limit\b/iu
];

const BLOCKER_PATTERNS = [
  /(^|\n)\s*BLOCKED:/iu,
  /\bmission\s+blocked\b/iu,
  /\bwaiting\s+for\s+(?:approval|owner|input)\b/iu
];

// A completed Factory mission is expected to emit structured output (a session/mission
// id and/or an explicit completion status). Exit 0 without any such marker is treated
// as malformed rather than silently accepted.
const COMPLETION_PATTERNS = [
  /"status"\s*:\s*"(?:completed|complete|success|succeeded)"/iu,
  /\bmission\s+complete(?:d)?\b/iu,
  /(?:session|mission)[_-]?id/iu
];

const RETRY_AFTER_PATTERN = /try\s+again\s+at\s+([^.\n]{1,80})/iu;
const SESSION_ID_PATTERN = /(?:session|mission)[_-]?id["'\s:=]+([A-Za-z0-9._-]{3,})/iu;
const ARTIFACT_PATTERN = /artifact(?:[_-]?path)?["'\s:=]+([^\s"',\]]+)/giu;

export function buildFactoryDroidExecArgv({ promptFilePath, artifactPath }) {
  if (typeof promptFilePath !== "string" || promptFilePath.trim() === "") {
    fail("Factory exec requires a prompt file path.", "INVALID_FACTORY_EXEC_ARGV");
  }
  if (typeof artifactPath !== "string" || artifactPath.trim() === "") {
    fail("Factory exec requires an artifact output path.", "INVALID_FACTORY_EXEC_ARGV");
  }
  return Object.freeze([
    FACTORY_DROID_EXEC_FLAGS.subcommand,
    FACTORY_DROID_EXEC_FLAGS.headless,
    FACTORY_DROID_EXEC_FLAGS.nonInteractive,
    "--output-format", FACTORY_DROID_EXEC_FLAGS.outputFormat,
    "--prompt-file", promptFilePath,
    "--artifact-out", artifactPath
  ]);
}

export function assertFactoryArgvSafety(argv) {
  const flat = argv.map((entry) => String(entry));
  if (flat[0] !== FACTORY_DROID_EXEC_FLAGS.subcommand) {
    fail("Factory exec argv must start with the exec subcommand.", "INVALID_FACTORY_EXEC_ARGV");
  }
  for (const forbidden of FORBIDDEN_FACTORY_TOKENS) {
    if (flat.includes(forbidden)) fail(`Factory exec argv contains a forbidden token: ${forbidden}.`, "INVALID_FACTORY_EXEC_ARGV");
  }
  return argv;
}

// Only login/discovery variables are forwarded; no API keys or tokens ever reach the
// (mock) process, mirroring the Codex safe-environment policy.
function safeEnvironment(env) {
  const safe = { LANG: "C.UTF-8", PATH: env.PATH ?? env.Path ?? env.path ?? "" };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "FACTORY_HOME", "DROID_HOME"]) {
    if (typeof env[key] === "string" && env[key] !== "") safe[key] = env[key];
  }
  return safe;
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

function extractSessionId(text) {
  const match = SESSION_ID_PATTERN.exec(text);
  return match === null ? null : match[1];
}

function extractArtifacts(text) {
  const found = new Set();
  let match;
  ARTIFACT_PATTERN.lastIndex = 0;
  while ((match = ARTIFACT_PATTERN.exec(text)) !== null) found.add(match[1]);
  return Object.freeze([...found]);
}

function classify({ spawnError, errorCode, timedOut, exitCode, combined }) {
  if (spawnError !== null || errorCode === "ENOENT" || errorCode === "EACCES") return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  if (timedOut) return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  if (USAGE_LIMIT_PATTERNS.some((rx) => rx.test(combined))) return FACTORY_DROID_CLASSIFICATIONS.USAGE_LIMIT;
  if (BLOCKER_PATTERNS.some((rx) => rx.test(combined))) return FACTORY_DROID_CLASSIFICATIONS.BLOCKED;
  if (typeof exitCode !== "number" || exitCode !== 0) return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  if (combined.trim() === "" || !COMPLETION_PATTERNS.some((rx) => rx.test(combined))) return FACTORY_DROID_CLASSIFICATIONS.MALFORMED_OUTPUT;
  return FACTORY_DROID_CLASSIFICATIONS.COMPLETED;
}

const CLASSIFICATION_OUTCOMES = Object.freeze({
  [FACTORY_DROID_CLASSIFICATIONS.COMPLETED]: { status: "completed", errorCategory: null },
  [FACTORY_DROID_CLASSIFICATIONS.BLOCKED]: { status: "blocked", errorCategory: "agent-blocker" },
  [FACTORY_DROID_CLASSIFICATIONS.FAILED]: { status: "failed", errorCategory: "execution-failed" },
  [FACTORY_DROID_CLASSIFICATIONS.USAGE_LIMIT]: { status: "paused", errorCategory: "usage-limit" },
  [FACTORY_DROID_CLASSIFICATIONS.PROVIDER_NOT_ENABLED]: { status: "not-enabled", errorCategory: "provider-not-enabled" },
  [FACTORY_DROID_CLASSIFICATIONS.MALFORMED_OUTPUT]: { status: "blocked", errorCategory: "malformed-output" }
});

function notEnabledResult({ reason, detail, plannedArgv = null }) {
  return Object.freeze({
    provider: PROVIDER_ID,
    mode: FACTORY_DROID_EXEC_FLAGS.mode,
    executed: false,
    classification: FACTORY_DROID_CLASSIFICATIONS.PROVIDER_NOT_ENABLED,
    status: "not-enabled",
    reason,
    detail,
    plannedArgv,
    reportPath: null
  });
}

/**
 * Dry-run/mock Factory Droid execution boundary. Validates the request, enforces the
 * safety invariants, constructs the planned safe command, and — only when an explicit
 * permit AND an injected spawn are supplied — runs that injected (fake) spawn and maps
 * its output to a Factory classification. It writes no state and delivers no prompt file;
 * it is a pure, side-effect-free scaffold for testing the boundary before real execution.
 */
export function runFactoryDroidWorkspaceExec(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Factory exec request must be an object.", "INVALID_FACTORY_EXEC_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) fail(`Factory exec request contains an unsupported field: ${key}.`, "INVALID_FACTORY_EXEC_REQUEST");
  }
  const adapterId = request.adapterId ?? PROVIDER_ID;
  if (adapterId !== PROVIDER_ID) fail(`Factory exec is only available for the factory-droid adapter; received ${adapterId}.`, "FACTORY_EXEC_ADAPTER_NOT_ALLOWED");
  const adapter = requireAdapter(adapterId);
  if (adapter.kind !== "real" || adapter.expectedExecutable !== "droid") {
    fail("Factory exec requires the real factory-droid adapter metadata.", "FACTORY_EXEC_ADAPTER_NOT_ALLOWED");
  }
  // Hard safety invariant: this boundary must never be reachable as a live-executable
  // provider. If Factory ever flips to liveExecutable, this scaffold must be replaced.
  const providerAdapter = getProviderAdapter(PROVIDER_ID);
  if (providerAdapter === null || providerAdapter.liveExecutable !== false) {
    fail("Factory exec scaffold requires the provider to remain non-live-executable.", "FACTORY_EXEC_NOT_MOCK_SAFE");
  }

  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) fail("Factory exec requires allowedRoot.", "INVALID_FACTORY_EXEC_REQUEST");
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) fail("Factory exec requires projectPath.", "INVALID_FACTORY_EXEC_REQUEST");
  if (typeof request.promptPath !== "string" || request.promptPath.length === 0) fail("Factory exec requires promptPath.", "INVALID_FACTORY_EXEC_REQUEST");

  // Path safety: the project must resolve inside the allowed root, and the prompt must
  // resolve inside the project without traversal (safePromptPath rejects `..`/escapes).
  const projectPath = assertRealPathWithinRoot(request.allowedRoot, request.projectPath);
  const sourcePromptPath = safePromptPath({ allowedRoot: request.allowedRoot, projectPath, promptPath: request.promptPath });
  const prompt = readPrompt(sourcePromptPath);
  if (typeof prompt !== "string" || prompt.trim() === "") fail("Factory exec prompt must be non-empty.", "INVALID_FACTORY_EXEC_PROMPT");

  const artifactPath = request.artifactPath ?? DEFAULT_ARTIFACT_PATH;
  if (typeof artifactPath !== "string" || artifactPath.length === 0 || path.isAbsolute(artifactPath) || artifactPath.split(/[\\/]+/u).includes("..")) {
    fail("Factory exec artifactPath must be a relative project path without traversal.", "INVALID_FACTORY_EXEC_ARTIFACT_PATH");
  }

  const plannedArgv = assertFactoryArgvSafety(buildFactoryDroidExecArgv({ promptFilePath: sourcePromptPath, artifactPath }));

  // Execution gate: never run anything unless the caller explicitly permits the mock run
  // AND supplies the injected spawn. There is no real-binary fallback, so real `droid`
  // can never run from this module.
  if (request.explicitFactoryExecutionPermit !== true) {
    return notEnabledResult({
      reason: "execution-not-permitted",
      detail: "Factory execution is mock/dry-run only; set explicitFactoryExecutionPermit=true with an injected spawn to exercise the boundary.",
      plannedArgv
    });
  }
  if (typeof request.spawn !== "function") {
    return notEnabledResult({
      reason: "mock-spawn-required",
      detail: "Factory execution has no real runner; an injected spawn (mock) is required. Real `droid` is never invoked.",
      plannedArgv
    });
  }

  const env = request.env ?? {};
  const now = typeof request.now === "function" ? request.now : () => new Date().toISOString();
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : FACTORY_EXEC_TIMEOUT_MS;
  const runId = `factory-${randomUUID()}`;
  const startedAt = now();

  let result;
  let spawnError = null;
  try {
    result = request.spawn(adapter.expectedExecutable, [...plannedArgv], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      env: safeEnvironment(env),
      cwd: projectPath,
      input: ""
    });
  } catch (error) {
    spawnError = error;
    result = { status: null, stdout: "", stderr: "", error };
  }
  const finishedAt = now();

  const stdout = redactPreflightText(result?.stdout ?? "");
  const stderr = redactPreflightText(result?.stderr ?? "");
  const combined = `${stdout}${stderr}`;
  const errorCode = spawnError?.code ?? result?.error?.code ?? null;
  const timedOut = result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" || result?.signal === "SIGKILL";
  const exitCode = typeof result?.status === "number" ? result.status : null;

  const classification = classify({ spawnError, errorCode, timedOut, exitCode, combined });
  const outcome = CLASSIFICATION_OUTCOMES[classification];
  const usageLimitDetected = classification === FACTORY_DROID_CLASSIFICATIONS.USAGE_LIMIT;
  const blockerDetected = outcome.status === "blocked";

  return Object.freeze({
    provider: PROVIDER_ID,
    mode: FACTORY_DROID_EXEC_FLAGS.mode,
    executed: true,
    dryRun: true,
    classification,
    status: outcome.status,
    errorCategory: outcome.errorCategory,
    runId,
    adapterId,
    executable: adapter.expectedExecutable,
    plannedArgv,
    invocation: Object.freeze({
      shell: false,
      headless: true,
      nonInteractive: true,
      dangerousBypass: false,
      autoGit: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH, home locations; no API keys)",
      cwd: projectPath,
      timeoutMs
    }),
    promptPath: sourcePromptPath,
    artifactPath,
    startedAt,
    finishedAt,
    exitCode,
    errorCode,
    timedOut,
    stdout,
    stderr,
    summary: summarize(combined),
    sessionId: extractSessionId(combined),
    artifacts: extractArtifacts(combined),
    usageLimitDetected,
    blockerDetected,
    retryAfter: usageLimitDetected ? extractRetryAfter(combined) : null,
    reportPath: null
  });
}
