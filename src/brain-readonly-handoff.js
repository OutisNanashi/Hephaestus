import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { HephaestusError, fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

export const STEP_6L_MARKER = "HEPHAESTUS_STEP_6L_MOCKED_BRAIN_HANDOFF_OK";
export const STEP_6L_DECISION_RELATIVE = "out/brain_decisions/step-6l-mocked-brain-decision.json";
export const STEP_6L_PROMPT_RELATIVE = "out/prompts/step-6l-brain-readonly-prompt.md";
export const STEP_6L_REPORT_DIRECTORY_RELATIVE = "out/agent_outputs";
export const STEP_6L_AGENT_OUTPUT_RELATIVE = "AGENT_OUTPUT.md";
const STEP_6L_DEFAULT_REPORT_PREFIX = "step-6l-mocked-brain-readonly-handoff";
const STEP_6L_DECISION_SCHEMA = "hephaestus.step-6l.mocked-brain-decision/v1";
const STEP_6L_PHASE = "Activation Step 6L";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;
const REPORT_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9_./\-]+$/u;

const STEP_6L_TIMEOUT_MS = 120_000;
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const OUTPUT_SUMMARY_LIMIT = 240;

const PATH_ERROR_CODES = new Set(["OUTSIDE_ALLOWED_ROOT", "INVALID_PATH", "UNSAFE_PATH", "INVALID_PROJECT_PATH", "PATH_RESOLUTION_FAILED"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "env", "spawn",
  "explicitMockedBrainHandoffPermit", "timeoutMs", "now", "reportName"
]);

const FORBIDDEN_DECISION_FIELDS = Object.freeze([
  "command", "shell", "executable", "argv", "cwd",
  "prompt", "promptFile", "autoApproval", "workspaceWrite",
  "merge", "deploy", "secrets", "env"
]);

const REQUIRED_FORBIDDEN_ACTIONS = Object.freeze([
  "write_files", "delete_files", "rename_files", "move_files",
  "run_mutating_commands", "network_access", "request_approval",
  "workspace_write", "autonomous_execution", "merge", "deploy"
]);

const RECOGNIZED_FORBIDDEN_ACTIONS = new Set([...REQUIRED_FORBIDDEN_ACTIONS]);

const REQUIRED_REPORT_KEYS = Object.freeze(["project", "readonly", "decision_type", "prompt_source", "files_inspected", "summary"]);
const REPORT_ALLOWED_KEYS = new Set([...REQUIRED_REPORT_KEYS]);
const REPORT_VALUE_LIMIT = 200;

const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--search",
  "-c"
]);

const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write", "danger-full-access"]);

export const STEP_6L_FLAGS = Object.freeze({
  sandbox: "read-only",
  sandboxScope: "top-level",
  askForApproval: "never",
  askForApprovalScope: "top-level",
  subcommand: "exec",
  shell: false
});

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6L_PASS",
  INVALID_REQUEST: "STEP_6L_BLOCKED_INVALID_REQUEST",
  UNSAFE_PROJECT: "STEP_6L_BLOCKED_UNSAFE_PROJECT",
  MISSING_PROJECT: "STEP_6L_BLOCKED_MISSING_PROJECT",
  BRAIN_DECISION_WRITE_FAILED: "STEP_6L_BLOCKED_BRAIN_DECISION_WRITE_FAILED",
  BRAIN_DECISION_READBACK_FAILED: "STEP_6L_BLOCKED_BRAIN_DECISION_READBACK_FAILED",
  BRAIN_DECISION_INVALID: "STEP_6L_BLOCKED_BRAIN_DECISION_INVALID",
  BRAIN_DECISION_MISMATCH: "STEP_6L_BLOCKED_BRAIN_DECISION_MISMATCH",
  PROMPT_WRITE_FAILED: "STEP_6L_BLOCKED_PROMPT_WRITE_FAILED",
  PROMPT_READBACK_FAILED: "STEP_6L_BLOCKED_PROMPT_READBACK_FAILED",
  PROMPT_MISMATCH: "STEP_6L_BLOCKED_PROMPT_MISMATCH",
  NOT_INSTALLED: "STEP_6L_BLOCKED_CODEX_NOT_INSTALLED",
  AUTH: "STEP_6L_BLOCKED_CODEX_AUTH",
  USAGE_LIMIT: "STEP_6L_BLOCKED_CODEX_USAGE_LIMIT",
  TIMEOUT: "STEP_6L_BLOCKED_CODEX_TIMEOUT",
  CRASH: "STEP_6L_BLOCKED_CODEX_CRASH",
  INTERACTIVE: "STEP_6L_BLOCKED_CODEX_INTERACTIVE",
  MARKER_MISSING: "STEP_6L_BLOCKED_MARKER_MISSING",
  MARKER_MALFORMED: "STEP_6L_BLOCKED_MARKER_MALFORMED",
  CODEX_MUTATED_PROJECT: "STEP_6L_BLOCKED_CODEX_MUTATED_PROJECT",
  ARTIFACT_WRITE_FAILED: "STEP_6L_BLOCKED_ARTIFACT_WRITE_FAILED",
  FORBIDDEN_MUTATION: "STEP_6L_BLOCKED_FORBIDDEN_MUTATION"
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

