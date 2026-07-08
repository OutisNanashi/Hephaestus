import { getAdapter } from "./agent-adapters.js";
import { runAgentPreflight } from "./agent-preflight.js";
import { fail } from "./errors.js";
import { defineProviderAdapter, PROVIDER_RESULT_CLASSIFICATIONS } from "./provider-adapter-contract.js";

const PROVIDER_ID = "cursor-agent";

function cursorMetadata() {
  const metadata = getAdapter(PROVIDER_ID);
  if (metadata === null) fail("Cursor Agent adapter metadata is not registered.", "AGENT_ADAPTER_NOT_AVAILABLE");
  return metadata;
}

// Preflight-only Cursor Agent (Grok 4.5) provider adapter.
//
// This adapter makes Cursor Agent a *known* provider so Hephaestus can inspect whether
// the `cursor-agent` CLI is installed and responding, and report why it is or is not
// runnable. It intentionally does NOT execute real Cursor tasks: runTask returns a
// structured not-enabled result, and the adapter is declared liveExecutable: false so the
// provider registry never routes it for real work until a gated execution adapter is
// implemented. Its intended model is Grok 4.5 (carried on the adapter as `intendedModel`),
// but no model is ever selected here — the exact `--model` string is verified only when a
// gated adapter ships. No Cursor/Grok credits are consumed by this lane.
//
// Preflight uses only the hardcoded harmless `cursor-agent --version` probe (via
// runAgentPreflight), which is non-spending and prints no secrets (all output passes
// through redaction). It never logs in (`cursor-agent login` is interactive/browser-based),
// sends a prompt, or runs a task; detecting authentication is deferred to a future
// execution-capable step.
export const CURSOR_AGENT_PROVIDER_ADAPTER = defineProviderAdapter({
  id: PROVIDER_ID,
  displayName: "Cursor Agent + Grok 4.5",
  kind: "local-process",
  liveExecutable: false,
  intendedModel: cursorMetadata().intendedModel,
  capabilities: cursorMetadata().capabilities,
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
      detail: "Cursor Agent is registered in preflight-only mode; task execution is not enabled yet.",
      manualAction: "Run provider preflight to confirm the cursor-agent CLI, then enable Cursor execution once a gated adapter with a verified Grok 4.5 --model contract is implemented."
    });
  }
});
