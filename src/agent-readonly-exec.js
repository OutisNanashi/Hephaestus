import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

export const READONLY_SMOKE_MARKER = "HEPHAESTUS_CODEX_READONLY_SMOKE_OK";

export const READONLY_SMOKE_PROMPT = [
  "You are a Codex non-interactive read-only smoke probe for the Hephaestus build system.",
  "",
  "Rules:",
  "- Do not modify any files.",
  "- Do not run any shell commands.",
  "- Do not access the network.",
  "- Do not request approvals or human interaction.",
  "",
  `Respond with exactly one line containing only this token: ${READONLY_SMOKE_MARKER}`
].join("\n");

export const READONLY_SMOKE_ARGV = Object.freeze([
  "--sandbox", "read-only",
  "--ask-for-approval", "never",
  "exec",
  READONLY_SMOKE_PROMPT
]);

export const READONLY_SMOKE_FLAGS = Object.freeze({
  sandbox: "read-only",
  askForApproval: "never",
  subcommand: "exec",
  sandboxScope: "top-level",
  askForApprovalScope: "top-level",
  shell: false
});

const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--search",
  "-c"
]);

const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write", "danger-full-access"]);

const READONLY_SMOKE_TIMEOUT_MS = 60_000;
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const OUTPUT_SUMMARY_LIMIT = 240;
const PROJECT_FILES_TO_HASH = Object.freeze(["PLAN.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "BUILDING_REFERENCE.md", "AGENT_OUTPUT.md"]);
const PROJECT_DIRS_TO_HASH = Object.freeze(["src", "test"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "env", "spawn",
  "explicitReadonlySmokePermit", "timeoutMs", "now"
]);

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6F_PASS",
  NOT_INSTALLED: "STEP_6F_BLOCKED_CODEX_NOT_INSTALLED",
  NOT_AUTHENTICATED: "STEP_6F_BLOCKED_CODEX_NOT_AUTHENTICATED",
  USAGE_LIMIT: "STEP_6F_BLOCKED_CODEX_USAGE_LIMIT",
  EXIT_NONZERO: "STEP_6F_BLOCKED_CODEX_EXIT_NONZERO",
  TIMEOUT: "STEP_6F_BLOCKED_CODEX_TIMEOUT",
  MARKER_MISSING: "STEP_6F_BLOCKED_MARKER_MISSING",
  MUTATION_DETECTED: "STEP_6F_BLOCKED_MUTATION_DETECTED",
  UNSAFE_ARGV: "STEP_6F_BLOCKED_UNSAFE_ARGV",
  INTERACTIVE: "STEP_6F_BLOCKED_INTERACTIVE"
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

const RETRY_AFTER_PATTERN = /try\s+again\s+at\s+([^.\n]{1,80})/iu;

const INTERACTIVE_PATTERNS = [
  /requires?\s+a\s+terminal/iu,
  /tty\s+required/iu,
  /interactive\s+mode\s+only/iu,
  /interactive\s+login\s+required/iu,
  /press\s+(?:enter|any\s+key)/iu,
  /waiting\s+for\s+approval/iu,
  /approval\s+required/iu
];

export const CLASSIFICATION_PRIORITY = Object.freeze([
  CLASSIFICATIONS.NOT_INSTALLED,
  CLASSIFICATIONS.TIMEOUT,
  CLASSIFICATIONS.MUTATION_DETECTED,
  CLASSIFICATIONS.NOT_AUTHENTICATED,
  CLASSIFICATIONS.USAGE_LIMIT,
  CLASSIFICATIONS.INTERACTIVE,
  CLASSIFICATIONS.EXIT_NONZERO,
  CLASSIFICATIONS.MARKER_MISSING,
  CLASSIFICATIONS.PASS
]);

function detectUsageLimit(text) {
  return USAGE_LIMIT_PATTERNS.some((rx) => rx.test(text));
}

function extractRetryAfter(text) {
  const match = RETRY_AFTER_PATTERN.exec(text);
  if (match === null) return null;
  const trimmed = match[1].trim().replace(/[\s,]+$/u, "");
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed;
}

function defaultSpawn(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false });
}

function hashFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkProjectFiles(directory) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkProjectFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function snapshotProject(projectPath) {
  const entries = {};
  for (const name of PROJECT_FILES_TO_HASH) {
    entries[name] = hashFile(path.join(projectPath, name));
  }
  for (const directory of PROJECT_DIRS_TO_HASH) {
    const directoryPath = path.join(projectPath, directory);
    if (!fs.existsSync(directoryPath)) continue;
    for (const file of walkProjectFiles(directoryPath)) {
      const rel = path.relative(projectPath, file).split(path.sep).join("/");
      entries[rel] = hashFile(file);
    }
  }
  return entries;
}

function diffSnapshots(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

function summarize(text) {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed === "") return "No output captured.";
  return trimmed.length > OUTPUT_SUMMARY_LIMIT ? `${trimmed.slice(0, OUTPUT_SUMMARY_LIMIT)}...` : trimmed;
}

