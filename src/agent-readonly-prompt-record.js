import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { HephaestusError, fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

export const STEP_6I_MARKER = "HEPHAESTUS_STEP_6I_PROMPT_FILE_HANDOFF_OK";
export const STEP_6I_PROMPT_RELATIVE = "out/prompts/step-6i-readonly-prompt.md";
export const STEP_6I_REPORT_DIRECTORY_RELATIVE = "out/agent_outputs";
export const STEP_6I_AGENT_OUTPUT_RELATIVE = "AGENT_OUTPUT.md";
const STEP_6I_DEFAULT_REPORT_PREFIX = "step-6i-readonly-prompt-record";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;
const REPORT_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9_./\-]+$/u;

const REPORT_REQUIRED_KEYS = Object.freeze(["project", "readonly", "prompt_source", "files_inspected", "summary"]);
const REPORT_ALLOWED_KEYS = new Set([...REPORT_REQUIRED_KEYS]);
const REPORT_KEY_LIMIT = 200;

const STEP_6I_TIMEOUT_MS = 120_000;
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const OUTPUT_SUMMARY_LIMIT = 240;

const PATH_ERROR_CODES = new Set(["OUTSIDE_ALLOWED_ROOT", "INVALID_PATH", "UNSAFE_PATH", "INVALID_PROJECT_PATH", "PATH_RESOLUTION_FAILED"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "env", "spawn",
  "explicitReadonlyPromptRecordPermit", "timeoutMs", "now", "reportName"
]);

const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--search",
  "-c"
]);

const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write", "danger-full-access"]);

export const STEP_6I_FLAGS = Object.freeze({
  sandbox: "read-only",
  sandboxScope: "top-level",
  askForApproval: "never",
  askForApprovalScope: "top-level",
  subcommand: "exec",
  shell: false
});

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6I_PASS",
  NOT_INSTALLED: "STEP_6I_BLOCKED_CODEX_NOT_INSTALLED",
  AUTH: "STEP_6I_BLOCKED_CODEX_AUTH",
  USAGE_LIMIT: "STEP_6I_BLOCKED_CODEX_USAGE_LIMIT",
  TIMEOUT: "STEP_6I_BLOCKED_CODEX_TIMEOUT",
  CRASH: "STEP_6I_BLOCKED_CODEX_CRASH",
  INTERACTIVE: "STEP_6I_BLOCKED_CODEX_INTERACTIVE",
  MARKER_MISSING: "STEP_6I_BLOCKED_MARKER_MISSING",
  MARKER_MALFORMED: "STEP_6I_BLOCKED_MARKER_MALFORMED",
  CODEX_MUTATED_PROJECT: "STEP_6I_BLOCKED_CODEX_MUTATED_PROJECT",
  PROMPT_WRITE_FAILED: "STEP_6I_BLOCKED_PROMPT_WRITE_FAILED",
  PROMPT_READBACK_FAILED: "STEP_6I_BLOCKED_PROMPT_READBACK_FAILED",
  PROMPT_MISMATCH: "STEP_6I_BLOCKED_PROMPT_MISMATCH",
  ARTIFACT_WRITE_FAILED: "STEP_6I_BLOCKED_ARTIFACT_WRITE_FAILED",
  FORBIDDEN_MUTATION: "STEP_6I_BLOCKED_FORBIDDEN_MUTATION",
  UNSAFE_PROJECT: "STEP_6I_BLOCKED_UNSAFE_PROJECT",
  MISSING_PROJECT: "STEP_6I_BLOCKED_MISSING_PROJECT",
  INVALID_REQUEST: "STEP_6I_BLOCKED_INVALID_REQUEST"
});

