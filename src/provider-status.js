import { runAgentPreflight } from "./agent-preflight.js";
import { getProviderAdapter, isProviderLiveExecutable } from "./provider-adapters.js";

const DEFAULT_PROVIDER = "codex";

/**
 * Read-only readiness description for a provider id under the current config. Never throws
 * for an unknown id (reports known:false) and never runs any external process, so it is
 * safe for ordinary status output. The four concepts are reported distinctly:
 *   - known:             the id resolves to a registered provider adapter
 *   - preflightSupported: the adapter advertises a safe availability probe
 *   - liveExecutable:    capability AND config both permit real task execution
 *   - reason:            why it is not live-executable (null when it is)
 */
export function describeProviderReadiness(providerId, { config = null } = {}) {
  const adapter = getProviderAdapter(providerId);
  const known = adapter !== null;
  const preflightSupported = known && adapter.capabilities.supportsPreflight === true;
  const liveExecutable = isProviderLiveExecutable(providerId, config);
  let reason = null;
  if (!liveExecutable) {
    if (!known) reason = "unknown-provider";
    else if (adapter.liveExecutable !== true) reason = "not-live-executable-capability";
    else reason = "disabled-by-config";
  }
  return Object.freeze({ known, preflightSupported, liveExecutable, reason });
}

/**
 * Structured, read-only provider status for one registry project. Reports the declared vs.
 * defaulted provider and its readiness. A preflight probe runs ONLY when preflight:true is
 * requested, and only the adapter's hardcoded harmless --version probe (via runAgentPreflight,
 * which redacts secrets); ordinary status never spawns a process. Injecting `spawn` lets tests
 * avoid invoking the real binary.
 */
export function projectProviderStatus(project, { config = null, preflight = false, spawn, env } = {}) {
  const provider = project.provider ?? DEFAULT_PROVIDER;
  const declared = project.providerDeclared === true;
  const readiness = describeProviderReadiness(provider, { config });
  const row = {
    id: project.id,
    path: project.path,
    provider,
    declaredProvider: declared ? provider : null,
    defaulted: !declared,
    known: readiness.known,
    preflightSupported: readiness.preflightSupported,
    liveExecutable: readiness.liveExecutable,
    reason: readiness.reason
  };
  if (preflight) {
    row.preflight = readiness.known && readiness.preflightSupported
      ? runAgentPreflight({ adapterId: provider, ...(spawn === undefined ? {} : { spawn }), ...(env === undefined ? {} : { env }) })
      : Object.freeze({ available: false, reason: readiness.known ? "preflight-not-supported" : "unknown-provider", promptSent: false });
  }
  return Object.freeze(row);
}

/** Deterministic provider-status rows for every project, sorted by id. Read-only. */
export function projectProviderStatuses(projects, options = {}) {
  const rows = projects.map((project) => projectProviderStatus(project, options));
  return Object.freeze([...rows].sort((left, right) => left.id.localeCompare(right.id)));
}
