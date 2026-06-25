import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HephaestusError, fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";
import {
  CLASSIFICATIONS as INSPECT_CLASSIFICATIONS,
  INSPECT_FLAGS,
  READONLY_INSPECT_MARKER,
  runCodexReadonlyInspect
} from "./agent-readonly-inspect.js";

export const RECORD_AGENT_OUTPUT_FILE = "AGENT_OUTPUT.md";
export const RECORD_REPORT_DIRECTORY = path.join("out", "agent_outputs");
const RECORD_DEFAULT_PREFIX = "step-6h-readonly-inspect";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;
const REPORT_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/u;

const PATH_ERROR_CODES = new Set(["OUTSIDE_ALLOWED_ROOT", "INVALID_PATH", "UNSAFE_PATH", "INVALID_PROJECT_PATH", "PATH_RESOLUTION_FAILED"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "projectId", "env", "spawn",
  "explicitReadonlyInspectRecordPermit", "timeoutMs", "now",
  "reportName", "runInspect"
]);

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6H_PASS",
  STEP_6G_FAILED: "STEP_6H_BLOCKED_STEP_6G_FAILED",
  USAGE_LIMIT: "STEP_6H_BLOCKED_CODEX_USAGE_LIMIT",
  AUTH: "STEP_6H_BLOCKED_CODEX_AUTH",
  TIMEOUT: "STEP_6H_BLOCKED_CODEX_TIMEOUT",
  CRASH: "STEP_6H_BLOCKED_CODEX_CRASH",
  MARKER_MISSING: "STEP_6H_BLOCKED_MARKER_MISSING",
  MARKER_MALFORMED: "STEP_6H_BLOCKED_MARKER_MALFORMED",
  CODEX_MUTATED_PROJECT: "STEP_6H_BLOCKED_CODEX_MUTATED_PROJECT",
  ARTIFACT_WRITE_FAILED: "STEP_6H_BLOCKED_ARTIFACT_WRITE_FAILED",
  FORBIDDEN_MUTATION: "STEP_6H_BLOCKED_FORBIDDEN_MUTATION",
  UNSAFE_PROJECT: "STEP_6H_BLOCKED_UNSAFE_PROJECT",
  MISSING_PROJECT: "STEP_6H_BLOCKED_MISSING_PROJECT",
  NOT_INSTALLED: "STEP_6H_BLOCKED_CODEX_NOT_INSTALLED",
  INTERACTIVE: "STEP_6H_BLOCKED_CODEX_INTERACTIVE"
});

const INSPECT_TO_RECORD_CLASSIFICATION = Object.freeze({
  [INSPECT_CLASSIFICATIONS.MISSING_PROJECT]: CLASSIFICATIONS.MISSING_PROJECT,
  [INSPECT_CLASSIFICATIONS.UNSAFE_PROJECT]: CLASSIFICATIONS.UNSAFE_PROJECT,
  [INSPECT_CLASSIFICATIONS.NOT_INSTALLED]: CLASSIFICATIONS.NOT_INSTALLED,
  [INSPECT_CLASSIFICATIONS.TIMEOUT]: CLASSIFICATIONS.TIMEOUT,
  [INSPECT_CLASSIFICATIONS.AUTH]: CLASSIFICATIONS.AUTH,
  [INSPECT_CLASSIFICATIONS.USAGE_LIMIT]: CLASSIFICATIONS.USAGE_LIMIT,
  [INSPECT_CLASSIFICATIONS.INTERACTIVE]: CLASSIFICATIONS.INTERACTIVE,
  [INSPECT_CLASSIFICATIONS.CRASH]: CLASSIFICATIONS.CRASH,
  [INSPECT_CLASSIFICATIONS.MARKER_MISSING]: CLASSIFICATIONS.MARKER_MISSING,
  [INSPECT_CLASSIFICATIONS.MARKER_MALFORMED]: CLASSIFICATIONS.MARKER_MALFORMED,
  [INSPECT_CLASSIFICATIONS.PROJECT_MUTATED]: CLASSIFICATIONS.CODEX_MUTATED_PROJECT
});