export const CLASSIFICATION_PRIORITY = Object.freeze([
  CLASSIFICATIONS.INVALID_REQUEST,
  CLASSIFICATIONS.MISSING_PROJECT,
  CLASSIFICATIONS.UNSAFE_PROJECT,
  CLASSIFICATIONS.PROMPT_WRITE_FAILED,
  CLASSIFICATIONS.PROMPT_READBACK_FAILED,
  CLASSIFICATIONS.PROMPT_MISMATCH,
  CLASSIFICATIONS.NOT_INSTALLED,
  CLASSIFICATIONS.TIMEOUT,
  CLASSIFICATIONS.CODEX_MUTATED_PROJECT,
  CLASSIFICATIONS.AUTH,
  CLASSIFICATIONS.USAGE_LIMIT,
  CLASSIFICATIONS.INTERACTIVE,
  CLASSIFICATIONS.CRASH,
  CLASSIFICATIONS.MARKER_MISSING,
  CLASSIFICATIONS.MARKER_MALFORMED,
  CLASSIFICATIONS.ARTIFACT_WRITE_FAILED,
  CLASSIFICATIONS.FORBIDDEN_MUTATION,
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

export function buildStep6iPrompt(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    fail("Step 6I prompt requires a safe projectId.", "INVALID_STEP_6I_PROJECT_ID");
  }
  return [
    "You are a Codex non-interactive read-only inspector for the Hephaestus Step 6I prompt-file handoff probe.",
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
    "Inspect the fixture project and emit a structured Step 6I report.",
    "Respond with exactly these lines, in this exact order, and nothing else:",
    STEP_6I_MARKER,
    `project=${projectId}`,
    "readonly=true",
    `prompt_source=${STEP_6I_PROMPT_RELATIVE}`,
    "files_inspected=<comma-separated fixture file names you actually read, e.g. PLAN.md,STATE.json>",
    "summary=<one short factual sentence describing the fixture>",
    ""
  ].join("\n");
}

export function buildStep6iArgv(promptContent) {
  if (typeof promptContent !== "string" || promptContent.length === 0) {
    fail("Step 6I argv builder requires a non-empty prompt string.", "INVALID_STEP_6I_PROMPT_CONTENT");
  }
  return Object.freeze([
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "exec",
    promptContent
  ]);
}

function assertArgvSafety(argv, expectedPrompt) {
  const flat = argv.map((entry) => String(entry));
  const execIndex = flat.indexOf("exec");
  if (execIndex === -1) fail("Step 6I argv must include the exec subcommand.", "INVALID_STEP_6I_ARGV");
  const sandboxIndex = flat.indexOf("--sandbox");
  if (sandboxIndex === -1 || flat[sandboxIndex + 1] !== "read-only") {
    fail("Step 6I argv must include `--sandbox read-only`.", "INVALID_STEP_6I_ARGV");
  }
  if (sandboxIndex > execIndex) {
    fail("Step 6I argv must place --sandbox before exec.", "INVALID_STEP_6I_ARGV");
  }
  const approvalIndex = flat.indexOf("--ask-for-approval");
  if (approvalIndex === -1 || flat[approvalIndex + 1] !== "never") {
    fail("Step 6I argv must include `--ask-for-approval never`.", "INVALID_STEP_6I_ARGV");
  }
  if (approvalIndex > execIndex) {
    fail("Step 6I argv must place --ask-for-approval before exec.", "INVALID_STEP_6I_ARGV");
  }
  if (execIndex !== flat.length - 2) {
    fail("Step 6I argv must end with exec followed by the read-back prompt.", "INVALID_STEP_6I_ARGV");
  }
  if (flat[flat.length - 1] !== expectedPrompt) {
    fail("Step 6I argv must terminate with the read-back prompt content.", "INVALID_STEP_6I_ARGV");
  }
  for (const forbidden of FORBIDDEN_ARGV_TOKENS) {
    if (flat.includes(forbidden)) fail(`Step 6I argv contains a forbidden token: ${forbidden}.`, "INVALID_STEP_6I_ARGV");
  }
  for (const forbiddenSandbox of FORBIDDEN_SANDBOX_VALUES) {
    if (flat.includes(forbiddenSandbox)) fail(`Step 6I argv contains a forbidden sandbox mode: ${forbiddenSandbox}.`, "INVALID_STEP_6I_ARGV");
  }
}

export function parseStep6iReport(output, { expectedProjectId, expectedPromptSource }) {
  if (typeof output !== "string") return { ok: false, reason: "output-not-string", report: null };
  const markerIndex = output.indexOf(STEP_6I_MARKER);
  if (markerIndex === -1) return { ok: false, reason: "marker-missing", report: null };
  const after = output.slice(markerIndex + STEP_6I_MARKER.length);
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
  if (report.readonly.toLowerCase() !== "true") return { ok: false, reason: "readonly-not-true", report: null };
  if (report.project !== expectedProjectId) return { ok: false, reason: "project-mismatch", report: null };
  if (report.prompt_source !== expectedPromptSource) return { ok: false, reason: "prompt-source-mismatch", report: null };
  const filesInspected = report.files_inspected.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (filesInspected.length === 0) return { ok: false, reason: "files-inspected-empty", report: null };
  for (const file of filesInspected) {
    if (!SAFE_FILENAME_PATTERN.test(file)) return { ok: false, reason: "files-inspected-unsafe", report: null };
    if (file.includes("..")) return { ok: false, reason: "files-inspected-traversal", report: null };
  }
  return {
    ok: true,
    reason: null,
    report: Object.freeze({
      project: report.project,
      readonly: true,
      promptSource: report.prompt_source,
      filesInspected: Object.freeze(filesInspected),
      summary: report.summary
    })
  };
}

function defaultSpawn(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false });
}