export function buildMockedBrainDecision(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    fail("Mocked brain decision requires a safe projectId.", "INVALID_STEP_6L_PROJECT_ID");
  }
  return {
    schema: STEP_6L_DECISION_SCHEMA,
    project: projectId,
    phase: STEP_6L_PHASE,
    decisionType: "READONLY_AGENT_PROMPT",
    adapter: "codex",
    mode: "read-only",
    allowedAction: "INSPECT_FIXTURE_ONLY",
    forbiddenActions: [...REQUIRED_FORBIDDEN_ACTIONS],
    requiredMarker: STEP_6L_MARKER,
    promptSource: STEP_6L_PROMPT_RELATIVE,
    expectedReportKeys: [...REQUIRED_REPORT_KEYS],
    nextSafeStep: "6M (design only)"
  };
}

export function serializeMockedBrainDecision(decision) {
  return `${JSON.stringify(decision, null, 2)}\n`;
}

export function validateMockedBrainDecision(candidate, expectedProjectId) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, reason: "not-an-object" };
  }
  for (const forbiddenField of FORBIDDEN_DECISION_FIELDS) {
    if (Object.hasOwn(candidate, forbiddenField)) return { ok: false, reason: `forbidden-field-${forbiddenField}` };
  }
  if (candidate.schema !== STEP_6L_DECISION_SCHEMA) return { ok: false, reason: "schema-mismatch" };
  if (candidate.project !== expectedProjectId) return { ok: false, reason: "project-mismatch" };
  if (candidate.phase !== STEP_6L_PHASE) return { ok: false, reason: "phase-mismatch" };
  if (candidate.decisionType !== "READONLY_AGENT_PROMPT") return { ok: false, reason: "decision-type-mismatch" };
  if (candidate.adapter !== "codex") return { ok: false, reason: "adapter-mismatch" };
  if (candidate.mode !== "read-only") return { ok: false, reason: "mode-mismatch" };
  if (candidate.allowedAction !== "INSPECT_FIXTURE_ONLY") return { ok: false, reason: "allowed-action-mismatch" };
  if (!Array.isArray(candidate.forbiddenActions)) return { ok: false, reason: "forbidden-actions-not-array" };
  for (const required of REQUIRED_FORBIDDEN_ACTIONS) {
    if (!candidate.forbiddenActions.includes(required)) return { ok: false, reason: `missing-forbidden-${required}` };
  }
  for (const entry of candidate.forbiddenActions) {
    if (!RECOGNIZED_FORBIDDEN_ACTIONS.has(entry)) return { ok: false, reason: `unknown-forbidden-${entry}` };
  }
  if (candidate.requiredMarker !== STEP_6L_MARKER) return { ok: false, reason: "required-marker-mismatch" };
  if (candidate.promptSource !== STEP_6L_PROMPT_RELATIVE) return { ok: false, reason: "prompt-source-mismatch" };
  if (!Array.isArray(candidate.expectedReportKeys)) return { ok: false, reason: "expected-report-keys-not-array" };
  for (const required of REQUIRED_REPORT_KEYS) {
    if (!candidate.expectedReportKeys.includes(required)) return { ok: false, reason: `missing-expected-key-${required}` };
  }
  if (candidate.nextSafeStep !== "6M (design only)") return { ok: false, reason: "next-safe-step-mismatch" };
  return { ok: true, reason: null };
}

