import { fail } from "./errors.js";
import { CLAUDE_CODE_PROVIDER_ADAPTER } from "./claude-code-provider-adapter.js";
import { CODEX_PROVIDER_ADAPTER } from "./codex-provider-adapter.js";
import { FACTORY_DROID_PROVIDER_ADAPTER } from "./factory-droid-provider-adapter.js";

const PROVIDER_ADAPTERS = Object.freeze({
  codex: CODEX_PROVIDER_ADAPTER,
  "factory-droid": FACTORY_DROID_PROVIDER_ADAPTER,
  "claude-code": CLAUDE_CODE_PROVIDER_ADAPTER
});

export const PROVIDER_ADAPTER_IDS = Object.freeze(Object.keys(PROVIDER_ADAPTERS));

export function listProviderAdapters() {
  return Object.freeze(PROVIDER_ADAPTER_IDS.map((id) => PROVIDER_ADAPTERS[id]));
}

export function getProviderAdapter(adapterId) {
  return Object.hasOwn(PROVIDER_ADAPTERS, adapterId) ? PROVIDER_ADAPTERS[adapterId] : null;
}

export function requireProviderAdapter(adapterId) {
  const adapter = getProviderAdapter(adapterId);
  if (adapter === null) fail(`Provider adapter is not available: ${adapterId}.`, "PROVIDER_ADAPTER_NOT_AVAILABLE");
  return adapter;
}

/**
 * Whether config opts this provider into live execution. Config only *records intent*;
 * it can never override the adapter's intrinsic capability (that AND is applied by
 * isProviderLiveExecutable). Semantics:
 *   - no providers config, or no entry for this id  -> follow the adapter's own default
 *   - entry with executionEnabled boolean           -> use it verbatim
 *   - entry present but executionEnabled omitted     -> follow the adapter's own default
 * So a missing "providers" block cannot enable a provider whose capability is off, and a
 * provider already live by capability (Codex) stays live unless explicitly disabled.
 */
export function providerExecutionConfigured(adapterId, config = null) {
  const adapter = getProviderAdapter(adapterId);
  if (adapter === null) return false;
  const entry = config?.providers?.[adapterId];
  if (entry === undefined || entry.executionEnabled === undefined) return adapter.liveExecutable === true;
  return entry.executionEnabled === true;
}

/**
 * A provider is live-executable only when BOTH its adapter capability allows it AND config
 * opts in. Factory Droid (liveExecutable: false) can therefore never become live-executable
 * through config alone; enabling it in config is a no-op until a real execution adapter ships.
 */
export function isProviderLiveExecutable(adapterId, config = null) {
  const adapter = getProviderAdapter(adapterId);
  return adapter !== null && adapter.liveExecutable === true && providerExecutionConfigured(adapterId, config);
}

/** Ids of providers that may be routed for real task execution under the given config. */
export function listLiveExecutableProviderIds(config = null) {
  return Object.freeze(PROVIDER_ADAPTER_IDS.filter((id) => isProviderLiveExecutable(id, config)));
}

/**
 * Resolve a provider for real task execution, distinguishing the failure reasons clearly:
 *   - unknown provider id                         -> PROVIDER_ADAPTER_NOT_AVAILABLE
 *   - known provider that is not live-executable   -> PROVIDER_NOT_LIVE_EXECUTABLE
 * Preflight and inspection do NOT go through this gate, so known providers can still be
 * probed while live execution stays disabled.
 */
export function selectLiveProvider(adapterId, { config = null } = {}) {
  const adapter = getProviderAdapter(adapterId);
  if (adapter === null) {
    fail(`Provider adapter is not available: ${adapterId}.`, "PROVIDER_ADAPTER_NOT_AVAILABLE");
  }
  if (!isProviderLiveExecutable(adapterId, config)) {
    fail(`Provider is not live-executable: ${adapterId}.`, "PROVIDER_NOT_LIVE_EXECUTABLE");
  }
  return adapter;
}

export function runProviderTask(adapterId, request) {
  return requireProviderAdapter(adapterId).runTask(request);
}