function defaultNow() { return new Date().toISOString(); }

function hashFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkAll(projectPath, currentDirectory, accumulator) {
  let entries;
  try { entries = fs.readdirSync(currentDirectory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) walkAll(projectPath, full, accumulator);
    else if (entry.isFile()) {
      const rel = path.relative(projectPath, full).split(path.sep).join("/");
      accumulator[rel] = hashFile(full);
    }
  }
}

function snapshotAllProjectFiles(projectPath) {
  const accumulator = {};
  walkAll(projectPath, projectPath, accumulator);
  return accumulator;
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
    fail("Step 6I request must be an object.", "INVALID_STEP_6I_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Step 6I request contains an unsupported field: ${key}.`, "INVALID_STEP_6I_REQUEST");
    }
  }
}

function safeReportNameFromTimestamp(timestamp) {
  const stamp = String(timestamp).replace(/[:.]/gu, "-").replace(/[^A-Za-z0-9_.\-]/gu, "-");
  return `${STEP_6I_DEFAULT_REPORT_PREFIX}-${stamp.slice(0, 64)}.json`;
}

function bool(value) { return value ? "yes" : "no"; }

function buildAgentOutputMarkdown({ projectId, classification, codexExitCode, codexTimedOut, markerCaptured, reportValid, codexMutatedProject, filesInspected, summary, promptArtifactRelative, promptArtifactHash, promptSourceConfirmed, recordTimestamp, jsonReportRelative }) {
  return [
    "# Hephaestus Step 6I — Read-only Codex prompt-file handoff record",
    "",
    "This artifact records the output of a read-only Codex prompt-file handoff.",
    "It is NOT implementation output. Codex was not allowed to write files and never received a user-supplied prompt.",
    "",
    `- Step: 6I (prompt-file handoff record)`,
    `- Recorded at: ${recordTimestamp}`,
    `- Project: ${projectId}`,
    `- Adapter: codex`,
    `- Step 6I classification: ${classification}`,
    `- Prompt artifact path: ${promptArtifactRelative}`,
    `- Prompt artifact SHA-256: ${promptArtifactHash}`,
    `- Prompt source confirmed: ${bool(promptSourceConfirmed)}`,
    `- Marker captured: ${bool(markerCaptured)}`,
    `- Report valid: ${bool(reportValid)}`,
    `- Codex mutated project during run: ${bool(codexMutatedProject)}`,
    `- Codex exit code: ${codexExitCode === null ? "n/a" : codexExitCode}`,
    `- Codex timed out: ${bool(codexTimedOut)}`,
    `- Files inspected by Codex: ${filesInspected.length === 0 ? "(none)" : filesInspected.join(", ")}`,
    `- Codex summary: ${summary === "" || summary === null ? "(none)" : summary}`,
    `- Companion JSON report: ${jsonReportRelative}`,
    "",
    "## Safety invariants",
    "- shell: false (locked)",
    `- sandbox: ${STEP_6I_FLAGS.sandbox}`,
    `- ask-for-approval: ${STEP_6I_FLAGS.askForApproval}`,
    "- dangerous bypass: no",
    "- stdin policy: closed-empty",
    "- env policy: sandbox-safe (LANG, PATH)",
    "",
    "## Next safe step",
    classification === CLASSIFICATIONS.PASS
      ? "Step 6J may be designed. No implementation prompt was sent to Codex."
      : "Resolve the Step 6I blocker before designing Step 6J.",
    ""
  ].join("\n");
}