export function buildStep6lPrompt(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    fail("Step 6L prompt requires a safe projectId.", "INVALID_STEP_6L_PROJECT_ID");
  }
  return [
    "You are a Codex non-interactive read-only inspector handling a Hephaestus Step 6L mocked-brain handoff.",
    "",
    "This prompt was generated by a controlled mocked brain decision. It is NOT a real GPT decision.",
    "",
    "Rules:",
    "- Inspect only the fixture project files in the current working directory.",
    "- Do not modify, create, delete, rename, or move any file.",
    "- Do not run any shell commands that would change the workspace.",
    "- Do not access the network.",
    "- Do not request approvals or human interaction.",
    "",
    `Project: ${projectId}`,
    "Decision type: READONLY_AGENT_PROMPT",
    `Required marker: ${STEP_6L_MARKER}`,
    "",
    "Inspect the fixture project and emit a structured Step 6L report.",
    "Respond with exactly these lines, in this exact order, and nothing else:",
    STEP_6L_MARKER,
    `project=${projectId}`,
    "readonly=true",
    "decision_type=READONLY_AGENT_PROMPT",
    `prompt_source=${STEP_6L_PROMPT_RELATIVE}`,
    "files_inspected=<comma-separated fixture file names you actually read, e.g. PLAN.md,STATE.json>",
    "summary=<one short factual sentence describing the fixture>",
    ""
  ].join("\n");
}

export function buildStep6lArgv(promptContent) {
  if (typeof promptContent !== "string" || promptContent.length === 0) {
    fail("Step 6L argv builder requires a non-empty prompt string.", "INVALID_STEP_6L_PROMPT_CONTENT");
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
  if (execIndex === -1) fail("Step 6L argv must include exec.", "INVALID_STEP_6L_ARGV");
  const sandboxIndex = flat.indexOf("--sandbox");
  if (sandboxIndex === -1 || flat[sandboxIndex + 1] !== "read-only") fail("Step 6L argv must include --sandbox read-only.", "INVALID_STEP_6L_ARGV");
  if (sandboxIndex > execIndex) fail("Step 6L argv must place --sandbox before exec.", "INVALID_STEP_6L_ARGV");
  const approvalIndex = flat.indexOf("--ask-for-approval");
  if (approvalIndex === -1 || flat[approvalIndex + 1] !== "never") fail("Step 6L argv must include --ask-for-approval never.", "INVALID_STEP_6L_ARGV");
  if (approvalIndex > execIndex) fail("Step 6L argv must place --ask-for-approval before exec.", "INVALID_STEP_6L_ARGV");
  if (execIndex !== flat.length - 2) fail("Step 6L argv must end with exec then prompt.", "INVALID_STEP_6L_ARGV");
  if (flat[flat.length - 1] !== expectedPrompt) fail("Step 6L argv must terminate with read-back prompt content.", "INVALID_STEP_6L_ARGV");
  for (const forbidden of FORBIDDEN_ARGV_TOKENS) if (flat.includes(forbidden)) fail(`Step 6L argv contains forbidden token ${forbidden}.`, "INVALID_STEP_6L_ARGV");
  for (const forbiddenSandbox of FORBIDDEN_SANDBOX_VALUES) if (flat.includes(forbiddenSandbox)) fail(`Step 6L argv contains forbidden sandbox ${forbiddenSandbox}.`, "INVALID_STEP_6L_ARGV");
}

export function parseStep6lReport(output, { expectedProjectId, expectedPromptSource }) {
  if (typeof output !== "string") return { ok: false, reason: "output-not-string", report: null };
  const markerIndex = output.indexOf(STEP_6L_MARKER);
  if (markerIndex === -1) return { ok: false, reason: "marker-missing", report: null };
  const after = output.slice(markerIndex + STEP_6L_MARKER.length);
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
    if (value.length === 0 || value.length > REPORT_VALUE_LIMIT) return { ok: false, reason: `value-${key}-invalid`, report: null };
    if (Object.hasOwn(report, key)) return { ok: false, reason: `duplicate-${key}`, report: null };
    report[key] = value;
  }
  for (const required of REQUIRED_REPORT_KEYS) {
    if (!Object.hasOwn(report, required)) return { ok: false, reason: `missing-${required}`, report: null };
  }
  if (report.readonly.toLowerCase() !== "true") return { ok: false, reason: "readonly-not-true", report: null };
  if (report.project !== expectedProjectId) return { ok: false, reason: "project-mismatch", report: null };
  if (report.decision_type !== "READONLY_AGENT_PROMPT") return { ok: false, reason: "decision-type-mismatch", report: null };
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
      decisionType: report.decision_type,
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
    if (entry.name === ".git" || entry.name === "node_modules") continue;
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
    fail("Step 6L request must be an object.", "INVALID_STEP_6L_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Step 6L request contains an unsupported field: ${key}.`, "INVALID_STEP_6L_REQUEST");
    }
  }
}

function safeReportNameFromTimestamp(timestamp) {
  const stamp = String(timestamp).replace(/[:.]/gu, "-").replace(/[^A-Za-z0-9_.\-]/gu, "-");
  return `${STEP_6L_DEFAULT_REPORT_PREFIX}-${stamp.slice(0, 64)}.json`;
}

function bool(value) { return value ? "yes" : "no"; }

