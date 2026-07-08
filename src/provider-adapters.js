import { fail } from "./errors.js";
import { CODEX_PROVIDER_ADAPTER } from "./codex-provider-adapter.js";
import { FACTORY_DROID_PROVIDER_ADAPTER } from "./factory-droid-provider-adapter.js";

const PROVIDER_ADAPTERS = Object.freeze({
  codex: CODEX_PROVIDER_ADAPTER,
  "factory-droid": FACTORY_DROID_PROVIDER_ADAPTER
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

/** Ids of providers that may be routed for real task execution (opt-in via liveExecutable). */
export function listLiveExecutableProviderIds() {
  return Object.freeze(PROVIDER_ADAPTER_IDS.filter((id) => PROVIDER_ADAPTERS[id].liveExecutable === true));
}

export function isProviderLiveExecutable(adapterId) {
  const adapter = getProviderAdapter(adapterId);
  return adapter !== null && adapter.liveExecutable === true;
}

export function runProviderTask(adapterId, request) {
  return requireProviderAdapter(adapterId).runTask(request);
}