function buildJsonReport({ projectId, classification, codexExitCode, codexTimedOut, markerCaptured, reportValid, codexMutatedProject, codexMutatedFiles, forbiddenMutation, forbiddenMutatedFiles, filesInspected, summary, promptArtifactRelative, promptArtifactHash, promptSourceConfirmed, recordTimestamp, jsonReportRelative, agentOutputRelative, stdout, stderr, timeoutMs }) {
  return {
    schema: "hephaestus.step-6i.readonly-prompt-record/v1",
    recordingStep: "6I",
    project: projectId,
    adapter: "codex",
    classification,
    markerCaptured,
    reportValid,
    promptArtifactPath: promptArtifactRelative,
    promptArtifactHash,
    promptSourceConfirmed,
    projectMutatedDuringCodexRun: codexMutatedProject,
    mutatedFilesDuringCodexRun: [...codexMutatedFiles],
    forbiddenMutation,
    forbiddenMutatedFiles: [...forbiddenMutatedFiles],
    filesInspected: [...filesInspected],
    summary,
    invocation: {
      shell: false,
      sandbox: STEP_6I_FLAGS.sandbox,
      askForApproval: STEP_6I_FLAGS.askForApproval,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    },
    stdout,
    stderr,
    exitCode: codexExitCode,
    timeoutMs,
    timedOut: codexTimedOut,
    createdAt: recordTimestamp,
    artifacts: {
      agentOutput: agentOutputRelative,
      jsonReport: jsonReportRelative,
      promptArtifact: promptArtifactRelative
    },
    nextSafeStep: classification === CLASSIFICATIONS.PASS ? "6J (design only)" : null
  };
}

function manualActionFor(classification) {
  switch (classification) {
    case CLASSIFICATIONS.PASS: return null;
    case CLASSIFICATIONS.MISSING_PROJECT: return "Register the requested project or correct --project before retrying Step 6I.";
    case CLASSIFICATIONS.UNSAFE_PROJECT: return "Provide a project whose path resolves inside the configured allowed root.";
    case CLASSIFICATIONS.PROMPT_WRITE_FAILED: return "Hephaestus failed to write the Step 6I prompt artifact; check filesystem permissions and retry.";
    case CLASSIFICATIONS.PROMPT_READBACK_FAILED: return "Hephaestus failed to read the Step 6I prompt artifact back after writing it; check filesystem state and retry.";
    case CLASSIFICATIONS.PROMPT_MISMATCH: return "The read-back Step 6I prompt does not match the controlled template; investigate before retrying.";
    case CLASSIFICATIONS.NOT_INSTALLED: return "Install the Codex CLI in the activation environment and ensure `codex` resolves on PATH.";
    case CLASSIFICATIONS.AUTH: return "Authenticate the Codex CLI (e.g. `codex login`) and retry Step 6I.";
    case CLASSIFICATIONS.USAGE_LIMIT: return "Codex usage limit reached. Wait until the reported reset time or add Codex credits, then retry.";
    case CLASSIFICATIONS.TIMEOUT: return "Codex did not respond within the Step 6I timeout; investigate availability.";
    case CLASSIFICATIONS.INTERACTIVE: return "Codex appears to require interactive approval; do not advance Step 6I until non-interactive exec is reliable.";
    case CLASSIFICATIONS.CRASH: return "Codex exec exited non-zero or crashed during Step 6I; inspect captured stderr.";
    case CLASSIFICATIONS.MARKER_MISSING: return `Codex completed without emitting the Step 6I marker (${STEP_6I_MARKER}); do not advance Step 6J.`;
    case CLASSIFICATIONS.MARKER_MALFORMED: return "Codex emitted the Step 6I marker but the structured report failed validation; do not advance Step 6J.";
    case CLASSIFICATIONS.CODEX_MUTATED_PROJECT: return "Codex modified the fixture project during a read-only run; treat as a serious safety regression.";
    case CLASSIFICATIONS.ARTIFACT_WRITE_FAILED: return "Hephaestus failed to write the Step 6I output artifacts; check filesystem permissions and retry.";
    case CLASSIFICATIONS.FORBIDDEN_MUTATION: return "Step 6I detected unexpected project changes outside the allowed artifact paths; investigate source.";
    case CLASSIFICATIONS.INVALID_REQUEST: return "Step 6I request was rejected before execution; correct the request shape.";
    default: return "Unknown Step 6I classification; investigate before proceeding.";
  }
}

