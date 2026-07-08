import { getAdapter } from "./agent-adapters.js";
import { runCodexWorkspaceExec, WORKSPACE_CLASSIFICATIONS } from "./agent-codex-workspace-exec.js";
import { fail } from "./errors.js";
import { defineProviderAdapter } from "./provider-adapter-contract.js";

function codexMetadata() {
  const metadata = getAdapter("codex");
  if (metadata === null) fail("Codex adapter metadata is not registered.", "AGENT_ADAPTER_NOT_AVAILABLE");
  return metadata;
}

export const CODEX_PROVIDER_ADAPTER = defineProviderAdapter({
  id: "codex",
  displayName: "Codex",
  kind: "local-process",
  liveExecutable: true,
  capabilities: codexMetadata().capabilities,
  runTask(request) {
    return runCodexWorkspaceExec({ adapterId: "codex", ...request });
  },
  classifyResult(result) {
    return result?.classification ?? null;
  },
  detectUsageLimit(result) {
    return result?.classification === WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT || result?.usageLimitDetected === true;
  },
  collectArtifacts(result) {
    return Object.freeze({
      agentOutputPath: result?.agentOutputPath ?? null,
      reportPath: result?.reportPath ?? null
    });
  }
});