function manualActionFor(classification, inspectClassification) {
  switch (classification) {
    case CLASSIFICATIONS.PASS:
      return null;
    case CLASSIFICATIONS.MISSING_PROJECT:
      return "Register the requested project or correct the --project argument before retrying Step 6H.";
    case CLASSIFICATIONS.UNSAFE_PROJECT:
      return "Provide a project whose path resolves inside the configured allowed root before retrying Step 6H.";
    case CLASSIFICATIONS.NOT_INSTALLED:
      return "Install the Codex CLI in the activation environment and ensure `codex` resolves on PATH before retrying Step 6H.";
    case CLASSIFICATIONS.AUTH:
      return "Authenticate the Codex CLI (e.g. `codex login`), then retry Step 6H.";
    case CLASSIFICATIONS.USAGE_LIMIT:
      return "Codex usage limit reached. Wait until the reported reset time or add Codex credits, then retry Step 6H.";
    case CLASSIFICATIONS.TIMEOUT:
      return "Codex did not respond within the read-only inspect timeout; investigate availability before retrying.";
    case CLASSIFICATIONS.CRASH:
      return "Codex exec exited non-zero or crashed during the inspect; inspect the captured stderr before retrying.";
    case CLASSIFICATIONS.INTERACTIVE:
      return "Codex appears to require interactive approval; do not advance Step 6H until non-interactive exec is reliable.";
    case CLASSIFICATIONS.MARKER_MISSING:
      return `Codex inspect completed without emitting the marker (${READONLY_INSPECT_MARKER}); do not advance Step 6I.`;
    case CLASSIFICATIONS.MARKER_MALFORMED:
      return "Codex emitted the marker but the structured report failed validation; do not advance Step 6I.";
    case CLASSIFICATIONS.CODEX_MUTATED_PROJECT:
      return "Codex modified the fixture project during a read-only run; do not advance past Step 6H, treat as a serious safety regression.";
    case CLASSIFICATIONS.ARTIFACT_WRITE_FAILED:
      return "Hephaestus failed to write the Step 6H artifacts; inspect file system permissions and retry.";
    case CLASSIFICATIONS.FORBIDDEN_MUTATION:
      return "Step 6H detected unexpected project changes outside the allowed artifact paths; do not advance until the source is identified.";
    case CLASSIFICATIONS.STEP_6G_FAILED:
      return `Step 6G classification was ${inspectClassification}; resolve the upstream Step 6G blocker before retrying Step 6H.`;
    default:
      return "Unknown Step 6H classification; investigate before proceeding.";
  }
}

function defaultRunInspect(request) { return runCodexReadonlyInspect(request); }

function defaultNow() { return new Date().toISOString(); }

