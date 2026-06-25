import { spawnSync } from "node:child_process";
import { redactPreflightText } from "./agent-adapters.js";
import { fail } from "./errors.js";

const DISCOVERY_TIMEOUT_MS = 5_000;
const OUTPUT_SUMMARY_LIMIT = 240;
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const CODEX_EXECUTABLE = "codex";
const DISCOVERY_COMMANDS = Object.freeze([
  Object.freeze({ name: "version", argv: Object.freeze(["--version"]) }),
  Object.freeze({ name: "help", argv: Object.freeze(["--help"]) })
]);
const ALLOWED_REQUEST_KEYS = new Set(["env", "spawn", "now", "timeoutMs"]);

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6E_PASS",
  NOT_INSTALLED: "STEP_6E_BLOCKED_CODEX_NOT_INSTALLED",
  NOT_AUTHENTICATED: "STEP_6E_BLOCKED_CODEX_NOT_AUTHENTICATED",
  PROMPT_CONTRACT_UNKNOWN: "STEP_6E_BLOCKED_PROMPT_CONTRACT_UNKNOWN",
  INTERACTIVE_ONLY: "STEP_6E_BLOCKED_UNSAFE_OR_INTERACTIVE_ONLY",
  DISCOVERY_FAILED: "STEP_6E_BLOCKED_DISCOVERY_COMMAND_FAILED"
});

const NON_INTERACTIVE_PROMPT_PATTERNS = [
  /(^|\s)(--prompt|--input|--input-file|--prompt-file)\b/iu,
  /(^|\s)(exec|run)\b[^\n]{0,120}\b(non-interactive|--prompt|--input|prompt[- ]file)/iu,
  /reads? prompt from stdin/iu,
  /accepts? a prompt argument/iu
];
const SAFE_MODE_PATTERNS = [
  /\b(read-only|readonly)\b/iu,
  /\b(no-write|nowrite)\b/iu,
  /\b(no-approval|noapproval)\b/iu,
  /\b(dry-run|dryrun)\b/iu,
  /--auto-approval\s+never\b/iu,
  /sandbox(?:[\s:=])+(?:read-only|workspace-read-only|read_only|workspace_read_only)/iu
];
const INTERACTIVE_ONLY_PATTERNS = [
  /interactive\s+mode\s+only/iu,
  /requires?\s+a\s+terminal/iu,
  /tty\s+required/iu,
  /interactive\s+login\s+required/iu
];
const AUTH_REQUIRED_PATTERNS = [
  /please\s+(?:sign\s+in|log\s+in|login)/iu,
  /not\s+authenticated/iu,
  /authentication\s+required/iu,
  /run\s+`?codex\s+login`?/iu
];

function defaultSpawn(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false });
}

function discoveryEnvironment(env) {
  return { ...SAFE_ENVIRONMENT, PATH: env.PATH ?? env.Path ?? env.path ?? "" };
}

function summarize(text) {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed === "") return "";
  return trimmed.length > OUTPUT_SUMMARY_LIMIT ? `${trimmed.slice(0, OUTPUT_SUMMARY_LIMIT)}...` : trimmed;
}