function buildAgentOutputMarkdown(args) {
  return [
    "# Hephaestus Step 6L — Mocked brain read-only Codex handoff record",
    "",
    "This artifact records the output of a mocked-brain read-only Codex handoff.",
    "It is NOT real GPT and NOT implementation output. Codex was not allowed to write files and never received a user-supplied prompt.",
    "",
    `- Step: 6L (mocked brain → read-only Codex handoff)`,
    `- Recorded at: ${args.recordTimestamp}`,
    `- Project: ${args.projectId}`,
    `- Adapter: codex`,
    `- Step 6L classification: ${args.classification}`,
    `- Mocked brain decision path: ${args.decisionRelative}`,
    `- Mocked brain decision SHA-256: ${args.decisionHash ?? "n/a"}`,
    `- Mocked brain decision valid: ${bool(args.decisionValid)}`,
    `- Prompt artifact path: ${args.promptRelative}`,
    `- Prompt artifact SHA-256: ${args.promptHash ?? "n/a"}`,
    `- Prompt source confirmed: ${bool(args.promptSourceConfirmed)}`,
    `- Marker captured: ${bool(args.markerCaptured)}`,
    `- Report valid: ${bool(args.reportValid)}`,
    `- Codex mutated project during run: ${bool(args.codexMutatedProject)}`,
    `- Codex exit code: ${args.codexExitCode === null ? "n/a" : args.codexExitCode}`,
    `- Codex timed out: ${bool(args.codexTimedOut)}`,
    `- Files inspected by Codex: ${args.filesInspected.length === 0 ? "(none)" : args.filesInspected.join(", ")}`,
    `- Codex summary: ${args.summary === null || args.summary === "" ? "(none)" : args.summary}`,
    `- Companion JSON report: ${args.jsonReportRelative}`,
    "",
    "## Safety invariants",
    "- shell: false (locked)",
    `- sandbox: ${STEP_6L_FLAGS.sandbox}`,
    `- ask-for-approval: ${STEP_6L_FLAGS.askForApproval}`,
    "- dangerous bypass: no",
    "- stdin policy: closed-empty",
    "- env policy: sandbox-safe (LANG, PATH)",
    "- real GPT used: no",
    "- workspace-write enabled: no",
    "- arbitrary prompt execution enabled: no",
    "- autonomous execution enabled: no",
    "",
    "## Next safe step",
    args.classification === CLASSIFICATIONS.PASS
      ? "Step 6M may be designed. No real GPT decision and no implementation prompt was sent to Codex."
      : "Resolve the Step 6L blocker before designing Step 6M.",
    ""
  ].join("\n");
}

function buildJsonReport(args) {
  return {
    schema: "hephaestus.step-6l.mocked-brain-readonly-handoff/v1",
    recordingStep: "6L",
    project: args.projectId,
    adapter: "codex",
    classification: args.classification,
    mockedBrainDecisionPath: args.decisionRelative,
    mockedBrainDecisionHash: args.decisionHash,
    mockedBrainDecisionValid: args.decisionValid,
    promptArtifactPath: args.promptRelative,
    promptArtifactHash: args.promptHash,
    promptSourceConfirmed: args.promptSourceConfirmed,
    markerCaptured: args.markerCaptured,
    reportValid: args.reportValid,
    projectMutatedDuringCodexRun: args.codexMutatedProject,
    mutatedFilesDuringCodexRun: [...args.codexMutatedFiles],
    forbiddenMutation: args.forbiddenMutation,
    forbiddenMutatedFiles: [...args.forbiddenMutatedFiles],
    filesInspected: [...args.filesInspected],
    summary: args.summary,
    invocation: {
      shell: false,
      sandbox: STEP_6L_FLAGS.sandbox,
      askForApproval: STEP_6L_FLAGS.askForApproval,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    },
    realGptUsed: false,
    workspaceWriteEnabled: false,
    arbitraryPromptExecutionEnabled: false,
    autonomousExecutionEnabled: false,
    stdout: args.stdout,
    stderr: args.stderr,
    exitCode: args.codexExitCode,
    timeoutMs: args.timeoutMs,
    timedOut: args.codexTimedOut,
    createdAt: args.recordTimestamp,
    artifacts: {
      mockedBrainDecision: args.decisionRelative,
      promptArtifact: args.promptRelative,
      agentOutput: args.agentOutputRelative,
      jsonReport: args.jsonReportRelative
    },
    nextSafeStep: args.classification === CLASSIFICATIONS.PASS ? "6M (design only)" : null
  };
}

