import { getAdapter } from "./agent-adapters.js";
import { runAgentPreflight } from "./agent-preflight.js";
import { fail } from "./errors.js";
import { defineProviderAdapter, PROVIDER_RESULT_CLASSIFICATIONS } from "./provider-adapter-contract.js";

const PROVIDER_ID = "factory-droid";

function factoryMetadata() {
  const metadata = getAdapter(PROVIDER_ID);
  if (metadata === null) fail("Factory Droid adapter metadata is not registered.", "AGENT_ADAPTER_NOT_AVAILABLE");
  return metadata;
}

// Preflight-only Factory Droid provider adapter.
//
// This adapter makes Factory Droid a *known* provider so Hephaestus can inspect whether
// the `droid` CLI is installed and responding, and report why it is or is not runnable.
// It intentionally does NOT execute real Factory tasks: runTask returns a structured
// not-enabled result, and the adapter is declared liveExecutable: false so the provider
// registry never routes it for real work until execution is explicitly implemented.
//
// Preflight uses only the hardcoded harmless `droid --version` probe (via runAgentPreflight),
// which is non-spending and prints no secrets (all output passes through redaction). No
// auth/config probe is issued because Factory has no guaranteed non-spending auth command;
// detecting authentication is deferred to a future execution-capable step.
export const FACTORY_DROID_PROVIDER_ADAPTER = defineProviderAdapter({
  id: PROVIDER_ID,
  displayName: "Factory Droid",
  kind: "local-process",
  liveExecutable: false,
  capabilities: factoryMetadata().capabilities,
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
      detail: "Factory Droid is registered in preflight-only mode; task execution is not enabled yet.",
      manualAction: "Run provider preflight to confirm the droid CLI, then enable Factory execution once it is implemented and gated."
    });
  }
});