function freezeRecord({ classification, projectId, allowedRoot, projectPath, promptArtifactRelative, promptArtifactHash, promptSourceConfirmed, codexResult, codexMutatedFiles, forbiddenMutation, forbiddenMutatedFiles, parsed, recordTimestamp, agentOutputWritten, jsonReportRelative, agentOutputRelative, artifactsWritten, promptArtifactWritten, codexArgv, timeoutMs }) {
  const filesInspected = parsed?.report?.filesInspected ? [...parsed.report.filesInspected] : [];
  const summary = parsed?.report?.summary ?? null;
  const codexExitCode = codexResult?.exitCode ?? null;
  const codexTimedOut = codexResult?.timedOut ?? false;
  const markerCaptured = codexResult?.markerInOutput && classification === CLASSIFICATIONS.PASS;
  const reportValid = parsed?.ok === true && classification === CLASSIFICATIONS.PASS;
  const codexMutatedProject = (codexMutatedFiles?.length ?? 0) > 0;
  return Object.freeze({
    classification,
    adapter: "codex",
    mode: "readonly-exec-prompt-record",
    project: Object.freeze({ id: projectId ?? null, allowedRoot: allowedRoot ?? null, resolvedPath: projectPath ?? null }),
    step: "6I",
    promptArtifactPath: promptArtifactRelative,
    promptArtifactHash: promptArtifactHash ?? null,
    promptSourceConfirmed: promptSourceConfirmed === true,
    promptArtifactWritten: promptArtifactWritten === true,
    executable: codexResult ? "codex" : null,
    argv: codexArgv ?? null,
    invocation: Object.freeze({
      shell: false,
      sandbox: STEP_6I_FLAGS.sandbox,
      sandboxScope: STEP_6I_FLAGS.sandboxScope,
      askForApproval: STEP_6I_FLAGS.askForApproval,
      askForApprovalScope: STEP_6I_FLAGS.askForApprovalScope,
      subcommand: STEP_6I_FLAGS.subcommand,
      autoApproval: false,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    }),
    inspectMarker: STEP_6I_MARKER,
    stdout: codexResult?.stdout ?? "",
    stderr: codexResult?.stderr ?? "",
    summary: summarize(`${codexResult?.stdout ?? ""}${codexResult?.stderr ?? ""}`),
    exitCode: codexExitCode,
    errorCode: codexResult?.errorCode ?? null,
    timedOut: codexTimedOut,
    timeoutMs: timeoutMs ?? null,
    markerCaptured,
    markerInOutput: codexResult?.markerInOutput ?? false,
    reportValid,
    report: parsed?.report ?? null,
    reportFailureReason: parsed?.reason ?? null,
    codexMutatedProject,
    codexMutatedFiles: Object.freeze([...(codexMutatedFiles ?? [])]),
    forbiddenMutation: forbiddenMutation === true,
    forbiddenMutatedFiles: Object.freeze([...(forbiddenMutatedFiles ?? [])]),
    filesInspected: Object.freeze(filesInspected),
    codexSummary: summary,
    artifactsWritten: artifactsWritten === true,
    artifactPaths: Object.freeze({
      promptArtifact: promptArtifactRelative,
      agentOutput: agentOutputWritten === true ? agentOutputRelative : null,
      jsonReport: agentOutputWritten === true ? jsonReportRelative : null
    }),
    recordedAt: recordTimestamp,
    step6jSafeToDesign: classification === CLASSIFICATIONS.PASS,
    manualAction: manualActionFor(classification)
  });
}