function manualActionFor(classification) {
  switch (classification) {
    case CLASSIFICATIONS.PASS: return null;
    case CLASSIFICATIONS.MISSING_PROJECT: return "Register the requested project or correct --project before retrying Step 6L.";
    case CLASSIFICATIONS.UNSAFE_PROJECT: return "Provide a project whose path resolves inside the configured allowed root.";
    case CLASSIFICATIONS.BRAIN_DECISION_WRITE_FAILED: return "Hephaestus failed to write the Step 6L mocked brain decision artifact; check permissions.";
    case CLASSIFICATIONS.BRAIN_DECISION_READBACK_FAILED: return "Hephaestus failed to read the Step 6L mocked brain decision artifact back.";
    case CLASSIFICATIONS.BRAIN_DECISION_INVALID: return "The Step 6L mocked brain decision failed schema validation.";
    case CLASSIFICATIONS.BRAIN_DECISION_MISMATCH: return "The read-back Step 6L mocked brain decision does not match the controlled template.";
    case CLASSIFICATIONS.PROMPT_WRITE_FAILED: return "Hephaestus failed to write the Step 6L prompt artifact.";
    case CLASSIFICATIONS.PROMPT_READBACK_FAILED: return "Hephaestus failed to read the Step 6L prompt artifact back.";
    case CLASSIFICATIONS.PROMPT_MISMATCH: return "The read-back Step 6L prompt does not match the controlled template.";
    case CLASSIFICATIONS.NOT_INSTALLED: return "Install the Codex CLI before retrying Step 6L.";
    case CLASSIFICATIONS.AUTH: return "Authenticate the Codex CLI before retrying Step 6L.";
    case CLASSIFICATIONS.USAGE_LIMIT: return "Codex usage limit reached. Wait or add credits, then retry Step 6L.";
    case CLASSIFICATIONS.TIMEOUT: return "Codex did not respond within the Step 6L timeout.";
    case CLASSIFICATIONS.CRASH: return "Codex exited non-zero or crashed during Step 6L; inspect stderr.";
    case CLASSIFICATIONS.INTERACTIVE: return "Codex appears to require interactive approval.";
    case CLASSIFICATIONS.MARKER_MISSING: return `Codex completed without emitting the Step 6L marker (${STEP_6L_MARKER}).`;
    case CLASSIFICATIONS.MARKER_MALFORMED: return "Codex emitted the Step 6L marker but the structured report failed validation.";
    case CLASSIFICATIONS.CODEX_MUTATED_PROJECT: return "Codex modified the fixture during a read-only run; treat as safety regression.";
    case CLASSIFICATIONS.ARTIFACT_WRITE_FAILED: return "Hephaestus failed to write Step 6L output artifacts.";
    case CLASSIFICATIONS.FORBIDDEN_MUTATION: return "Step 6L detected unexpected project changes outside the allowed paths.";
    case CLASSIFICATIONS.INVALID_REQUEST: return "Step 6L request was rejected; correct the request shape.";
    default: return "Unknown Step 6L classification; investigate before proceeding.";
  }
}

