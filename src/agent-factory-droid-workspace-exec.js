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
// The command contract below is VERIFIED against the official Factory docs
// (https://docs.factory.ai/cli/droid-exec/overview):
//   - subcommand:      `droid exec` (headless, non-interactive)                [verified]
//   - prompt by file:  `-f, --file <path>`                                     [verified]
//   - output format:   `-o, --output-format json` -> {type, subtype, is_error,
//                        duration_ms, num_turns, result, session_id}           [verified]
//   - cwd scoping:     `--cwd <path>`                                          [verified]
//   - autonomy:        `--auto low|medium|high`; `low` permits project-dir file
//                        edits and blocks system mods / installs / git push;
//                        commit is medium, push is high                        [verified]
//   - dangerous flag:  `--skip-permissions-unsafe` (avoid; allows everything)  [verified]
//   - exit codes:      0 success, non-zero failure                            [verified]
// UNVERIFIED (docs do not specify): usage-limit / quota / auth failure message
// text, and whether artifacts appear in structured output. Those remain
// best-effort heuristics and are marked as such; do not treat them as final.
// =============================================================================

const PROVIDER_ID = "factory-droid";
const FACTORY_EXEC_TIMEOUT_MS = 1_200_000; // 20 minutes, matching the Codex default
const OUTPUT_SUMMARY_LIMIT = 240;

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "promptPath",
  "env", "spawn", "explicitFactoryExecutionPermit", "timeoutMs", "now"
]);

// Verified safe invocation: headless JSON exec, prompt delivered by file, scoped to
// the project cwd, at the lowest write-capable autonomy (project-dir edits only; no
// git commit/push, no system changes). `--auto low` keeps the conductor owning git.
export const FACTORY_DROID_EXEC_FLAGS = Object.freeze({
  subcommand: "exec",
  outputFormatFlag: "--output-format",
  outputFormat: "json",
  autonomyFlag: "--auto",
  autonomy: "low",
  cwdFlag: "--cwd",
  promptFileFlag: "-f",
  shell: false,
  mode: "mock-dry-run"
});

// Documented JSON output field names (droid exec --output-format json).
export const FACTORY_DROID_JSON_FIELDS = Object.freeze([
  "type", "subtype", "is_error", "duration_ms", "num_turns", "result", "session_id"
]);

// Autonomy levels that grant git/system power we must never request from automation:
// `high` enables git push and deploys; `--skip-permissions-unsafe` allows everything.
const FORBIDDEN_AUTONOMY = Object.freeze(["medium", "high"]);
const FORBIDDEN_FACTORY_TOKENS = Object.freeze([
  "--skip-permissions-unsafe", "--dangerously-skip-permissions", "--yolo"
]);

export const FACTORY_DROID_CLASSIFICATIONS = Object.freeze({
  COMPLETED: "FACTORY_DROID_EXEC_COMPLETED",
  BLOCKED: "FACTORY_DROID_EXEC_BLOCKED",
  FAILED: "FACTORY_DROID_EXEC_FAILED",
  USAGE_LIMIT: "FACTORY_DROID_EXEC_USAGE_LIMIT",
  PROVIDER_NOT_ENABLED: "FACTORY_DROID_EXEC_PROVIDER_NOT_ENABLED",
  MALFORMED_OUTPUT: "FACTORY_DROID_EXEC_MALFORMED_OUTPUT"
});

// UNVERIFIED heuristics: Factory does not document these message strings.
const USAGE_LIMIT_PATTERNS = [
  /\busage\s+limit\b/iu,
  /purchase\s+more\s+credits/iu,
  /\btry\s+again\s+at\b/iu,
  /\brate\s+limit\b/iu,
  /\btoo\s+many\s+requests\b/iu,
  /\bquota\s+exceeded\b/iu,
  /\bconcurrency\s+limit\b/iu
];
const AUTH_REQUIRED_PATTERNS = [
  /\bFACTORY_API_KEY\b/u,
  /not\s+authenticated/iu,
  /authentication\s+required/iu,
  /\bunauthorized\b/iu,
  /\b401\b/u,
  /invalid\s+api\s+key/iu
];
const BLOCKER_PATTERNS = [
  /(^|\n)\s*BLOCKED:/iu,
  /\bmission\s+blocked\b/iu,
  /\bwaiting\s+for\s+(?:approval|owner|input)\b/iu
];
const RETRY_AFTER_PATTERN = /try\s+again\s+at\s+([^.\n]{1,80})/iu;
// Factory API keys are documented as `fk-...`; redact them in addition to the shared patterns.
const FACTORY_KEY_PATTERN = /\bfk-[A-Za-z0-9._-]{6,}/gu;

