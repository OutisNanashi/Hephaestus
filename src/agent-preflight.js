import { spawnSync } from "node:child_process";
import { fail } from "./errors.js";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { resolveSpawnTarget } from "./executable.js";

const PREFLIGHT_TIMEOUT_MS = 5_000;
const PREFLIGHT_OUTPUT_LIMIT = 200;
const SAFE_PREFLIGHT_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });

function clip(text) {
  const trimmed = text.replace(/\r/gu, "").split("\n")[0]?.trim() ?? "";
  if (trimmed === "") return "";
  return trimmed.length > PREFLIGHT_OUTPUT_LIMIT ? `${trimmed.slice(0, PREFLIGHT_OUTPUT_LIMIT)}...` : trimmed;
}

function preflightEnvironment(env) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  return { ...SAFE_PREFLIGHT_ENVIRONMENT, PATH: pathValue };
}

function defaultSpawn(executable, args, options) {
  // Resolve Windows npm shims (codex.cmd/.exe) so shell:false probing still finds them.
  const target = resolveSpawnTarget(executable, process.env);
  if (target === null) {
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error(`${executable} not found on PATH`), { code: "ENOENT" }) };
  }
  return spawnSync(target.command, [...target.prefixArgs, ...args], { ...options, shell: false });
}

/** Run a hardcoded harmless availability probe for a known adapter; never sends prompts or runs tasks. */
export function runAgentPreflight({ adapterId, env = process.env, spawn = defaultSpawn, now = () => new Date().toISOString() }) {
  const adapter = requireAdapter(adapterId);
  const startedAt = now();
  const baseReport = {
    adapterId: adapter.id,
    displayName: adapter.displayName,
    kind: adapter.kind,
    executionAllowed: adapter.executionAllowed,
    preflightSupported: adapter.preflightSupported,
    expectedExecutable: adapter.expectedExecutable,
    startedAt,
    finishedAt: startedAt,
    mutatedProjectFiles: false,
    promptSent: false
  };
  if (adapter.preflightSupported !== true || adapter.expectedExecutable === null) {
    return Object.freeze({
      ...baseReport,
      available: false,
      reason: "preflight-not-supported",
      detail: `Preflight is not required for adapter ${adapter.id}.`,
      exitCode: null,
      version: null,
      stderr: ""
    });
  }
  const executable = adapter.expectedExecutable;
  if (typeof executable !== "string" || executable.length === 0 || !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(executable)) {
    fail(`Adapter ${adapter.id} expected executable is unsafe.`, "UNSAFE_ADAPTER_EXECUTABLE");
  }
  let result;
  try {
    result = spawn(executable, ["--version"], {
      encoding: "utf8",
      timeout: PREFLIGHT_TIMEOUT_MS,
      killSignal: "SIGTERM",
      shell: false,
      env: preflightEnvironment(env)
    });
  } catch (error) {
    return Object.freeze({
      ...baseReport,
      finishedAt: now(),
      available: false,
      reason: "spawn-failed",
      detail: redactPreflightText(error instanceof Error ? error.message : String(error)),
      exitCode: null,
      version: null,
      stderr: ""
    });
  }
  const finishedAt = now();
  const stderr = redactPreflightText(result.stderr ?? "");
  const stdout = redactPreflightText(result.stdout ?? "");
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  if (result.error && (result.error.code === "ENOENT" || result.error.code === "EACCES")) {
    return Object.freeze({
      ...baseReport,
      finishedAt,
      available: false,
      reason: "executable-not-found",
      detail: `Adapter ${adapter.id} executable ${executable} is not installed or not on PATH.`,
      exitCode: null,
      version: null,
      stderr
    });
  }
  if (timedOut) {
    return Object.freeze({
      ...baseReport,
      finishedAt,
      available: false,
      reason: "timed-out",
      detail: `Adapter ${adapter.id} preflight timed out after ${PREFLIGHT_TIMEOUT_MS}ms.`,
      exitCode: null,
      version: null,
      stderr
    });
  }
  if (result.error) {
    return Object.freeze({
      ...baseReport,
      finishedAt,
      available: false,
      reason: "spawn-failed",
      detail: redactPreflightText(result.error.message),
      exitCode: result.status ?? null,
      version: null,
      stderr
    });
  }
  const exitCode = typeof result.status === "number" ? result.status : null;
  const version = clip(stdout) || clip(stderr) || "";
  return Object.freeze({
    ...baseReport,
    finishedAt,
    available: exitCode === 0,
    reason: exitCode === 0 ? "version-detected" : "nonzero-exit",
    detail: exitCode === 0 ? `Adapter ${adapter.id} responded to --version.` : `Adapter ${adapter.id} --version exited ${exitCode}.`,
    exitCode,
    version,
    stderr
  });
}
