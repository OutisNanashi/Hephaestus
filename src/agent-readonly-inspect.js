import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { HephaestusError, fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

export const READONLY_INSPECT_MARKER = "HEPHAESTUS_STEP_6G_READONLY_INSPECTION_OK";

const REPORT_REQUIRED_KEYS = Object.freeze(["project", "readonly", "files_inspected", "summary"]);
const REPORT_ALLOWED_KEYS = new Set([...REPORT_REQUIRED_KEYS]);
const REPORT_KEY_LIMIT = 200;

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;

const INSPECT_TIMEOUT_MS = 120_000;
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const OUTPUT_SUMMARY_LIMIT = 240;
const PROJECT_FILES_TO_HASH = Object.freeze(["PLAN.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "BUILDING_REFERENCE.md", "AGENT_OUTPUT.md"]);
const PROJECT_DIRS_TO_HASH = Object.freeze(["src", "test"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "env", "spawn",
  "explicitReadonlyInspectPermit", "timeoutMs", "now"
]);

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6G_PASS",
  NOT_INSTALLED: "STEP_6G_BLOCKED_CODEX_NOT_INSTALLED",
  AUTH: "STEP_6G_BLOCKED_CODEX_AUTH",
  USAGE_LIMIT: "STEP_6G_BLOCKED_CODEX_USAGE_LIMIT",
  TIMEOUT: "STEP_6G_BLOCKED_CODEX_TIMEOUT",
  CRASH: "STEP_6G_BLOCKED_CODEX_CRASH",
  MARKER_MISSING: "STEP_6G_BLOCKED_MARKER_MISSING",
  MARKER_MALFORMED: "STEP_6G_BLOCKED_MARKER_MALFORMED",
  PROJECT_MUTATED: "STEP_6G_BLOCKED_PROJECT_MUTATED",
  UNSAFE_PROJECT: "STEP_6G_BLOCKED_UNSAFE_PROJECT",
  MISSING_PROJECT: "STEP_6G_BLOCKED_MISSING_PROJECT",
  INTERACTIVE: "STEP_6G_BLOCKED_INTERACTIVE",
  UNSAFE_ARGV: "STEP_6G_BLOCKED_UNSAFE_ARGV"
});

export const CLASSIFICATION_PRIORITY = Object.freeze([
  CLASSIFICATIONS.MISSING_PROJECT,
  CLASSIFICATIONS.UNSAFE_PROJECT,
  CLASSIFICATIONS.NOT_INSTALLED,
  CLASSIFICATIONS.TIMEOUT,
  CLASSIFICATIONS.PROJECT_MUTATED,
  CLASSIFICATIONS.AUTH,
  CLASSIFICATIONS.USAGE_LIMIT,
  CLASSIFICATIONS.INTERACTIVE,
  CLASSIFICATIONS.CRASH,
  CLASSIFICATIONS.MARKER_MISSING,
  CLASSIFICATIONS.MARKER_MALFORMED,
  CLASSIFICATIONS.PASS
]);

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

const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--search",
  "-c"
]);

const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write", "danger-full-access"]);

const PATH_ERROR_CODES = new Set(["OUTSIDE_ALLOWED_ROOT", "INVALID_PATH", "UNSAFE_PATH", "INVALID_PROJECT_PATH", "PATH_RESOLUTION_FAILED"]);

export const INSPECT_FLAGS = Object.freeze({
  sandbox: "read-only",
  sandboxScope: "top-level",
  askForApproval: "never",
  askForApprovalScope: "top-level",
  subcommand: "exec",
  shell: false
});

