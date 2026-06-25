import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactPreflightText, requireAdapter } from "./agent-adapters.js";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

export const SMOKE_PROMPT = "Hephaestus Codex smoke check. Do not edit files. Do not run commands. Reply with SMOKE_OK and a one sentence capability statement.";
const SMOKE_ARGV = Object.freeze(["--help"]);
const SMOKE_TIMEOUT_MS = 10_000;
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const OUTPUT_SUMMARY_LIMIT = 240;
const PROJECT_FILES_TO_HASH = Object.freeze(["PLAN.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "BUILDING_REFERENCE.md", "AGENT_OUTPUT.md"]);
const PROJECT_DIRS_TO_HASH = Object.freeze(["src", "test"]);
const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "allowedRoot", "projectPath", "env", "spawn",
  "autoApproval", "explicitSmokePermit", "timeoutMs", "now", "prompt"
]);

function defaultSpawn(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false });
}

function hashFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkProjectFiles(directory) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkProjectFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function snapshotProject(projectPath) {
  const entries = {};
  for (const name of PROJECT_FILES_TO_HASH) {
    entries[name] = hashFile(path.join(projectPath, name));
  }
  for (const directory of PROJECT_DIRS_TO_HASH) {
    const directoryPath = path.join(projectPath, directory);
    if (!fs.existsSync(directoryPath)) continue;
    for (const file of walkProjectFiles(directoryPath)) {
      const rel = path.relative(projectPath, file).split(path.sep).join("/");
      entries[rel] = hashFile(file);
    }
  }
  return entries;
}

function diffSnapshots(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

function classifySmoke({ exitCode, timedOut, stdout, stderr }) {
  const combined = `${stdout}${stderr}`;
  if (timedOut) return { status: "failed", reason: "timeout", timedOut: true, usageLimitDetected: false, blockerDetected: false };
  if (/usage limit|rate limit|too many requests/iu.test(combined)) {
    return { status: "paused", reason: "usage-limit", timedOut: false, usageLimitDetected: true, blockerDetected: false };
  }
  if (/(^|\n)\s*BLOCKED:/iu.test(combined)) {
    return { status: "blocked", reason: "blocker", timedOut: false, usageLimitDetected: false, blockerDetected: true };
  }
  if (typeof exitCode !== "number") return { status: "failed", reason: "spawn-failed", timedOut: false, usageLimitDetected: false, blockerDetected: false };
  if (exitCode !== 0) return { status: "failed", reason: "nonzero-exit", timedOut: false, usageLimitDetected: false, blockerDetected: false };
  if (/SMOKE_OK/u.test(combined)) return { status: "completed", reason: "smoke-ok", timedOut: false, usageLimitDetected: false, blockerDetected: false };
  return { status: "blocked", reason: "missing-smoke-ok", timedOut: false, usageLimitDetected: false, blockerDetected: false };
}

function summarize(text) {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed === "") return "No output captured.";
  return trimmed.length > OUTPUT_SUMMARY_LIMIT ? `${trimmed.slice(0, OUTPUT_SUMMARY_LIMIT)}...` : trimmed;
}