export function buildFactoryDroidExecArgv({ promptFilePath, projectPath }) {
  if (typeof promptFilePath !== "string" || promptFilePath.trim() === "") {
    fail("Factory exec requires a prompt file path.", "INVALID_FACTORY_EXEC_ARGV");
  }
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    fail("Factory exec requires a project cwd path.", "INVALID_FACTORY_EXEC_ARGV");
  }
  return Object.freeze([
    FACTORY_DROID_EXEC_FLAGS.subcommand,
    FACTORY_DROID_EXEC_FLAGS.outputFormatFlag, FACTORY_DROID_EXEC_FLAGS.outputFormat,
    FACTORY_DROID_EXEC_FLAGS.autonomyFlag, FACTORY_DROID_EXEC_FLAGS.autonomy,
    FACTORY_DROID_EXEC_FLAGS.cwdFlag, projectPath,
    FACTORY_DROID_EXEC_FLAGS.promptFileFlag, promptFilePath
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
  // Autonomy, if present, must never escalate beyond the write-confined `low` tier.
  const autoIndex = flat.indexOf(FACTORY_DROID_EXEC_FLAGS.autonomyFlag);
  if (autoIndex !== -1 && FORBIDDEN_AUTONOMY.includes(flat[autoIndex + 1])) {
    fail(`Factory exec argv requests an unsafe autonomy level: ${flat[autoIndex + 1]}.`, "INVALID_FACTORY_EXEC_ARGV");
  }
  return argv;
}

// Real Factory auth uses the FACTORY_API_KEY env var (format `fk-...`). It is a secret,
// so — like Codex withholding OPENAI_API_KEY — the mock boundary never forwards it. When
// a real execution path is built, forwarding it will be a deliberate, documented choice.
function safeEnvironment(env) {
  const safe = { LANG: "C.UTF-8", PATH: env.PATH ?? env.Path ?? env.path ?? "" };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (typeof env[key] === "string" && env[key] !== "") safe[key] = env[key];
  }
  return safe;
}

// Shared redaction plus Factory's documented `fk-` API key format.
function redactFactory(text) {
  return redactPreflightText(text).replace(FACTORY_KEY_PATTERN, "[REDACTED]");
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

// Parse the documented JSON result object from stdout. Returns null when stdout is not a
// single JSON object with the expected shape (used to detect malformed output).
function parseExecJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed[0] !== "{") return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.session_id !== "string" || typeof parsed.is_error !== "boolean") return null;
  return parsed;
}

function classify({ spawnError, errorCode, timedOut, exitCode, combined, parsed }) {
  if (spawnError !== null || errorCode === "ENOENT" || errorCode === "EACCES") return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  if (timedOut) return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  if (USAGE_LIMIT_PATTERNS.some((rx) => rx.test(combined))) return FACTORY_DROID_CLASSIFICATIONS.USAGE_LIMIT;
  if (AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(combined))) return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  if (BLOCKER_PATTERNS.some((rx) => rx.test(combined))) return FACTORY_DROID_CLASSIFICATIONS.BLOCKED;
  if (typeof exitCode !== "number" || exitCode !== 0) return FACTORY_DROID_CLASSIFICATIONS.FAILED;
  // Exit 0: require the documented JSON result object. is_error true is still a failure.
  if (parsed === null) return FACTORY_DROID_CLASSIFICATIONS.MALFORMED_OUTPUT;
  if (parsed.is_error === true) return FACTORY_DROID_CLASSIFICATIONS.FAILED;
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
 * safety invariants, constructs the VERIFIED safe command, and — only when an explicit
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

  const plannedArgv = assertFactoryArgvSafety(buildFactoryDroidExecArgv({ promptFilePath: sourcePromptPath, projectPath }));

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

  const stdout = redactFactory(result?.stdout ?? "");
  const stderr = redactFactory(result?.stderr ?? "");
  const combined = `${stdout}${stderr}`;
  const errorCode = spawnError?.code ?? result?.error?.code ?? null;
  const timedOut = result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" || result?.signal === "SIGKILL";
  const exitCode = typeof result?.status === "number" ? result.status : null;
  const parsed = parseExecJson(stdout);

  const classification = classify({ spawnError, errorCode, timedOut, exitCode, combined, parsed });
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
      outputFormat: FACTORY_DROID_EXEC_FLAGS.outputFormat,
      autonomy: FACTORY_DROID_EXEC_FLAGS.autonomy,
      promptDelivery: "file (-f/--file)",
      gitAutonomy: "project-dir edits only (--auto low; no commit/push/merge)",
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH, home locations; no FACTORY_API_KEY)",
      cwd: projectPath,
      timeoutMs
    }),
    promptPath: sourcePromptPath,
    startedAt,
    finishedAt,
    exitCode,
    errorCode,
    timedOut,
    stdout,
    stderr,
    summary: summarize(combined),
    sessionId: parsed?.session_id ?? null,
    result: typeof parsed?.result === "string" ? parsed.result : null,
    isError: parsed?.is_error ?? null,
    usageLimitDetected,
    blockerDetected,
    retryAfter: usageLimitDetected ? extractRetryAfter(combined) : null,
    reportPath: null
  });
}
