import { fail } from "./errors.js";

const REAL_AGENT_REASON = "Real coding agents do not run through the generic fixture sandbox path; Codex runs via the dedicated workspace exec module.";

const ADAPTERS = Object.freeze({
  "fixture-agent": Object.freeze({
    id: "fixture-agent", displayName: "Fixture Agent", kind: "fixture",
    executionAllowed: true, preflightSupported: false, defaultEnabled: true,
    disabledReason: null, expectedExecutable: null, fixtureCommandId: "fixture-agent"
  }),
  "fixture-agent-empty": Object.freeze({
    id: "fixture-agent-empty", displayName: "Fixture Agent (empty output)", kind: "fixture",
    executionAllowed: true, preflightSupported: false, defaultEnabled: true,
    disabledReason: null, expectedExecutable: null, fixtureCommandId: "fixture-agent-empty"
  }),
  "fixture-agent-crash": Object.freeze({
    id: "fixture-agent-crash", displayName: "Fixture Agent (crash)", kind: "fixture",
    executionAllowed: true, preflightSupported: false, defaultEnabled: true,
    disabledReason: null, expectedExecutable: null, fixtureCommandId: "fixture-agent-crash"
  }),
  "fixture-agent-usage-limit": Object.freeze({
    id: "fixture-agent-usage-limit", displayName: "Fixture Agent (usage limit)", kind: "fixture",
    executionAllowed: true, preflightSupported: false, defaultEnabled: true,
    disabledReason: null, expectedExecutable: null, fixtureCommandId: "fixture-agent-usage-limit"
  }),
  "fixture-agent-blocker": Object.freeze({
    id: "fixture-agent-blocker", displayName: "Fixture Agent (blocker)", kind: "fixture",
    executionAllowed: true, preflightSupported: false, defaultEnabled: true,
    disabledReason: null, expectedExecutable: null, fixtureCommandId: "fixture-agent-blocker"
  }),
  "fixture-agent-timeout": Object.freeze({
    id: "fixture-agent-timeout", displayName: "Fixture Agent (timeout)", kind: "fixture",
    executionAllowed: true, preflightSupported: false, defaultEnabled: true,
    disabledReason: null, expectedExecutable: null, fixtureCommandId: "fixture-agent-timeout"
  }),
  codex: Object.freeze({
    id: "codex", displayName: "Codex", kind: "real",
    executionAllowed: false, preflightSupported: true, defaultEnabled: false,
    disabledReason: REAL_AGENT_REASON, expectedExecutable: "codex", fixtureCommandId: null
  }),
  "claude-code": Object.freeze({
    id: "claude-code", displayName: "Claude Code", kind: "real",
    executionAllowed: false, preflightSupported: true, defaultEnabled: false,
    disabledReason: REAL_AGENT_REASON, expectedExecutable: "claude", fixtureCommandId: null
  }),
  opencode: Object.freeze({
    id: "opencode", displayName: "OpenCode", kind: "real",
    executionAllowed: false, preflightSupported: true, defaultEnabled: false,
    disabledReason: REAL_AGENT_REASON, expectedExecutable: "opencode", fixtureCommandId: null
  })
});

export const ADAPTER_IDS = Object.freeze(Object.keys(ADAPTERS));

export function listAdapters() {
  return Object.freeze(ADAPTER_IDS.map((id) => ADAPTERS[id]));
}

export function getAdapter(adapterId) {
  return Object.hasOwn(ADAPTERS, adapterId) ? ADAPTERS[adapterId] : null;
}

export function requireAdapter(adapterId) {
  const adapter = getAdapter(adapterId);
  if (adapter === null) fail(`Agent adapter is not available in the sandbox: ${adapterId}.`, "AGENT_ADAPTER_NOT_AVAILABLE");
  return adapter;
}

export function assertExecutionAllowed(adapter) {
  if (adapter.kind !== "fixture" || adapter.executionAllowed !== true) {
    fail(`Real coding-agent execution is disabled for adapter ${adapter.id}.`, "REAL_AGENT_EXECUTION_DISABLED");
  }
}

const SECRET_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9_-]{16,}/gu,
  /ghp_[A-Za-z0-9]{20,}/gu,
  /xox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /AKIA[0-9A-Z]{12,}/gu,
  /(?:api[-_ ]?key|token|secret|bearer)\s*[:=\s]\s*[A-Za-z0-9._\-+/]{12,}/giu
]);

export function redactPreflightText(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}