function assertRequestShape(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Readonly inspect record request must be an object.", "INVALID_READONLY_INSPECT_RECORD_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Readonly inspect record request contains an unsupported field: ${key}.`, "INVALID_READONLY_INSPECT_RECORD_REQUEST");
    }
  }
}

function safeReportNameFromTimestamp(timestamp) {
  const stamp = String(timestamp).replace(/[:.]/gu, "-").replace(/[^A-Za-z0-9_.\-]/gu, "-");
  const truncated = stamp.slice(0, 64);
  return `${RECORD_DEFAULT_PREFIX}-${truncated}.json`;
}

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

function bool(value) { return value ? "yes" : "no"; }

function buildAgentOutputMarkdown({ projectId, inspectReport, recordClassification, reportFileRelative, recordTimestamp }) {
  const files = inspectReport.report?.filesInspected ?? [];
  const summary = inspectReport.report?.summary ?? "";
  const inv = inspectReport.invocation;
  return [
    "# Hephaestus Step 6H — Read-only Codex inspection record",
    "",
    "This artifact records the output of a read-only Codex inspection.",
    "It is NOT implementation output. Codex was not allowed to write files.",
    "",
    `- Step: 6H (record)`,
    `- Recorded at: ${recordTimestamp}`,
    `- Project: ${projectId}`,
    `- Adapter: ${inspectReport.adapter}`,
    `- Source step: 6G`,
    `- Step 6G classification: ${inspectReport.classification}`,
    `- Step 6H classification: ${recordClassification}`,
    `- Marker captured: ${bool(inspectReport.markerCaptured)}`,
    `- Report valid: ${bool(inspectReport.reportValid)}`,
    `- Codex mutated project during run: ${bool(inspectReport.projectMutated)}`,
    `- Codex exit code: ${inspectReport.exitCode === null ? "n/a" : inspectReport.exitCode}`,
    `- Codex timed out: ${bool(inspectReport.timedOut)}`,
    `- Files inspected by Codex: ${files.length === 0 ? "(none)" : files.join(", ")}`,
    `- Codex summary: ${summary === "" ? "(none)" : summary}`,
    `- Companion JSON report: ${reportFileRelative}`,
    "",
    "## Safety invariants",
    `- shell: ${inv.shell === false ? "false (locked)" : "true (UNSAFE)"}`,
    `- sandbox: ${inv.sandbox}`,
    `- ask-for-approval: ${inv.askForApproval}`,
    `- dangerous bypass: ${bool(inv.dangerousBypass)}`,
    `- stdin policy: ${inv.stdinPolicy}`,
    `- env policy: ${inv.envPolicy}`,
    "",
    `## Next safe step`,
    recordClassification === CLASSIFICATIONS.PASS
      ? "Step 6I may be designed. No implementation prompt was sent to Codex."
      : "Resolve the Step 6H blocker before designing Step 6I.",
    ""
  ].join("\n");
}

function buildJsonReport({ projectId, inspectReport, recordClassification, recordTimestamp, reportFileRelative, agentOutputRelative }) {
  return {
    schema: "hephaestus.step-6h.readonly-inspect-record/v1",
    recordingStep: "6H",
    sourceStep: "6G",
    project: projectId,
    adapter: inspectReport.adapter,
    step6gClassification: inspectReport.classification,
    step6hClassification: recordClassification,
    markerCaptured: inspectReport.markerCaptured,
    reportValid: inspectReport.reportValid,
    projectMutatedDuringCodexRun: inspectReport.projectMutated,
    mutatedFilesDuringCodexRun: [...inspectReport.mutatedFiles],
    filesInspected: inspectReport.report?.filesInspected ? [...inspectReport.report.filesInspected] : [],
    summary: inspectReport.report?.summary ?? null,
    invocation: {
      shell: inspectReport.invocation.shell,
      sandbox: inspectReport.invocation.sandbox,
      askForApproval: inspectReport.invocation.askForApproval,
      dangerousBypass: inspectReport.invocation.dangerousBypass,
      stdinPolicy: inspectReport.invocation.stdinPolicy,
      envPolicy: inspectReport.invocation.envPolicy
    },
    stdout: inspectReport.stdout,
    stderr: inspectReport.stderr,
    exitCode: inspectReport.exitCode,
    timeoutMs: inspectReport.timeoutMs,
    timedOut: inspectReport.timedOut,
    createdAt: recordTimestamp,
    artifacts: {
      agentOutput: agentOutputRelative,
      jsonReport: reportFileRelative
    },
    nextSafeStep: recordClassification === CLASSIFICATIONS.PASS ? "6I (design only)" : null
  };
}

function freezeBlockedRecord({ adapter, projectId, allowedRoot, projectPath, classification, inspectReport, now }) {
  const timestamp = now();
  return Object.freeze({
    classification,
    adapter,
    project: Object.freeze({ id: projectId ?? null, allowedRoot: allowedRoot ?? null, resolvedPath: projectPath ?? null }),
    mode: "readonly-exec-inspect-record",
    step6gClassification: inspectReport?.classification ?? null,
    inspectReport: inspectReport ?? null,
    artifactsWritten: false,
    artifactPaths: Object.freeze({ agentOutput: null, jsonReport: null }),
    codexMutatedProject: Boolean(inspectReport?.projectMutated),
    codexMutatedFiles: Object.freeze([...(inspectReport?.mutatedFiles ?? [])]),
    forbiddenMutation: false,
    forbiddenMutatedFiles: Object.freeze([]),
    recordedAt: timestamp,
    step6iSafeToDesign: false,
    manualAction: manualActionFor(classification, inspectReport?.classification ?? null)
  });
}

