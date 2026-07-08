import { getAdapter } from "./agent-adapters.js";
import { runAgentPreflight } from "./agent-preflight.js";
import { fail } from "./errors.js";
import { defineProviderAdapter, PROVIDER_RESULT_CLASSIFICATIONS } from "./provider-adapter-contract.js";

const PROVIDER_ID = "claude-code";

function claudeMetadata() {
  const metadata = getAdapter(PROVIDER_ID);
  if (metadata === null) fail("Claude Code adapter metadata is not registered.", "AGENT_ADAPTER_NOT_AVAILABLE");
  return metadata;
}

// Preflight-only Claude Code provider adapter.
//
// This adapter makes Claude Code a *known* provider so Hephaestus can inspect whether
// the `claude` CLI is installed and responding, and report why it is or is not runnable.
// It intentionally does NOT execute real Claude tasks: runTask returns a structured
// not-enabled result, and the adapter is declared liveExecutable: false so the provider
// registry never routes it for real work until a gated execution adapter is implemented.
//
// Preflight uses only the hardcoded harmless `claude --version` probe (via runAgentPreflight),
// which is non-spending and prints no secrets (all output passes through redaction). It never
// logs in, sends a prompt, or runs a task; detecting authentication is deferred to a future
// execution-capable step.
export const CLAUDE_CODE_PROVIDER_ADAPTER = defineProviderAdapter({
  id: PROVIDER_ID,
  displayName: "Claude Code",
  kind: "local-process",
  liveExecutable: false,
  capabilities: claudeMetadata().capabilities,
  preflight(request = {}) {
    return runAgentPreflight({ adapterId: PROVIDER_ID, ...request });
  },
  runTask() {
    return Object.freeze({
      provider: PROVIDER_ID,
      executed: false,
      supported: false,
      classification: PROVIDER_RESULT_CLASSIFICATIONS.PROVIDER_NOT_ENABLED,
      reason: "preflight-only",
      detail: "Claude Code is registered in preflight-only mode; task execution is not enabled yet.",
      manualAction: "Run provider preflight to confirm the claude CLI, then enable Claude Code execution once a gated adapter is implemented."
    });
  }
});