function runCodexSpawn({ spawn, argv, projectPath, env, timeoutMs }) {
  const safeEnvironment = { LANG: SAFE_ENVIRONMENT.LANG, PATH: env.PATH ?? env.Path ?? env.path ?? "" };
  let result;
  let spawnError = null;
  try {
    result = spawn("codex", [...argv], {
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
  const stdout = redactPreflightText(result.stdout ?? "");
  const stderr = redactPreflightText(result.stderr ?? "");
  const errorCode = spawnError?.code ?? result.error?.code ?? null;
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  const exitCode = typeof result.status === "number" ? result.status : null;
  const combined = `${stdout}${stderr}`;
  return Object.freeze({
    spawnError, errorCode, timedOut, exitCode,
    stdout, stderr, combined,
    markerInOutput: combined.includes(STEP_6I_MARKER)
  });
}

function classifyCodex(codexResult) {
  if (codexResult.spawnError !== null || codexResult.errorCode === "ENOENT" || codexResult.errorCode === "EACCES") {
    return CLASSIFICATIONS.NOT_INSTALLED;
  }
  if (codexResult.timedOut) return CLASSIFICATIONS.TIMEOUT;
  if (AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(codexResult.combined))) return CLASSIFICATIONS.AUTH;
  if (USAGE_LIMIT_PATTERNS.some((rx) => rx.test(codexResult.combined))) return CLASSIFICATIONS.USAGE_LIMIT;
  if (INTERACTIVE_PATTERNS.some((rx) => rx.test(codexResult.combined))) return CLASSIFICATIONS.INTERACTIVE;
  if (typeof codexResult.exitCode !== "number" || codexResult.exitCode !== 0) return CLASSIFICATIONS.CRASH;
  return null;
}

/** Run one Step 6I prompt-file handoff: write controlled prompt, read it back, send to Codex read-only, persist controlled output artifacts. */
export function runCodexReadonlyPromptRecord(request) {
  assertRequestShape(request);
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Step 6I prompt-file handoff is only available for the codex adapter; received ${adapterId}.`, "STEP_6I_ADAPTER_NOT_ALLOWED");
  requireAdapter(adapterId);
  if (request.explicitReadonlyPromptRecordPermit !== true) {
    fail("Step 6I requires explicitReadonlyPromptRecordPermit=true.", "STEP_6I_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Step 6I requires allowedRoot.", "INVALID_STEP_6I_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Step 6I requires projectPath.", "INVALID_STEP_6I_REQUEST");
  }
  if (typeof request.projectId !== "string" || !PROJECT_ID_PATTERN.test(request.projectId)) {
    fail("Step 6I requires a safe projectId.", "INVALID_STEP_6I_REQUEST");
  }
  if (request.reportName !== undefined && (typeof request.reportName !== "string" || !REPORT_NAME_PATTERN.test(request.reportName) || !request.reportName.endsWith(".json"))) {
    fail("Step 6I reportName must be a safe filename ending in .json.", "INVALID_STEP_6I_REQUEST");
  }

  const projectId = request.projectId;
  const allowedRoot = path.resolve(request.allowedRoot);
  const now = typeof request.now === "function" ? request.now : defaultNow;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const env = request.env ?? process.env;
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : STEP_6I_TIMEOUT_MS;

  let projectPath = null;
  try {
    projectPath = resolveSafePath(allowedRoot, request.projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeRecord({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath: null,
        promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
        promptArtifactHash: null, promptSourceConfirmed: false,
        codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
        parsed: null, recordTimestamp: now(),
        agentOutputWritten: false, jsonReportRelative: null,
        agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
        artifactsWritten: false, promptArtifactWritten: false,
        codexArgv: null, timeoutMs
      });
    }
    throw error;
  }
  if (!fs.existsSync(projectPath)) {
    return freezeRecord({
      classification: CLASSIFICATIONS.MISSING_PROJECT,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash: null, promptSourceConfirmed: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp: now(),
      agentOutputWritten: false, jsonReportRelative: null,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: false,
      codexArgv: null, timeoutMs
    });
  }
  try {
    assertRealPathWithinRoot(allowedRoot, projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeRecord({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath,
        promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
        promptArtifactHash: null, promptSourceConfirmed: false,
        codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
        parsed: null, recordTimestamp: now(),
        agentOutputWritten: false, jsonReportRelative: null,
        agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
        artifactsWritten: false, promptArtifactWritten: false,
        codexArgv: null, timeoutMs
      });
    }
    throw error;
  }

  const promptArtifactAbsolute = resolveSafePath(projectPath, STEP_6I_PROMPT_RELATIVE);
  const promptDirectoryAbsolute = path.dirname(promptArtifactAbsolute);

  const recordTimestamp = now();
  const reportName = request.reportName ?? safeReportNameFromTimestamp(recordTimestamp);
  if (!REPORT_NAME_PATTERN.test(reportName) || !reportName.endsWith(".json")) {
    fail("Computed Step 6I report filename is unsafe.", "INVALID_STEP_6I_REQUEST");
  }
  const jsonReportRelative = `${STEP_6I_REPORT_DIRECTORY_RELATIVE}/${reportName}`;
  const jsonReportAbsolute = resolveSafePath(projectPath, jsonReportRelative);
  const agentOutputAbsolute = resolveSafePath(projectPath, STEP_6I_AGENT_OUTPUT_RELATIVE);

  const allowedPostCodexPaths = new Set([STEP_6I_AGENT_OUTPUT_RELATIVE, jsonReportRelative]);

  const snapshotS0 = snapshotAllProjectFiles(projectPath);
  const expectedPromptContent = buildStep6iPrompt(projectId);

  try {
    fs.mkdirSync(promptDirectoryAbsolute, { recursive: true });
    fs.writeFileSync(promptArtifactAbsolute, expectedPromptContent, { encoding: "utf8" });
  } catch (error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.PROMPT_WRITE_FAILED,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash: null, promptSourceConfirmed: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: false,
      codexArgv: null, timeoutMs
    });
  }

  const snapshotS1 = snapshotAllProjectFiles(projectPath);
  const promptWriteChanged = diffSnapshots(snapshotS0, snapshotS1);
  const promptWriteForbidden = promptWriteChanged.filter((entry) => entry !== STEP_6I_PROMPT_RELATIVE);
  if (promptWriteForbidden.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.FORBIDDEN_MUTATION,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash: null, promptSourceConfirmed: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: true, forbiddenMutatedFiles: promptWriteForbidden,
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv: null, timeoutMs
    });
  }

  let readBackContent;
  try {
    readBackContent = fs.readFileSync(promptArtifactAbsolute, { encoding: "utf8" });
  } catch (error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.PROMPT_READBACK_FAILED,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash: null, promptSourceConfirmed: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv: null, timeoutMs
    });
  }

  const promptArtifactHash = createHash("sha256").update(readBackContent).digest("hex");
  if (readBackContent !== expectedPromptContent) {
    return freezeRecord({
      classification: CLASSIFICATIONS.PROMPT_MISMATCH,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv: null, timeoutMs
    });
  }

  const codexArgv = buildStep6iArgv(readBackContent);
  assertArgvSafety(codexArgv, readBackContent);

  const codexResult = runCodexSpawn({ spawn, argv: codexArgv, projectPath, env, timeoutMs });

  const snapshotS2 = snapshotAllProjectFiles(projectPath);
  const codexChanged = diffSnapshots(snapshotS1, snapshotS2);
  if (codexChanged.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.CODEX_MUTATED_PROJECT,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: true,
      codexResult, codexMutatedFiles: codexChanged, forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv, timeoutMs
    });
  }

  const codexClassification = classifyCodex(codexResult);
  if (codexClassification !== null) {
    return freezeRecord({
      classification: codexClassification,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv, timeoutMs
    });
  }

  if (!codexResult.markerInOutput) {
    return freezeRecord({
      classification: CLASSIFICATIONS.MARKER_MISSING,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv, timeoutMs
    });
  }

  const parsed = parseStep6iReport(codexResult.combined, {
    expectedProjectId: projectId,
    expectedPromptSource: STEP_6I_PROMPT_RELATIVE
  });
  if (!parsed.ok) {
    return freezeRecord({
      classification: CLASSIFICATIONS.MARKER_MALFORMED,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv, timeoutMs
    });
  }

  const jsonReport = buildJsonReport({
    projectId,
    classification: CLASSIFICATIONS.PASS,
    codexExitCode: codexResult.exitCode,
    codexTimedOut: codexResult.timedOut,
    markerCaptured: true,
    reportValid: true,
    codexMutatedProject: false,
    codexMutatedFiles: [],
    forbiddenMutation: false,
    forbiddenMutatedFiles: [],
    filesInspected: parsed.report.filesInspected,
    summary: parsed.report.summary,
    promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
    promptArtifactHash,
    promptSourceConfirmed: true,
    recordTimestamp,
    jsonReportRelative,
    agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
    stdout: codexResult.stdout,
    stderr: codexResult.stderr,
    timeoutMs
  });
  const agentOutputMarkdown = buildAgentOutputMarkdown({
    projectId,
    classification: CLASSIFICATIONS.PASS,
    codexExitCode: codexResult.exitCode,
    codexTimedOut: codexResult.timedOut,
    markerCaptured: true,
    reportValid: true,
    codexMutatedProject: false,
    filesInspected: parsed.report.filesInspected,
    summary: parsed.report.summary,
    promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
    promptArtifactHash,
    promptSourceConfirmed: true,
    recordTimestamp,
    jsonReportRelative
  });

  try {
    fs.mkdirSync(path.dirname(jsonReportAbsolute), { recursive: true });
    fs.writeFileSync(jsonReportAbsolute, `${JSON.stringify(jsonReport, null, 2)}\n`, { encoding: "utf8" });
    fs.writeFileSync(agentOutputAbsolute, agentOutputMarkdown, { encoding: "utf8" });
  } catch (error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.ARTIFACT_WRITE_FAILED,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv, timeoutMs
    });
  }

  const snapshotS3 = snapshotAllProjectFiles(projectPath);
  const postCodexChanged = diffSnapshots(snapshotS2, snapshotS3);
  const postCodexForbidden = postCodexChanged.filter((entry) => !allowedPostCodexPaths.has(entry));
  if (postCodexForbidden.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.FORBIDDEN_MUTATION,
      projectId, allowedRoot, projectPath,
      promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
      promptArtifactHash, promptSourceConfirmed: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: true, forbiddenMutatedFiles: postCodexForbidden,
      parsed, recordTimestamp,
      agentOutputWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
      artifactsWritten: false, promptArtifactWritten: true,
      codexArgv, timeoutMs
    });
  }

  return freezeRecord({
    classification: CLASSIFICATIONS.PASS,
    projectId, allowedRoot, projectPath,
    promptArtifactRelative: STEP_6I_PROMPT_RELATIVE,
    promptArtifactHash, promptSourceConfirmed: true,
    codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
    parsed, recordTimestamp,
    agentOutputWritten: true, jsonReportRelative,
    agentOutputRelative: STEP_6I_AGENT_OUTPUT_RELATIVE,
    artifactsWritten: true, promptArtifactWritten: true,
    codexArgv, timeoutMs
  });
}