function assertRequestShape(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Smoke request must be an object.", "INVALID_SMOKE_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Smoke request contains an unsupported field: ${key}.`, "INVALID_SMOKE_REQUEST");
    }
  }
}

/** Run a hardcoded read-only smoke for the codex adapter; never runs a real coding task. */
export function runCodexSmoke(request) {
  assertRequestShape(request);
  const adapterId = request.adapterId ?? "codex";
  if (adapterId !== "codex") fail(`Smoke mode is only available for the codex adapter; received ${adapterId}.`, "SMOKE_ADAPTER_NOT_ALLOWED");
  const adapter = requireAdapter(adapterId);
  if (adapter.kind !== "real" || !adapter.preflightSupported || adapter.id !== "codex") {
    fail(`Adapter ${adapterId} cannot run a smoke check.`, "SMOKE_ADAPTER_NOT_ALLOWED");
  }
  if (request.explicitSmokePermit !== true) {
    fail("Smoke run requires explicitSmokePermit=true.", "SMOKE_PERMIT_REQUIRED");
  }
  if (request.autoApproval === true) {
    fail("Auto-approval is not permitted for smoke.", "REAL_AGENT_AUTO_APPROVAL_DISABLED");
  }
  if (request.prompt !== undefined && request.prompt !== SMOKE_PROMPT) {
    fail("Smoke run only accepts the hardcoded Hephaestus smoke prompt.", "SMOKE_PROMPT_NOT_ALLOWED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Smoke run requires allowedRoot.", "INVALID_SMOKE_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Smoke run requires projectPath.", "INVALID_SMOKE_REQUEST");
  }

  const allowedRoot = path.resolve(request.allowedRoot);
  const projectPath = resolveSafePath(allowedRoot, request.projectPath);
  assertRealPathWithinRoot(allowedRoot, projectPath);

  const env = request.env ?? process.env;
  const spawn = typeof request.spawn === "function" ? request.spawn : defaultSpawn;
  const now = typeof request.now === "function" ? request.now : () => new Date().toISOString();
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : SMOKE_TIMEOUT_MS;

  const startedAt = now();
  const snapshotBefore = snapshotProject(projectPath);
  const safeEnvironment = { LANG: SAFE_ENVIRONMENT.LANG, PATH: env.PATH ?? env.Path ?? env.path ?? "" };
  const executable = adapter.expectedExecutable;

  let result;
  let spawnError = null;
  try {
    result = spawn(executable, [...SMOKE_ARGV], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      env: safeEnvironment,
      cwd: projectPath
    });
  } catch (error) {
    spawnError = error;
    result = { status: null, stdout: "", stderr: "", error };
  }
  const finishedAt = now();

  const stdout = redactPreflightText(result.stdout ?? "");
  const stderr = redactPreflightText(result.stderr ?? "");
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";

  const baseReport = {
    adapterId: adapter.id,
    mode: "readonly-smoke",
    smokePrompt: SMOKE_PROMPT,
    promptKind: "smoke",
    executable,
    argv: SMOKE_ARGV,
    invocation: Object.freeze({ shell: false, autoApproval: false, envPolicy: "sandbox-safe (LANG, PATH)" }),
    startedAt,
    finishedAt,
    stdout,
    stderr
  };

  if (spawnError !== null) {
    return Object.freeze({
      ...baseReport,
      status: "failed",
      reason: "spawn-failed",
      detail: redactPreflightText(spawnError instanceof Error ? spawnError.message : String(spawnError)),
      exitCode: null,
      timedOut: false,
      usageLimitDetected: false,
      blockerDetected: false,
      promptSent: false,
      projectMutated: false,
      mutatedFiles: Object.freeze([])
    });
  }

  if (result.error && (result.error.code === "ENOENT" || result.error.code === "EACCES")) {
    return Object.freeze({
      ...baseReport,
      status: "unavailable",
      reason: "executable-not-found",
      detail: `Codex executable ${executable} is not installed or not on PATH.`,
      exitCode: null,
      timedOut: false,
      usageLimitDetected: false,
      blockerDetected: false,
      promptSent: false,
      projectMutated: false,
      mutatedFiles: Object.freeze([])
    });
  }

  const exitCode = typeof result.status === "number" ? result.status : null;
  const classification = classifySmoke({ exitCode, timedOut, stdout, stderr });

  const snapshotAfter = snapshotProject(projectPath);
  const mutatedFiles = diffSnapshots(snapshotBefore, snapshotAfter);
  const projectMutated = mutatedFiles.length > 0;

  const finalStatus = projectMutated ? "failed" : classification.status;
  const finalReason = projectMutated ? "project-mutated" : classification.reason;

  return Object.freeze({
    ...baseReport,
    status: finalStatus,
    reason: finalReason,
    detail: summarize(`${stdout}${stderr}`),
    exitCode,
    timedOut: classification.timedOut,
    usageLimitDetected: classification.usageLimitDetected,
    blockerDetected: classification.blockerDetected,
    promptSent: classification.status === "completed" && !projectMutated,
    projectMutated,
    mutatedFiles: Object.freeze(mutatedFiles)
  });
}