const INSPECT_PROMPT_TEMPLATE = (projectId) => [
  "You are a Codex non-interactive read-only inspector for the Hephaestus build system.",
  "",
  "Rules:",
  "- Inspect only the fixture project files in the current working directory.",
  "- Do not modify, create, delete, rename, or move any file.",
  "- Do not run any shell commands that would change the workspace.",
  "- Do not access the network.",
  "- Do not request approvals or human interaction.",
  "",
  `Project: ${projectId}`,
  "",
  "Inspect the fixture project and emit a structured report.",
  "Respond with exactly these lines, in this exact order, and nothing else:",
  READONLY_INSPECT_MARKER,
  `project=${projectId}`,
  "readonly=true",
  "files_inspected=<comma-separated fixture file names you actually read, e.g. PLAN.md,STATE.json>",
  "summary=<one short factual sentence describing the fixture>"
].join("\n");

export function buildInspectArgv(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    fail(`Project id must match ${PROJECT_ID_PATTERN}; received ${typeof projectId === "string" ? JSON.stringify(projectId) : typeof projectId}.`, "INVALID_INSPECT_PROJECT_ID");
  }
  return Object.freeze([
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "exec",
    INSPECT_PROMPT_TEMPLATE(projectId)
  ]);
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
    fail("Readonly inspect request must be an object.", "INVALID_READONLY_INSPECT_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Readonly inspect request contains an unsupported field: ${key}.`, "INVALID_READONLY_INSPECT_REQUEST");
    }
  }
}

function assertArgvSafety(argv, prompt) {
  const flat = argv.map((entry) => String(entry));
  const execIndex = flat.indexOf("exec");
  if (execIndex === -1) fail("Readonly inspect argv must include the exec subcommand.", "INVALID_READONLY_INSPECT_ARGV");
  const sandboxIndex = flat.indexOf("--sandbox");
  if (sandboxIndex === -1 || flat[sandboxIndex + 1] !== "read-only") {
    fail("Readonly inspect argv must include `--sandbox read-only`.", "INVALID_READONLY_INSPECT_ARGV");
  }
  if (sandboxIndex > execIndex) {
    fail("Readonly inspect argv must place --sandbox before exec (top-level option).", "INVALID_READONLY_INSPECT_ARGV");
  }
  const approvalIndex = flat.indexOf("--ask-for-approval");
  if (approvalIndex === -1 || flat[approvalIndex + 1] !== "never") {
    fail("Readonly inspect argv must include `--ask-for-approval never`.", "INVALID_READONLY_INSPECT_ARGV");
  }
  if (approvalIndex > execIndex) {
    fail("Readonly inspect argv must place --ask-for-approval before exec (top-level option).", "INVALID_READONLY_INSPECT_ARGV");
  }
  if (execIndex !== flat.length - 2) {
    fail("Readonly inspect argv must end with exec followed by the hardcoded prompt.", "INVALID_READONLY_INSPECT_ARGV");
  }
  if (flat[flat.length - 1] !== prompt) {
    fail("Readonly inspect argv must terminate with the templated inspect prompt.", "INVALID_READONLY_INSPECT_ARGV");
  }
  for (const forbidden of FORBIDDEN_ARGV_TOKENS) {
    if (flat.includes(forbidden)) {
      fail(`Readonly inspect argv contains a forbidden token: ${forbidden}.`, "INVALID_READONLY_INSPECT_ARGV");
    }
  }
  for (const forbiddenSandbox of FORBIDDEN_SANDBOX_VALUES) {
    if (flat.includes(forbiddenSandbox)) {
      fail(`Readonly inspect argv contains a forbidden sandbox mode: ${forbiddenSandbox}.`, "INVALID_READONLY_INSPECT_ARGV");
    }
  }
}