function freezeRecord({
  classification, projectId, allowedRoot, projectPath,
  decisionRelative, decisionHash, decisionValid, decisionWritten,
  promptRelative, promptHash, promptSourceConfirmed, promptArtifactWritten,
  codexResult, codexMutatedFiles, forbiddenMutation, forbiddenMutatedFiles,
  parsed, recordTimestamp,
  artifactsWritten, jsonReportRelative, agentOutputRelative,
  codexArgv, timeoutMs
}) {
  const filesInspected = parsed?.report?.filesInspected ? [...parsed.report.filesInspected] : [];
  const summary = parsed?.report?.summary ?? null;
  const codexExitCode = codexResult?.exitCode ?? null;
  const codexTimedOut = codexResult?.timedOut ?? false;
  const markerCaptured = codexResult?.markerInOutput === true && classification === CLASSIFICATIONS.PASS;
  const reportValid = parsed?.ok === true && classification === CLASSIFICATIONS.PASS;
  const codexMutatedProject = (codexMutatedFiles?.length ?? 0) > 0;
  return Object.freeze({
    classification,
    adapter: "codex",
    mode: "mocked-brain-readonly-exec",
    project: Object.freeze({ id: projectId ?? null, allowedRoot: allowedRoot ?? null, resolvedPath: projectPath ?? null }),
    step: "6L",
    mockedBrainDecisionPath: decisionRelative,
    mockedBrainDecisionHash: decisionHash ?? null,
    mockedBrainDecisionValid: decisionValid === true,
    mockedBrainDecisionWritten: decisionWritten === true,
    promptArtifactPath: promptRelative,
    promptArtifactHash: promptHash ?? null,
    promptSourceConfirmed: promptSourceConfirmed === true,
    promptArtifactWritten: promptArtifactWritten === true,
    executable: codexResult ? "codex" : null,
    argv: codexArgv ?? null,
    invocation: Object.freeze({
      shell: false,
      sandbox: STEP_6L_FLAGS.sandbox,
      sandboxScope: STEP_6L_FLAGS.sandboxScope,
      askForApproval: STEP_6L_FLAGS.askForApproval,
      askForApprovalScope: STEP_6L_FLAGS.askForApprovalScope,
      subcommand: STEP_6L_FLAGS.subcommand,
      autoApproval: false,
      dangerousBypass: false,
      stdinPolicy: "closed-empty",
      envPolicy: "sandbox-safe (LANG, PATH)"
    }),
    handoffMarker: STEP_6L_MARKER,
    stdout: codexResult?.stdout ?? "",
    stderr: codexResult?.stderr ?? "",
    summary: summarize(`${codexResult?.stdout ?? ""}${codexResult?.stderr ?? ""}`),
    exitCode: codexExitCode,
    errorCode: codexResult?.errorCode ?? null,
    timedOut: codexTimedOut,
    timeoutMs: timeoutMs ?? null,
    markerCaptured,
    markerInOutput: codexResult?.markerInOutput === true,
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
      mockedBrainDecision: decisionRelative,
      promptArtifact: promptRelative,
      agentOutput: artifactsWritten ? agentOutputRelative : null,
      jsonReport: artifactsWritten ? jsonReportRelative : null
    }),
    realGptUsed: false,
    workspaceWriteEnabled: false,
    arbitraryPromptExecutionEnabled: false,
    autonomousExecutionEnabled: false,
    recordedAt: recordTimestamp,
    step6mSafeToDesign: classification === CLASSIFICATIONS.PASS,
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
    markerInOutput: combined.includes(STEP_6L_MARKER)
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

/** Run one Step 6L mocked-brain → controlled prompt → read-only Codex handoff with full mutation guardrails. */
export function runActivationMockedBrainReadonlyHandoff(request) {
  assertRequestShape(request);
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Step 6L is only available for the codex adapter; received ${adapterId}.`, "STEP_6L_ADAPTER_NOT_ALLOWED");
  requireAdapter(adapterId);
  if (request.explicitMockedBrainHandoffPermit !== true) {
    fail("Step 6L requires explicitMockedBrainHandoffPermit=true.", "STEP_6L_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) fail("Step 6L requires allowedRoot.", "INVALID_STEP_6L_REQUEST");
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) fail("Step 6L requires projectPath.", "INVALID_STEP_6L_REQUEST");
  if (typeof request.projectId !== "string" || !PROJECT_ID_PATTERN.test(request.projectId)) fail("Step 6L requires a safe projectId.", "INVALID_STEP_6L_REQUEST");
  if (request.reportName !== undefined && (typeof request.reportName !== "string" || !REPORT_NAME_PATTERN.test(request.reportName) || !request.reportName.endsWith(".json"))) {
    fail("Step 6L reportName must be a safe filename ending in .json.", "INVALID_STEP_6L_REQUEST");
  }

  const projectId = request.projectId;
  const allowedRoot = path.resolve(request.allowedRoot);
  const now = typeof request.now === "function" ? request.now : defaultNow;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const env = request.env ?? process.env;
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : STEP_6L_TIMEOUT_MS;

  let projectPath = null;
  try {
    projectPath = resolveSafePath(allowedRoot, request.projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeRecord({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath: null,
        decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash: null, decisionValid: false, decisionWritten: false,
        promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
        codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
        parsed: null, recordTimestamp: now(),
        artifactsWritten: false, jsonReportRelative: null,
        agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
        codexArgv: null, timeoutMs
      });
    }
    throw error;
  }
  if (!fs.existsSync(projectPath)) {
    return freezeRecord({
      classification: CLASSIFICATIONS.MISSING_PROJECT,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash: null, decisionValid: false, decisionWritten: false,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp: now(),
      artifactsWritten: false, jsonReportRelative: null,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
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
        decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash: null, decisionValid: false, decisionWritten: false,
        promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
        codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
        parsed: null, recordTimestamp: now(),
        artifactsWritten: false, jsonReportRelative: null,
        agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
        codexArgv: null, timeoutMs
      });
    }
    throw error;
  }

  const decisionAbsolute = resolveSafePath(projectPath, STEP_6L_DECISION_RELATIVE);
  const promptAbsolute = resolveSafePath(projectPath, STEP_6L_PROMPT_RELATIVE);
  const recordTimestamp = now();
  const reportName = request.reportName ?? safeReportNameFromTimestamp(recordTimestamp);
  if (!REPORT_NAME_PATTERN.test(reportName) || !reportName.endsWith(".json")) {
    fail("Computed Step 6L report filename is unsafe.", "INVALID_STEP_6L_REQUEST");
  }
  const jsonReportRelative = `${STEP_6L_REPORT_DIRECTORY_RELATIVE}/${reportName}`;
  const jsonReportAbsolute = resolveSafePath(projectPath, jsonReportRelative);
  const agentOutputAbsolute = resolveSafePath(projectPath, STEP_6L_AGENT_OUTPUT_RELATIVE);

  const allowedPostCodexPaths = new Set([STEP_6L_AGENT_OUTPUT_RELATIVE, jsonReportRelative]);

  const snapshotS0 = snapshotAllProjectFiles(projectPath);

  // === Step 1: write mocked brain decision ===
  const expectedDecision = buildMockedBrainDecision(projectId);
  const expectedDecisionText = serializeMockedBrainDecision(expectedDecision);
  try {
    fs.mkdirSync(path.dirname(decisionAbsolute), { recursive: true });
    fs.writeFileSync(decisionAbsolute, expectedDecisionText, { encoding: "utf8" });
  } catch (_error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.BRAIN_DECISION_WRITE_FAILED,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash: null, decisionValid: false, decisionWritten: false,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }

  const snapshotS1 = snapshotAllProjectFiles(projectPath);
  const decisionWriteChanged = diffSnapshots(snapshotS0, snapshotS1);
  const decisionWriteForbidden = decisionWriteChanged.filter((entry) => entry !== STEP_6L_DECISION_RELATIVE);
  if (decisionWriteForbidden.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.FORBIDDEN_MUTATION,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash: null, decisionValid: false, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: true, forbiddenMutatedFiles: decisionWriteForbidden,
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }

  // === Step 2: read decision back and validate ===
  let decisionReadback;
  try {
    decisionReadback = fs.readFileSync(decisionAbsolute, { encoding: "utf8" });
  } catch (_error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.BRAIN_DECISION_READBACK_FAILED,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash: null, decisionValid: false, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }
  const decisionHash = createHash("sha256").update(decisionReadback).digest("hex");
  if (decisionReadback !== expectedDecisionText) {
    return freezeRecord({
      classification: CLASSIFICATIONS.BRAIN_DECISION_MISMATCH,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: false, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }
  let parsedDecision;
  try { parsedDecision = JSON.parse(decisionReadback); } catch { parsedDecision = null; }
  const validation = validateMockedBrainDecision(parsedDecision, projectId);
  if (!validation.ok) {
    return freezeRecord({
      classification: CLASSIFICATIONS.BRAIN_DECISION_INVALID,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: false, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }

  // === Step 3: write prompt artifact ===
  const expectedPrompt = buildStep6lPrompt(projectId);
  try {
    fs.mkdirSync(path.dirname(promptAbsolute), { recursive: true });
    fs.writeFileSync(promptAbsolute, expectedPrompt, { encoding: "utf8" });
  } catch (_error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.PROMPT_WRITE_FAILED,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: false,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }

  const snapshotS2 = snapshotAllProjectFiles(projectPath);
  const promptWriteChanged = diffSnapshots(snapshotS1, snapshotS2);
  const promptWriteForbidden = promptWriteChanged.filter((entry) => entry !== STEP_6L_PROMPT_RELATIVE);
  if (promptWriteForbidden.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.FORBIDDEN_MUTATION,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: true,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: true, forbiddenMutatedFiles: promptWriteForbidden,
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }

  let promptReadback;
  try {
    promptReadback = fs.readFileSync(promptAbsolute, { encoding: "utf8" });
  } catch (_error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.PROMPT_READBACK_FAILED,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash: null, promptSourceConfirmed: false, promptArtifactWritten: true,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }
  const promptHash = createHash("sha256").update(promptReadback).digest("hex");
  if (promptReadback !== expectedPrompt) {
    return freezeRecord({
      classification: CLASSIFICATIONS.PROMPT_MISMATCH,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: false, promptArtifactWritten: true,
      codexResult: null, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv: null, timeoutMs
    });
  }

  const codexArgv = buildStep6lArgv(promptReadback);
  assertArgvSafety(codexArgv, promptReadback);

  // === Step 4: run Codex read-only ===
  const codexResult = runCodexSpawn({ spawn, argv: codexArgv, projectPath, env, timeoutMs });
  const snapshotS3 = snapshotAllProjectFiles(projectPath);
  const codexChanged = diffSnapshots(snapshotS2, snapshotS3);
  if (codexChanged.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.CODEX_MUTATED_PROJECT,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
      codexResult, codexMutatedFiles: codexChanged, forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv, timeoutMs
    });
  }

  const codexClassification = classifyCodex(codexResult);
  if (codexClassification !== null) {
    return freezeRecord({
      classification: codexClassification,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv, timeoutMs
    });
  }

  if (!codexResult.markerInOutput) {
    return freezeRecord({
      classification: CLASSIFICATIONS.MARKER_MISSING,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed: null, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv, timeoutMs
    });
  }
  const parsed = parseStep6lReport(codexResult.combined, {
    expectedProjectId: projectId,
    expectedPromptSource: STEP_6L_PROMPT_RELATIVE
  });
  if (!parsed.ok) {
    return freezeRecord({
      classification: CLASSIFICATIONS.MARKER_MALFORMED,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv, timeoutMs
    });
  }

  // === Step 5: write output artifacts ===
  const jsonReport = buildJsonReport({
    projectId,
    classification: CLASSIFICATIONS.PASS,
    decisionRelative: STEP_6L_DECISION_RELATIVE,
    decisionHash,
    decisionValid: true,
    promptRelative: STEP_6L_PROMPT_RELATIVE,
    promptHash,
    promptSourceConfirmed: true,
    markerCaptured: true,
    reportValid: true,
    codexMutatedProject: false,
    codexMutatedFiles: [],
    forbiddenMutation: false,
    forbiddenMutatedFiles: [],
    filesInspected: parsed.report.filesInspected,
    summary: parsed.report.summary,
    recordTimestamp,
    jsonReportRelative,
    agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
    stdout: codexResult.stdout,
    stderr: codexResult.stderr,
    codexExitCode: codexResult.exitCode,
    codexTimedOut: codexResult.timedOut,
    timeoutMs
  });
  const agentOutputMarkdown = buildAgentOutputMarkdown({
    projectId,
    classification: CLASSIFICATIONS.PASS,
    decisionRelative: STEP_6L_DECISION_RELATIVE,
    decisionHash,
    decisionValid: true,
    promptRelative: STEP_6L_PROMPT_RELATIVE,
    promptHash,
    promptSourceConfirmed: true,
    markerCaptured: true,
    reportValid: true,
    codexMutatedProject: false,
    codexExitCode: codexResult.exitCode,
    codexTimedOut: codexResult.timedOut,
    filesInspected: parsed.report.filesInspected,
    summary: parsed.report.summary,
    recordTimestamp,
    jsonReportRelative
  });

  try {
    fs.mkdirSync(path.dirname(jsonReportAbsolute), { recursive: true });
    fs.writeFileSync(jsonReportAbsolute, `${JSON.stringify(jsonReport, null, 2)}\n`, { encoding: "utf8" });
    fs.writeFileSync(agentOutputAbsolute, agentOutputMarkdown, { encoding: "utf8" });
  } catch (_error) {
    return freezeRecord({
      classification: CLASSIFICATIONS.ARTIFACT_WRITE_FAILED,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
      parsed, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv, timeoutMs
    });
  }

  const snapshotS4 = snapshotAllProjectFiles(projectPath);
  const postCodexChanged = diffSnapshots(snapshotS3, snapshotS4);
  const postCodexForbidden = postCodexChanged.filter((entry) => !allowedPostCodexPaths.has(entry));
  if (postCodexForbidden.length > 0) {
    return freezeRecord({
      classification: CLASSIFICATIONS.FORBIDDEN_MUTATION,
      projectId, allowedRoot, projectPath,
      decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
      promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
      codexResult, codexMutatedFiles: [], forbiddenMutation: true, forbiddenMutatedFiles: postCodexForbidden,
      parsed, recordTimestamp,
      artifactsWritten: false, jsonReportRelative,
      agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
      codexArgv, timeoutMs
    });
  }

  return freezeRecord({
    classification: CLASSIFICATIONS.PASS,
    projectId, allowedRoot, projectPath,
    decisionRelative: STEP_6L_DECISION_RELATIVE, decisionHash, decisionValid: true, decisionWritten: true,
    promptRelative: STEP_6L_PROMPT_RELATIVE, promptHash, promptSourceConfirmed: true, promptArtifactWritten: true,
    codexResult, codexMutatedFiles: [], forbiddenMutation: false, forbiddenMutatedFiles: [],
    parsed, recordTimestamp,
    artifactsWritten: true, jsonReportRelative,
    agentOutputRelative: STEP_6L_AGENT_OUTPUT_RELATIVE,
    codexArgv, timeoutMs
  });
}