/** Persist a validated Step 6G read-only Codex inspection as controlled Hephaestus project-local artifacts. */
export function runCodexReadonlyInspectRecord(request) {
  assertRequestShape(request);
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Readonly inspect record is only available for the codex adapter; received ${adapterId}.`, "READONLY_INSPECT_RECORD_ADAPTER_NOT_ALLOWED");
  if (request.explicitReadonlyInspectRecordPermit !== true) {
    fail("Readonly inspect record requires explicitReadonlyInspectRecordPermit=true.", "READONLY_INSPECT_RECORD_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Readonly inspect record requires allowedRoot.", "INVALID_READONLY_INSPECT_RECORD_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Readonly inspect record requires projectPath.", "INVALID_READONLY_INSPECT_RECORD_REQUEST");
  }
  if (typeof request.projectId !== "string" || !PROJECT_ID_PATTERN.test(request.projectId)) {
    fail("Readonly inspect record requires a safe projectId.", "INVALID_READONLY_INSPECT_RECORD_REQUEST");
  }
  if (request.reportName !== undefined && (typeof request.reportName !== "string" || !REPORT_NAME_PATTERN.test(request.reportName) || !request.reportName.endsWith(".json"))) {
    fail("Readonly inspect record reportName must be a safe filename ending in .json.", "INVALID_READONLY_INSPECT_RECORD_REQUEST");
  }

  const adapter = adapterId;
  const projectId = request.projectId;
  const allowedRoot = path.resolve(request.allowedRoot);
  const now = typeof request.now === "function" ? request.now : defaultNow;
  const runInspect = typeof request.runInspect === "function" ? request.runInspect : defaultRunInspect;

  let projectPath = null;
  let pathResolutionError = null;
  try {
    projectPath = resolveSafePath(allowedRoot, request.projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      pathResolutionError = { kind: "unsafe", error };
    } else {
      throw error;
    }
  }
  if (pathResolutionError === null && projectPath !== null) {
    if (!fs.existsSync(projectPath)) {
      pathResolutionError = { kind: "missing", error: null };
    } else {
      try {
        assertRealPathWithinRoot(allowedRoot, projectPath);
      } catch (error) {
        if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
          pathResolutionError = { kind: "unsafe", error };
        } else {
          throw error;
        }
      }
    }
  }

  const beforePipelineSnapshot = (pathResolutionError === null && projectPath !== null)
    ? snapshotAllProjectFiles(projectPath)
    : {};

  const inspectRequest = {
    adapterId: "codex",
    allowedRoot: request.allowedRoot,
    projectPath: request.projectPath,
    projectId,
    explicitReadonlyInspectPermit: true
  };
  if (request.env !== undefined) inspectRequest.env = request.env;
  if (request.spawn !== undefined) inspectRequest.spawn = request.spawn;
  if (request.timeoutMs !== undefined) inspectRequest.timeoutMs = request.timeoutMs;
  if (request.now !== undefined) inspectRequest.now = request.now;

  const inspectReport = runInspect(inspectRequest);

  if (pathResolutionError !== null) {
    const classification = pathResolutionError.kind === "unsafe"
      ? CLASSIFICATIONS.UNSAFE_PROJECT
      : CLASSIFICATIONS.MISSING_PROJECT;
    return freezeBlockedRecord({
      adapter, projectId, allowedRoot,
      projectPath: projectPath ?? null,
      classification, inspectReport, now
    });
  }

  if (inspectReport.classification !== INSPECT_CLASSIFICATIONS.PASS) {
    const mapped = INSPECT_TO_RECORD_CLASSIFICATION[inspectReport.classification] ?? CLASSIFICATIONS.STEP_6G_FAILED;
    return freezeBlockedRecord({
      adapter, projectId, allowedRoot,
      projectPath: projectPath ?? inspectReport.project?.resolvedPath ?? null,
      classification: mapped, inspectReport, now
    });
  }

  const recordTimestamp = now();
  const reportName = request.reportName ?? safeReportNameFromTimestamp(recordTimestamp);
  if (!REPORT_NAME_PATTERN.test(reportName) || !reportName.endsWith(".json")) {
    fail("Computed Step 6H report filename is unsafe.", "INVALID_READONLY_INSPECT_RECORD_REQUEST");
  }

  const reportFileRelative = `${RECORD_REPORT_DIRECTORY.split(path.sep).join("/")}/${reportName}`;
  const agentOutputRelative = RECORD_AGENT_OUTPUT_FILE;
  const agentOutputAbsolute = resolveSafePath(projectPath, RECORD_AGENT_OUTPUT_FILE);
  const reportFileAbsolute = resolveSafePath(projectPath, `${RECORD_REPORT_DIRECTORY}/${reportName}`);

  const allowedChangedPaths = new Set([agentOutputRelative, reportFileRelative]);

  let artifactWriteError = null;
  try {
    const reportDirAbsolute = path.dirname(reportFileAbsolute);
    fs.mkdirSync(reportDirAbsolute, { recursive: true });

    const jsonReport = buildJsonReport({
      projectId, inspectReport,
      recordClassification: CLASSIFICATIONS.PASS,
      recordTimestamp,
      reportFileRelative,
      agentOutputRelative
    });
    const agentOutputMarkdown = buildAgentOutputMarkdown({
      projectId, inspectReport,
      recordClassification: CLASSIFICATIONS.PASS,
      reportFileRelative,
      recordTimestamp
    });

    fs.writeFileSync(reportFileAbsolute, `${JSON.stringify(jsonReport, null, 2)}\n`, { encoding: "utf8" });
    fs.writeFileSync(agentOutputAbsolute, agentOutputMarkdown, { encoding: "utf8" });
  } catch (error) {
    artifactWriteError = error;
  }

  if (artifactWriteError !== null) {
    return freezeBlockedRecord({
      adapter, projectId, allowedRoot, projectPath,
      classification: CLASSIFICATIONS.ARTIFACT_WRITE_FAILED, inspectReport, now
    });
  }

  const postArtifactSnapshot = snapshotAllProjectFiles(projectPath);
  const changedPaths = diffSnapshots(beforePipelineSnapshot, postArtifactSnapshot);
  const forbiddenChanges = changedPaths.filter((entry) => !allowedChangedPaths.has(entry));
  if (forbiddenChanges.length > 0) {
    return Object.freeze({
      classification: CLASSIFICATIONS.FORBIDDEN_MUTATION,
      adapter,
      project: Object.freeze({ id: projectId, allowedRoot, resolvedPath: projectPath }),
      mode: "readonly-exec-inspect-record",
      step6gClassification: inspectReport.classification,
      inspectReport,
      artifactsWritten: false,
      artifactPaths: Object.freeze({ agentOutput: agentOutputRelative, jsonReport: reportFileRelative }),
      codexMutatedProject: false,
      codexMutatedFiles: Object.freeze([]),
      forbiddenMutation: true,
      forbiddenMutatedFiles: Object.freeze(forbiddenChanges),
      recordedAt: recordTimestamp,
      step6iSafeToDesign: false,
      manualAction: manualActionFor(CLASSIFICATIONS.FORBIDDEN_MUTATION, inspectReport.classification)
    });
  }

  return Object.freeze({
    classification: CLASSIFICATIONS.PASS,
    adapter,
    project: Object.freeze({ id: projectId, allowedRoot, resolvedPath: projectPath }),
    mode: "readonly-exec-inspect-record",
    step6gClassification: inspectReport.classification,
    inspectReport,
    artifactsWritten: true,
    artifactPaths: Object.freeze({ agentOutput: agentOutputRelative, jsonReport: reportFileRelative }),
    codexMutatedProject: false,
    codexMutatedFiles: Object.freeze([]),
    forbiddenMutation: false,
    forbiddenMutatedFiles: Object.freeze([]),
    recordedAt: recordTimestamp,
    step6iSafeToDesign: true,
    manualAction: null
  });
}