export function parseInspectReport(output, expectedProjectId) {
  if (typeof output !== "string") return { ok: false, reason: "output-not-string", report: null };
  const markerIndex = output.indexOf(READONLY_INSPECT_MARKER);
  if (markerIndex === -1) return { ok: false, reason: "marker-missing", report: null };
  const after = output.slice(markerIndex + READONLY_INSPECT_MARKER.length);
  const lines = after.split(/\r?\n/u);
  const report = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      if (Object.keys(report).length === 0) continue;
      break;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) break;
    const key = line.slice(0, eqIndex).trim().toLowerCase();
    if (!REPORT_ALLOWED_KEYS.has(key)) break;
    const value = line.slice(eqIndex + 1).trim();
    if (value.length === 0 || value.length > REPORT_KEY_LIMIT) {
      return { ok: false, reason: `value-${key}-invalid`, report: null };
    }
    if (Object.hasOwn(report, key)) {
      return { ok: false, reason: `duplicate-${key}`, report: null };
    }
    report[key] = value;
  }
  for (const required of REPORT_REQUIRED_KEYS) {
    if (!Object.hasOwn(report, required)) return { ok: false, reason: `missing-${required}`, report: null };
  }
  if (report.readonly.toLowerCase() !== "true") {
    return { ok: false, reason: "readonly-not-true", report: null };
  }
  if (expectedProjectId !== undefined && report.project !== expectedProjectId) {
    return { ok: false, reason: "project-mismatch", report: null };
  }
  const filesInspected = report.files_inspected.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (filesInspected.length === 0) {
    return { ok: false, reason: "files-inspected-empty", report: null };
  }
  for (const file of filesInspected) {
    if (!/^[A-Za-z0-9_./\-]+$/u.test(file)) return { ok: false, reason: "files-inspected-unsafe", report: null };
    if (file.includes("..")) return { ok: false, reason: "files-inspected-traversal", report: null };
  }
  return {
    ok: true,
    reason: null,
    report: Object.freeze({
      project: report.project,
      readonly: true,
      filesInspected: Object.freeze(filesInspected),
      summary: report.summary
    })
  };
}

function classifyCodex({ spawnError, errorCode, timedOut, exitCode, combined, projectMutated }) {
  if (spawnError !== null || errorCode === "ENOENT" || errorCode === "EACCES") {
    return CLASSIFICATIONS.NOT_INSTALLED;
  }
  if (timedOut) return CLASSIFICATIONS.TIMEOUT;
  if (projectMutated) return CLASSIFICATIONS.PROJECT_MUTATED;
  if (AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(combined))) return CLASSIFICATIONS.AUTH;
  if (USAGE_LIMIT_PATTERNS.some((rx) => rx.test(combined))) return CLASSIFICATIONS.USAGE_LIMIT;
  if (INTERACTIVE_PATTERNS.some((rx) => rx.test(combined))) return CLASSIFICATIONS.INTERACTIVE;
  if (typeof exitCode !== "number" || exitCode !== 0) return CLASSIFICATIONS.CRASH;
  return null;
}

function manualActionFor(classification) {
  switch (classification) {
    case CLASSIFICATIONS.MISSING_PROJECT:
      return "Step 6G could not find the requested project in the registry. Register the project or correct the --project argument.";
    case CLASSIFICATIONS.UNSAFE_PROJECT:
      return "Step 6G rejected the requested project path as unsafe. Provide a project whose path resolves inside the configured allowed root.";
    case CLASSIFICATIONS.NOT_INSTALLED:
      return "Install the Codex CLI in the activation environment and ensure `codex` resolves on PATH before retrying Step 6G.";
    case CLASSIFICATIONS.AUTH:
      return "Authenticate the Codex CLI (e.g. `codex login`) using your normal interactive flow, then retry Step 6G.";
    case CLASSIFICATIONS.USAGE_LIMIT:
      return "Codex usage limit reached. Wait until the reported reset time or add Codex credits, then retry Step 6G.";
    case CLASSIFICATIONS.TIMEOUT:
      return "Codex did not respond within the read-only inspect timeout; investigate Codex availability before retrying.";
    case CLASSIFICATIONS.CRASH:
      return "Codex exec exited non-zero or crashed during the inspect; inspect the captured stderr before retrying.";
    case CLASSIFICATIONS.MARKER_MISSING:
      return `Codex inspect completed without emitting the Step 6G marker (${READONLY_INSPECT_MARKER}); do not advance to Step 6H.`;
    case CLASSIFICATIONS.MARKER_MALFORMED:
      return "Codex emitted the Step 6G marker but the structured report failed validation; do not advance to Step 6H.";
    case CLASSIFICATIONS.PROJECT_MUTATED:
      return "Codex modified the fixture project even though --sandbox read-only was requested; do not advance past Step 6G.";
    case CLASSIFICATIONS.INTERACTIVE:
      return "Codex appears to require interactive approval or a TTY in this configuration; do not advance Step 6G until non-interactive exec is reliable.";
    case CLASSIFICATIONS.UNSAFE_ARGV:
      return "Internal safety check rejected the configured Codex argv; this is a programming error.";
    case CLASSIFICATIONS.PASS:
      return null;
    default:
      return "Unknown Step 6G classification; investigate the captured output before proceeding.";
  }
}

