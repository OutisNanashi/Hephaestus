import { fail } from "./errors.js";
import { CODEX_PROVIDER_ADAPTER } from "./codex-provider-adapter.js";

const PROVIDER_ADAPTERS = Object.freeze({
  codex: CODEX_PROVIDER_ADAPTER
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

export function runProviderTask(adapterId, request) {
  return requireProviderAdapter(adapterId).runTask(request);
}
