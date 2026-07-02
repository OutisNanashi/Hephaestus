import { fail } from "./errors.js";

// ponytail: single provider; keep as function-switch until a second provider ships (YAGNI).
// The mocked-readonly provider is offline by construction — no fetch, no net, no env, no fs.

export const STEP_6M_MARKER = "HEPHAESTUS_STEP_6M_PROVIDER_BRAIN_HANDOFF_OK";
export const STEP_6M_PROMPT_RELATIVE = "out/prompts/step-6m-provider-readonly-prompt.md";
export const STEP_6M_DECISION_SCHEMA = "hephaestus.step-6m.provider-brain-decision/v1";
export const STEP_6M_PHASE = "Activation Step 6M";
export const STEP_6M_PROVIDER = "mocked-readonly";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;

export const REQUIRED_FORBIDDEN_ACTIONS = Object.freeze([
  "write_files", "delete_files", "rename_files", "move_files",
  "run_mutating_commands", "network_access", "request_approval",
  "workspace_write", "arbitrary_prompt_execution", "autonomous_execution",
  "merge", "deploy", "real_gpt_call"
]);

export const REQUIRED_REPORT_KEYS = Object.freeze([
  "project", "readonly", "decision_type", "provider",
  "prompt_source", "files_inspected", "summary"
]);

const RECOGNIZED_FORBIDDEN_ACTIONS = new Set([...REQUIRED_FORBIDDEN_ACTIONS]);

const FORBIDDEN_DECISION_FIELDS = Object.freeze([
  "command", "shell", "executable", "argv", "cwd",
  "prompt", "promptFile", "autoApproval", "workspaceWrite",
  "merge", "deploy", "secrets", "env",
  "apiKey", "openaiApiKey", "model", "endpoint", "url", "fetch", "network"
]);

export function buildStep6mDecision(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    fail("Provider decision requires a safe projectId.", "INVALID_STEP_6M_PROJECT_ID");
  }
  return {
    schema: STEP_6M_DECISION_SCHEMA,
    provider: STEP_6M_PROVIDER,
    project: projectId,
    phase: STEP_6M_PHASE,
    decisionType: "READONLY_AGENT_PROMPT",
    adapter: "codex",
    mode: "read-only",
    allowedAction: "INSPECT_FIXTURE_ONLY",
    forbiddenActions: [...REQUIRED_FORBIDDEN_ACTIONS],
    requiredMarker: STEP_6M_MARKER,
    promptSource: STEP_6M_PROMPT_RELATIVE,
    expectedReportKeys: [...REQUIRED_REPORT_KEYS],
    realGptAllowed: false,
    workspaceWriteAllowed: false,
    arbitraryPromptAllowed: false,
    autonomousExecutionAllowed: false,
    nextSafeStep: "6N (design only)"
  };
}

export function validateStep6mDecision(candidate, expectedProjectId) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, reason: "not-an-object" };
  }
  for (const forbiddenField of FORBIDDEN_DECISION_FIELDS) {
    if (Object.hasOwn(candidate, forbiddenField)) return { ok: false, reason: `forbidden-field-${forbiddenField}` };
  }
  if (candidate.schema !== STEP_6M_DECISION_SCHEMA) return { ok: false, reason: "schema-mismatch" };
  if (candidate.provider !== STEP_6M_PROVIDER) return { ok: false, reason: "provider-mismatch" };
  if (candidate.project !== expectedProjectId) return { ok: false, reason: "project-mismatch" };
  if (candidate.phase !== STEP_6M_PHASE) return { ok: false, reason: "phase-mismatch" };
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
  if (candidate.requiredMarker !== STEP_6M_MARKER) return { ok: false, reason: "required-marker-mismatch" };
  if (candidate.promptSource !== STEP_6M_PROMPT_RELATIVE) return { ok: false, reason: "prompt-source-mismatch" };
  if (!Array.isArray(candidate.expectedReportKeys)) return { ok: false, reason: "expected-report-keys-not-array" };
  for (const required of REQUIRED_REPORT_KEYS) {
    if (!candidate.expectedReportKeys.includes(required)) return { ok: false, reason: `missing-expected-key-${required}` };
  }
  if (candidate.realGptAllowed !== false) return { ok: false, reason: "real-gpt-allowed-not-false" };
  if (candidate.workspaceWriteAllowed !== false) return { ok: false, reason: "workspace-write-allowed-not-false" };
  if (candidate.arbitraryPromptAllowed !== false) return { ok: false, reason: "arbitrary-prompt-allowed-not-false" };
  if (candidate.autonomousExecutionAllowed !== false) return { ok: false, reason: "autonomous-execution-allowed-not-false" };
  if (candidate.nextSafeStep !== "6N (design only)") return { ok: false, reason: "next-safe-step-mismatch" };
  return { ok: true, reason: null };
}

/** Factory for brain-decision providers. Only "mocked-readonly" is supported in Step 6M. */
export function createBrainDecisionProvider({ provider } = {}) {
  if (provider !== STEP_6M_PROVIDER) {
    fail(`Unsupported brain-decision provider: ${provider}. Only "${STEP_6M_PROVIDER}" is available in Step 6M.`, "STEP_6M_PROVIDER_UNSUPPORTED");
  }
  return Object.freeze({
    provider: STEP_6M_PROVIDER,
    getDecision({ projectId } = {}) {
      // Offline: pure function of projectId. No fetch, no fs, no env, no network.
      return buildStep6mDecision(projectId);
    }
  });
}