function freezeBlockedReport({ adapter, projectId, allowedRoot, classification, prompt, argv, detail = null, projectPath = null, now }) {
  const timestamp = typeof now === "function" ? now() : new Date().toISOString();
  return Object.freeze({
    classification,
    adapter: adapter?.id ?? "codex",
    mode: "readonly-exec-inspect",
    project: Object.freeze({ id: projectId ?? null, allowedRoot: allowedRoot ?? null, resolvedPath: projectPath }),
    executable: adapter?.expectedExecutable ?? "codex",
    argv: argv ?? null,
    invocation: Object.freeze({
      shell: false,
      sandbox: INSPECT_FLAGS.sandbox,
      sandboxScope: INSPECT_FLAGS.sandboxScope,
      askForApproval: INSPECT_FLAGS.askForApproval,
      askForApprovalScope: INSPECT_FLAGS.askForApprovalScope,
      subcommand: INSPECT_FLAGS.subcommand,
      autoApproval: false,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    }),
    inspectMarker: READONLY_INSPECT_MARKER,
    inspectPrompt: prompt ?? null,
    promptKind: "readonly-inspect",
    startedAt: timestamp,
    finishedAt: timestamp,
    timeoutMs: null,
    stdout: "",
    stderr: "",
    summary: detail ?? "",
    exitCode: null,
    errorCode: null,
    timedOut: false,
    markerCaptured: false,
    markerInOutput: false,
    reportValid: false,
    report: null,
    reportFailureReason: null,
    usageLimitDetected: false,
    projectMutated: false,
    mutatedFiles: Object.freeze([]),
    step6hSafeToDesign: false,
    manualAction: manualActionFor(classification)
  });
}