function assertRequestShape(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Readonly smoke request must be an object.", "INVALID_READONLY_SMOKE_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Readonly smoke request contains an unsupported field: ${key}.`, "INVALID_READONLY_SMOKE_REQUEST");
    }
  }
}

function assertArgvSafety() {
  const flat = READONLY_SMOKE_ARGV.map((entry) => String(entry));
  const execIndex = flat.indexOf("exec");
  if (execIndex === -1) fail("Readonly smoke argv must include the exec subcommand.", "INVALID_READONLY_SMOKE_ARGV");
  const sandboxIndex = flat.indexOf("--sandbox");
  if (sandboxIndex === -1 || flat[sandboxIndex + 1] !== "read-only") {
    fail("Readonly smoke argv must include `--sandbox read-only`.", "INVALID_READONLY_SMOKE_ARGV");
  }
  if (sandboxIndex > execIndex) {
    fail("Readonly smoke argv must place --sandbox before the exec subcommand (top-level option).", "INVALID_READONLY_SMOKE_ARGV");
  }
  const approvalIndex = flat.indexOf("--ask-for-approval");
  if (approvalIndex === -1 || flat[approvalIndex + 1] !== "never") {
    fail("Readonly smoke argv must include `--ask-for-approval never`.", "INVALID_READONLY_SMOKE_ARGV");
  }
  if (approvalIndex > execIndex) {
    fail("Readonly smoke argv must place --ask-for-approval before the exec subcommand (top-level option).", "INVALID_READONLY_SMOKE_ARGV");
  }
  if (execIndex !== flat.length - 2) {
    fail("Readonly smoke argv must end with exec followed by the hardcoded prompt.", "INVALID_READONLY_SMOKE_ARGV");
  }
  if (flat[flat.length - 1] !== READONLY_SMOKE_PROMPT) {
    fail("Readonly smoke argv must terminate with the hardcoded prompt.", "INVALID_READONLY_SMOKE_ARGV");
  }
  for (const forbidden of FORBIDDEN_ARGV_TOKENS) {
    if (flat.includes(forbidden)) {
      fail(`Readonly smoke argv contains a forbidden token: ${forbidden}.`, "INVALID_READONLY_SMOKE_ARGV");
    }
  }
  for (const forbiddenSandbox of FORBIDDEN_SANDBOX_VALUES) {
    if (flat.includes(forbiddenSandbox)) {
      fail(`Readonly smoke argv contains a forbidden sandbox mode: ${forbiddenSandbox}.`, "INVALID_READONLY_SMOKE_ARGV");
    }
  }
}

function classify({ spawnError, errorCode, timedOut, exitCode, stdout, stderr, projectMutated }) {
  const combined = `${stdout}${stderr}`;
  if (spawnError !== null || errorCode === "ENOENT" || errorCode === "EACCES") {
    return CLASSIFICATIONS.NOT_INSTALLED;
  }
  if (timedOut) return CLASSIFICATIONS.TIMEOUT;
  if (projectMutated) return CLASSIFICATIONS.MUTATION_DETECTED;
  if (AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(combined))) {
    return CLASSIFICATIONS.NOT_AUTHENTICATED;
  }
  if (detectUsageLimit(combined)) return CLASSIFICATIONS.USAGE_LIMIT;
  if (INTERACTIVE_PATTERNS.some((rx) => rx.test(combined))) {
    return CLASSIFICATIONS.INTERACTIVE;
  }
  if (typeof exitCode !== "number" || exitCode !== 0) return CLASSIFICATIONS.EXIT_NONZERO;
  if (!combined.includes(READONLY_SMOKE_MARKER)) return CLASSIFICATIONS.MARKER_MISSING;
  return CLASSIFICATIONS.PASS;
}

function manualActionFor(classification) {
  switch (classification) {
    case CLASSIFICATIONS.NOT_INSTALLED:
      return "Install the Codex CLI in the activation environment and ensure `codex` resolves on PATH before retrying Step 6F.";
    case CLASSIFICATIONS.NOT_AUTHENTICATED:
      return "Authenticate the Codex CLI (e.g. `codex login`) using your normal interactive flow, then retry Step 6F.";
    case CLASSIFICATIONS.USAGE_LIMIT:
      return "Codex usage limit reached. Wait until the reported reset time or add Codex credits, then retry Step 6F.";
    case CLASSIFICATIONS.TIMEOUT:
      return "Codex did not respond within the read-only smoke timeout; investigate Codex availability before retrying.";
    case CLASSIFICATIONS.EXIT_NONZERO:
      return "Codex exec exited non-zero in read-only mode; inspect the captured stderr before retrying.";
    case CLASSIFICATIONS.MARKER_MISSING:
      return `Codex exec completed without emitting the expected marker (${READONLY_SMOKE_MARKER}); do not advance Step 6G until the marker is reliably produced.`;
    case CLASSIFICATIONS.MUTATION_DETECTED:
      return "Codex modified protected project files even though --sandbox read-only was requested; do not advance past Step 6F.";
    case CLASSIFICATIONS.INTERACTIVE:
      return "Codex appears to require interactive approval or a TTY in this configuration; do not advance Step 6F until non-interactive exec is reliable.";
    case CLASSIFICATIONS.UNSAFE_ARGV:
      return "Internal safety check rejected the configured Codex argv; this is a programming error.";
    case CLASSIFICATIONS.PASS:
      return null;
    default:
      return "Unknown classification; investigate Step 6F output before proceeding.";
  }
}

/** Run one real Codex read-only `exec` smoke; never sends a project prompt and never permits writes. */
export function runCodexReadonlySmoke(request) {
  assertRequestShape(request);
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Readonly smoke is only available for the codex adapter; received ${adapterId}.`, "READONLY_SMOKE_ADAPTER_NOT_ALLOWED");
  const adapter = requireAdapter(adapterId);
  if (adapter.kind !== "real" || !adapter.preflightSupported || adapter.id !== "codex") {
    fail(`Adapter ${adapterId} cannot run a readonly smoke check.`, "READONLY_SMOKE_ADAPTER_NOT_ALLOWED");
  }
  if (request.explicitReadonlySmokePermit !== true) {
    fail("Readonly smoke requires explicitReadonlySmokePermit=true.", "READONLY_SMOKE_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Readonly smoke requires allowedRoot.", "INVALID_READONLY_SMOKE_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Readonly smoke requires projectPath.", "INVALID_READONLY_SMOKE_REQUEST");
  }

  assertArgvSafety();

  const allowedRoot = path.resolve(request.allowedRoot);
  const projectPath = resolveSafePath(allowedRoot, request.projectPath);
  assertRealPathWithinRoot(allowedRoot, projectPath);

  const env = request.env ?? process.env;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const now = typeof request.now === "function" ? request.now : () => new Date().toISOString();
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : READONLY_SMOKE_TIMEOUT_MS;

  const executable = adapter.expectedExecutable;
  const safeEnvironment = { LANG: SAFE_ENVIRONMENT.LANG, PATH: env.PATH ?? env.Path ?? env.path ?? "" };

  const startedAt = now();
  const snapshotBefore = snapshotProject(projectPath);

  let result;
  let spawnError = null;
  try {
    result = spawn(executable, [...READONLY_SMOKE_ARGV], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      env: safeEnvironment,
      cwd: projectPath,
      input: ""
    });
  } catch (error) {
    spawnError = error;
    result = { status: null, stdout: "", stderr: "", error };
  }
  const finishedAt = now();

  const stdout = redactPreflightText(result.stdout ?? "");
  const stderr = redactPreflightText(result.stderr ?? "");
  const errorCode = spawnError?.code ?? result.error?.code ?? null;
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  const exitCode = typeof result.status === "number" ? result.status : null;

  const snapshotAfter = snapshotProject(projectPath);
  const mutatedFiles = diffSnapshots(snapshotBefore, snapshotAfter);
  const projectMutated = mutatedFiles.length > 0;

  const classification = classify({ spawnError, errorCode, timedOut, exitCode, stdout, stderr, projectMutated });
  const combinedOutput = `${stdout}${stderr}`;
  const markerCaptured = combinedOutput.includes(READONLY_SMOKE_MARKER);
  const usageLimitDetected = classification === CLASSIFICATIONS.USAGE_LIMIT;
  const retryAfter = usageLimitDetected ? extractRetryAfter(combinedOutput) : null;

  const report = Object.freeze({
    classification,
    adapterId: adapter.id,
    mode: "readonly-exec-smoke",
    executable,
    argv: READONLY_SMOKE_ARGV,
    invocation: Object.freeze({
      shell: false,
      sandbox: READONLY_SMOKE_FLAGS.sandbox,
      sandboxScope: READONLY_SMOKE_FLAGS.sandboxScope,
      askForApproval: READONLY_SMOKE_FLAGS.askForApproval,
      askForApprovalScope: READONLY_SMOKE_FLAGS.askForApprovalScope,
      subcommand: READONLY_SMOKE_FLAGS.subcommand,
      autoApproval: false,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    }),
    smokeMarker: READONLY_SMOKE_MARKER,
    smokePrompt: READONLY_SMOKE_PROMPT,
    promptKind: "readonly-smoke",
    startedAt,
    finishedAt,
    timeoutMs,
    stdout,
    stderr,
    summary: summarize(`${stdout}${stderr}`),
    exitCode,
    errorCode,
    timedOut,
    markerCaptured: markerCaptured && classification === CLASSIFICATIONS.PASS,
    markerInOutput: markerCaptured,
    usageLimitDetected,
    retryAfter,
    projectMutated,
    mutatedFiles: Object.freeze(mutatedFiles),
    step6gSafeToDesign: classification === CLASSIFICATIONS.PASS,
    manualAction: manualActionFor(classification)
  });

  return report;
}