function runOne(spawn, env, timeoutMs, command, now) {
  const startedAt = now();
  let result;
  let spawnError = null;
  try {
    result = spawn(CODEX_EXECUTABLE, [...command.argv], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      env: discoveryEnvironment(env)
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
  const captured = errorCode !== "ENOENT" && errorCode !== "EACCES" && !timedOut && exitCode === 0;
  return Object.freeze({
    name: command.name,
    executable: CODEX_EXECUTABLE,
    argv: command.argv,
    shell: false,
    stdout,
    stderr,
    summary: summarize(`${stdout}${stderr}`),
    exitCode,
    timedOut,
    errorCode,
    startedAt,
    finishedAt,
    captured
  });
}

export function detectHelpEvidence(helpText) {
  const text = typeof helpText === "string" ? helpText : "";
  const nonInteractivePromptDocumented = NON_INTERACTIVE_PROMPT_PATTERNS.some((rx) => rx.test(text));
  const safeModeDocumented = SAFE_MODE_PATTERNS.some((rx) => rx.test(text));
  const interactiveOnly = INTERACTIVE_ONLY_PATTERNS.some((rx) => rx.test(text));
  const authenticationProblemDocumented = AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(text));
  return Object.freeze({
    nonInteractivePromptDocumented,
    safeModeDocumented,
    interactiveOnly,
    authenticationProblemDocumented
  });
}

function classify({ versionResult, helpResult, evidence }) {
  if ((versionResult.errorCode === "ENOENT" || versionResult.errorCode === "EACCES") &&
      (helpResult.errorCode === "ENOENT" || helpResult.errorCode === "EACCES")) {
    return CLASSIFICATIONS.NOT_INSTALLED;
  }
  if (!versionResult.captured && !helpResult.captured) {
    return CLASSIFICATIONS.DISCOVERY_FAILED;
  }
  if (!helpResult.captured) {
    return CLASSIFICATIONS.DISCOVERY_FAILED;
  }
  if (evidence.interactiveOnly && !evidence.nonInteractivePromptDocumented) {
    return CLASSIFICATIONS.INTERACTIVE_ONLY;
  }
  if (!evidence.nonInteractivePromptDocumented) {
    return CLASSIFICATIONS.PROMPT_CONTRACT_UNKNOWN;
  }
  if (!evidence.safeModeDocumented) {
    return CLASSIFICATIONS.INTERACTIVE_ONLY;
  }
  if (evidence.authenticationProblemDocumented) {
    return CLASSIFICATIONS.NOT_AUTHENTICATED;
  }
  return CLASSIFICATIONS.PASS;
}

function manualActionFor(classification) {
  switch (classification) {
    case CLASSIFICATIONS.NOT_INSTALLED:
      return "Install the Codex CLI and ensure the `codex` executable resolves on PATH before retrying Step 6E.";
    case CLASSIFICATIONS.NOT_AUTHENTICATED:
      return "Authenticate the Codex CLI (e.g. `codex login`) using your normal interactive flow, then retry Step 6E.";
    case CLASSIFICATIONS.PROMPT_CONTRACT_UNKNOWN:
      return "Manually inspect `codex --help` for a documented non-interactive prompt-passing flag and update the discovery patterns before Step 6F.";
    case CLASSIFICATIONS.INTERACTIVE_ONLY:
      return "Codex CLI help does not document a safe non-interactive read-only / no-approval mode; do not advance Step 6F until one is available.";
    case CLASSIFICATIONS.DISCOVERY_FAILED:
      return "Codex CLI returned a discovery error; inspect the captured stderr and resolve before retrying Step 6E.";
    case CLASSIFICATIONS.PASS:
      return null;
    default:
      return "Unknown classification; investigate Step 6E discovery output before proceeding.";
  }
}

function assertRequestShape(request) {
  if (request !== undefined && (request === null || Array.isArray(request) || typeof request !== "object")) {
    fail("Discovery request must be an object when supplied.", "INVALID_DISCOVERY_REQUEST");
  }
  for (const key of Object.keys(request ?? {})) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Discovery request contains an unsupported field: ${key}.`, "INVALID_DISCOVERY_REQUEST");
    }
  }
}

/** Discover whether the local Codex CLI is installed and exposes a documented safe non-interactive prompt contract. */
export function runCodexDiscovery(request = {}) {
  assertRequestShape(request);
  const env = request.env ?? process.env;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const now = typeof request.now === "function" ? request.now : () => new Date().toISOString();
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : DISCOVERY_TIMEOUT_MS;

  const startedAt = now();
  const versionResult = runOne(spawn, env, timeoutMs, DISCOVERY_COMMANDS[0], now);
  const helpResult = runOne(spawn, env, timeoutMs, DISCOVERY_COMMANDS[1], now);
  const evidence = detectHelpEvidence(`${helpResult.stdout}\n${helpResult.stderr}`);
  const classification = classify({ versionResult, helpResult, evidence });
  const finishedAt = now();

  const codexOnPath = versionResult.errorCode !== "ENOENT" && versionResult.errorCode !== "EACCES";
  const versionText = versionResult.captured ? versionResult.summary : null;

  return Object.freeze({
    classification,
    codexOnPath,
    codexVersion: versionText,
    nonInteractivePromptDocumented: evidence.nonInteractivePromptDocumented,
    safeModeDocumented: evidence.safeModeDocumented,
    interactiveOnly: evidence.interactiveOnly,
    authenticationProblemDocumented: evidence.authenticationProblemDocumented,
    authenticationSafelyKnowable: false,
    step6fSafeToDesign: classification === CLASSIFICATIONS.PASS,
    manualAction: manualActionFor(classification),
    discoveryCommands: Object.freeze([versionResult, helpResult]),
    startedAt,
    finishedAt,
    evidence
  });
}