/** Run one real Codex read-only `exec` inspection against a fixture project; never sends a real implementation prompt and never permits writes. */
export function runCodexReadonlyInspect(request) {
  assertRequestShape(request);
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Readonly inspect is only available for the codex adapter; received ${adapterId}.`, "READONLY_INSPECT_ADAPTER_NOT_ALLOWED");
  const adapter = requireAdapter(adapterId);
  if (adapter.kind !== "real" || !adapter.preflightSupported || adapter.id !== "codex") {
    fail(`Adapter ${adapterId} cannot run a readonly inspect.`, "READONLY_INSPECT_ADAPTER_NOT_ALLOWED");
  }
  if (request.explicitReadonlyInspectPermit !== true) {
    fail("Readonly inspect requires explicitReadonlyInspectPermit=true.", "READONLY_INSPECT_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Readonly inspect requires allowedRoot.", "INVALID_READONLY_INSPECT_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Readonly inspect requires projectPath.", "INVALID_READONLY_INSPECT_REQUEST");
  }
  if (typeof request.projectId !== "string" || !PROJECT_ID_PATTERN.test(request.projectId)) {
    fail("Readonly inspect requires a safe projectId.", "INVALID_READONLY_INSPECT_REQUEST");
  }

  const projectId = request.projectId;
  const allowedRoot = path.resolve(request.allowedRoot);
  const prompt = INSPECT_PROMPT_TEMPLATE(projectId);
  const argv = buildInspectArgv(projectId);
  assertArgvSafety(argv, prompt);

  const now = typeof request.now === "function" ? request.now : () => new Date().toISOString();

  let projectPath;
  try {
    projectPath = resolveSafePath(allowedRoot, request.projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeBlockedReport({
        adapter, projectId, allowedRoot,
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        prompt, argv, detail: error.message, now
      });
    }
    throw error;
  }
  if (!fs.existsSync(projectPath)) {
    return freezeBlockedReport({
      adapter, projectId, allowedRoot,
      classification: CLASSIFICATIONS.MISSING_PROJECT,
      prompt, argv, projectPath, detail: `Project path does not exist: ${projectPath}.`, now
    });
  }
  try {
    assertRealPathWithinRoot(allowedRoot, projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeBlockedReport({
        adapter, projectId, allowedRoot,
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        prompt, argv, projectPath, detail: error.message, now
      });
    }
    throw error;
  }

  const env = request.env ?? process.env;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : INSPECT_TIMEOUT_MS;

  const executable = adapter.expectedExecutable;
  const safeEnvironment = { LANG: SAFE_ENVIRONMENT.LANG, PATH: env.PATH ?? env.Path ?? env.path ?? "" };

  const startedAt = now();
  const snapshotBefore = snapshotProject(projectPath);

  let result;
  let spawnError = null;
  try {
    result = spawn(executable, [...argv], {
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

  const combined = `${stdout}${stderr}`;
  const codexClassification = classifyCodex({ spawnError, errorCode, timedOut, exitCode, combined, projectMutated });

  const markerInOutput = combined.includes(READONLY_INSPECT_MARKER);
  let reportValid = false;
  let parsedReport = null;
  let reportFailureReason = null;
  let classification = codexClassification;

  if (classification === null) {
    if (!markerInOutput) {
      classification = CLASSIFICATIONS.MARKER_MISSING;
    } else {
      const parsed = parseInspectReport(combined, projectId);
      if (parsed.ok) {
        classification = CLASSIFICATIONS.PASS;
        reportValid = true;
        parsedReport = parsed.report;
      } else {
        classification = CLASSIFICATIONS.MARKER_MALFORMED;
        reportFailureReason = parsed.reason;
      }
    }
  }

  const usageLimitDetected = classification === CLASSIFICATIONS.USAGE_LIMIT;

  return Object.freeze({
    classification,
    adapter: adapter.id,
    mode: "readonly-exec-inspect",
    project: Object.freeze({ id: projectId, allowedRoot, resolvedPath: projectPath }),
    executable,
    argv,
    invocation: Object.freeze({
      shell: false,
      sandbox: INSPECT_FLAGS.sandbox,
      sandboxScope: INSPECT_FLAGS.sandboxScope,
      askForApproval: INSPECT_FLAGS.askForApproval,
      askForApprovalScope: INSPECT_FLAGS.askForApprovalScope,
      subcommand: INSPECT_FLAGS.subcommand,
      autoApproval: false,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    }),
    inspectMarker: READONLY_INSPECT_MARKER,
    inspectPrompt: prompt,
    promptKind: "readonly-inspect",
    startedAt,
    finishedAt,
    timeoutMs,
    stdout,
    stderr,
    summary: summarize(combined),
    exitCode,
    errorCode,
    timedOut,
    markerCaptured: classification === CLASSIFICATIONS.PASS,
    markerInOutput,
    reportValid,
    report: parsedReport,
    reportFailureReason,
    usageLimitDetected,
    projectMutated,
    mutatedFiles: Object.freeze(mutatedFiles),
    step6hSafeToDesign: classification === CLASSIFICATIONS.PASS,
    manualAction: manualActionFor(classification)
  });
}
