import { fail } from "./errors.js";

const CAPABILITY_DEFAULTS = Object.freeze({
  localProcess: false,
  localContainer: false,
  cloudSession: false,
  ideSession: false,
  headless: false,
  nonInteractive: false,
  longRunning: false,
  directPromptArg: false,
  stdinPrompt: false,
  promptFile: false,
  externalSessionInstruction: false,
  nativeSandbox: false,
  requiresContainer: false,
  supportsWorkspaceWrite: false,
  supportsReadOnly: false,
  protectedFileFingerprintingRequired: false,
  shellFalseSupported: false,
  safeEnvAllowlistSupported: false,
  stdoutCapture: false,
  stderrCapture: false,
  structuredReport: false,
  fileDiffCapture: false,
  externalUrlCapture: false,
  sessionTranscriptCapture: false,
  usageLimitDetectable: false,
  retryAfterDetectable: false,
  rateLimitIsProviderScoped: false,
  canEditWorktree: false,
  canCommit: false,
  canOpenPr: false,
  canMergeAfterApproval: false,
  conductorOwnsGit: true,
  canReceiveApprovalRelay: false,
  canPerformApprovedMerge: false,
  externalMergeOnly: false,
  supportsPreflight: false,
  supportsCleanup: false,
  supportsStatusPolling: false,
  supportsCancellation: false
});

export const PROVIDER_RESULT_CLASSIFICATIONS = Object.freeze({
  PASS: "PASS",
  ADAPTER_NOT_INSTALLED: "ADAPTER_NOT_INSTALLED",
  ADAPTER_NOT_AUTHENTICATED: "ADAPTER_NOT_AUTHENTICATED",
  USAGE_LIMIT: "USAGE_LIMIT",
  TIMEOUT: "TIMEOUT",
  EXIT_NONZERO: "EXIT_NONZERO",
  EMPTY_OUTPUT: "EMPTY_OUTPUT",
  AGENT_BLOCKER: "AGENT_BLOCKER",
  PROTECTED_FILES_MODIFIED: "PROTECTED_FILES_MODIFIED",
  INTERACTIVE_REQUIRED: "INTERACTIVE_REQUIRED",
  GIT_REPO_REQUIRED: "GIT_REPO_REQUIRED",
  SANDBOX_UNAVAILABLE: "SANDBOX_UNAVAILABLE",
  SANDBOX_DOWNGRADED: "SANDBOX_DOWNGRADED",
  CONFIG_INVALID: "CONFIG_INVALID",
  EXTERNAL_SESSION_PENDING: "EXTERNAL_SESSION_PENDING",
  EXTERNAL_SESSION_FAILED: "EXTERNAL_SESSION_FAILED"
});

export function defineProviderCapabilities(overrides = {}) {
  if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") {
    fail("Provider capabilities must be an object.", "INVALID_PROVIDER_CAPABILITIES");
  }
  const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(CAPABILITY_DEFAULTS, key));
  if (unknown.length > 0) {
    fail(`Provider capabilities contain unsupported keys: ${unknown.join(", ")}.`, "INVALID_PROVIDER_CAPABILITIES");
  }
  const capabilities = {};
  for (const [key, defaultValue] of Object.entries(CAPABILITY_DEFAULTS)) {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : defaultValue;
    if (typeof value !== "boolean") fail(`Provider capability ${key} must be a boolean.`, "INVALID_PROVIDER_CAPABILITIES");
    capabilities[key] = value;
  }
  return Object.freeze(capabilities);
}

function validateId(id) {
  return typeof id === "string" && /^[a-z][a-z0-9-]*$/u.test(id);
}

export function defineProviderAdapter(adapter) {
  if (!adapter || Array.isArray(adapter) || typeof adapter !== "object") {
    fail("Provider adapter must be an object.", "INVALID_PROVIDER_ADAPTER");
  }
  if (!validateId(adapter.id)) fail("Provider adapter id is invalid.", "INVALID_PROVIDER_ADAPTER");
  if (typeof adapter.displayName !== "string" || adapter.displayName.trim() === "") {
    fail("Provider adapter displayName is required.", "INVALID_PROVIDER_ADAPTER");
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object" || Array.isArray(adapter.capabilities)) {
    fail("Provider adapter capabilities are required.", "INVALID_PROVIDER_ADAPTER");
  }
  if (typeof adapter.runTask !== "function") fail("Provider adapter runTask is required.", "INVALID_PROVIDER_ADAPTER");
  return Object.freeze({
    id: adapter.id,
    displayName: adapter.displayName,
    kind: adapter.kind ?? "local-process",
    capabilities: Object.freeze({ ...adapter.capabilities }),
    preflight: typeof adapter.preflight === "function" ? adapter.preflight : null,
    runTask: adapter.runTask,
    classifyResult: typeof adapter.classifyResult === "function" ? adapter.classifyResult : (result) => result,
    detectUsageLimit: typeof adapter.detectUsageLimit === "function" ? adapter.detectUsageLimit : (result) => result?.usageLimitDetected === true,
    collectArtifacts: typeof adapter.collectArtifacts === "function" ? adapter.collectArtifacts : (result) => result?.artifacts ?? null,
    relayMergeApproval: typeof adapter.relayMergeApproval === "function" ? adapter.relayMergeApproval : null,
    cleanup: typeof adapter.cleanup === "function" ? adapter.cleanup : null,
    status: typeof adapter.status === "function" ? adapter.status : null
  });
}
