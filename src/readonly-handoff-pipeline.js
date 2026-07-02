// Shared read-only handoff pipeline utilities. Called only from src/brain-readonly-handoff.js
// (Step 6L) and src/brain-provider-readonly-handoff.js (Step 6M).
//
// This file MUST stay narrow. Explicitly not here:
//   - prompt templates, decision templates, argv builders (each caller pins its own strings)
//   - CLASSIFICATIONS enums (each caller has its own STEP_6L_* / STEP_6M_* string set)
//   - freeze/record shapes (each caller emits its own bespoke report)
//   - any provider selection, GPT/OpenAI/fetch code, network access, env-credential reads
//   - any workspace-write path

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactPreflightText } from "./agent-adapters.js";
import { fail } from "./errors.js";

export const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
export const OUTPUT_SUMMARY_LIMIT = 240;

export const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir", "--search", "-c"
]);
export const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write", "danger-full-access"]);

export const AUTH_REQUIRED_PATTERNS = Object.freeze([
  /please\s+(?:sign\s+in|log\s+in|login)/iu,
  /not\s+authenticated/iu,
  /authentication\s+required/iu,
  /run\s+`?codex\s+login`?/iu,
  /unauthorized/iu,
  /401\b/u
]);
export const USAGE_LIMIT_PATTERNS = Object.freeze([
  /you(?:'|`|’)?ve\s+hit\s+your\s+usage\s+limit/iu,
  /\busage\s+limit\b/iu,
  /purchase\s+more\s+credits/iu,
  /codex\/settings\/usage/iu,
  /\btry\s+again\s+at\b/iu,
  /\brate\s+limit\b/iu,
  /\btoo\s+many\s+requests\b/iu,
  /\bquota\s+exceeded\b/iu
]);
export const INTERACTIVE_PATTERNS = Object.freeze([
  /requires?\s+a\s+terminal/iu,
  /tty\s+required/iu,
  /interactive\s+mode\s+only/iu,
  /interactive\s+login\s+required/iu,
  /press\s+(?:enter|any\s+key)/iu,
  /waiting\s+for\s+approval/iu,
  /approval\s+required/iu
]);

// Abstract outcome codes. Each caller maps these to its own STEP_6X_BLOCKED_* enum value.
export const CODEX_OUTCOMES = Object.freeze({
  NOT_INSTALLED: "not-installed",
  TIMEOUT: "timeout",
  AUTH: "auth",
  USAGE_LIMIT: "usage-limit",
  INTERACTIVE: "interactive",
  CRASH: "crash"
});

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

function hashFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkAll(projectPath, currentDirectory, accumulator) {
  let entries;
  try { entries = fs.readdirSync(currentDirectory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) walkAll(projectPath, full, accumulator);
    else if (entry.isFile()) {
      const rel = path.relative(projectPath, full).split(path.sep).join("/");
      accumulator[rel] = hashFile(full);
    }
  }
}

/** SHA-256-hash every regular file under projectPath, skipping .git and node_modules. Returns { relPath: hash }. */
export function snapshotProjectFiles(projectPath) {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    fail("snapshotProjectFiles requires an absolute projectPath.", "INVALID_SNAPSHOT_ROOT");
  }
  const acc = {};
  walkAll(projectPath, projectPath, acc);
  return acc;
}

/** Sorted list of relative paths whose hash changed between before and after (present-only, absent-only, or different). */
export function diffSnapshots(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) if (before[key] !== after[key]) changed.push(key);
  return changed.sort();
}

/** Returns changed relative paths NOT in allowedRelativePaths (Set or iterable). Empty array = only allowed paths changed. */
export function disallowedChanges(delta, allowedRelativePaths) {
  const allowed = allowedRelativePaths instanceof Set ? allowedRelativePaths : new Set(allowedRelativePaths);
  return delta.filter((entry) => !allowed.has(entry));
}

/**
 * Write `content` (utf8) to `absolutePath`, read back, byte-compare, hash. Returns:
 *   { ok: true, hash, matches: true } on success
 *   { ok: false, stage: "write"|"readback"|"mismatch", hash?: string } on failure
 * Caller is responsible for having already resolved absolutePath through resolveSafePath.
 */
export function writeAndReadBack({ absolutePath, content }) {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    fail("writeAndReadBack requires an absolute path.", "INVALID_WRITE_PATH");
  }
  if (typeof content !== "string") {
    fail("writeAndReadBack requires string content.", "INVALID_WRITE_CONTENT");
  }
  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, { encoding: "utf8" });
  } catch {
    return { ok: false, stage: "write" };
  }
  let readback;
  try {
    readback = fs.readFileSync(absolutePath, { encoding: "utf8" });
  } catch {
    return { ok: false, stage: "readback" };
  }
  const hash = createHash("sha256").update(readback).digest("hex");
  if (readback !== content) return { ok: false, stage: "mismatch", hash };
  return { ok: true, hash, matches: true, readback };
}

/**
 * Spawn Codex with hardcoded read-only safety envelope. Callers pass an already-built argv (they own its shape).
 * Options are locked here: shell:false, input:"" (closed stdin), reduced env {LANG, PATH}, killSignal SIGTERM, timeoutMs.
 * Returns a frozen result with redacted stdout/stderr and derived flags.
 */
export function runReadonlyCodex({ argv, projectPath, env, timeoutMs, spawn, marker }) {
  if (!Array.isArray(argv) || argv.length === 0) fail("runReadonlyCodex requires an argv array.", "INVALID_CODEX_ARGV");
  if (typeof projectPath !== "string" || projectPath.length === 0) fail("runReadonlyCodex requires projectPath.", "INVALID_CODEX_CWD");
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("runReadonlyCodex requires a positive timeoutMs.", "INVALID_CODEX_TIMEOUT");
  if (typeof marker !== "string" || marker.length === 0) fail("runReadonlyCodex requires a non-empty marker.", "INVALID_CODEX_MARKER");
  const spawnFn = typeof spawn === "function" ? spawn : ((exe, args, options) => spawnSync(exe, args, { ...options, shell: false }));
  const safeEnvironment = {
    LANG: SAFE_ENVIRONMENT.LANG,
    PATH: env?.PATH ?? env?.Path ?? env?.path ?? ""
  };
  let result, spawnError = null;
  try {
    result = spawnFn("codex", [...argv], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      env: safeEnvironment,
      cwd: projectPath,
      input: ""
    });
  } catch (error) {
    spawnError = error;
    result = { status: null, stdout: "", stderr: "", error };
  }
  const stdout = redactPreflightText(result.stdout ?? "");
  const stderr = redactPreflightText(result.stderr ?? "");
  const errorCode = spawnError?.code ?? result.error?.code ?? null;
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  const exitCode = typeof result.status === "number" ? result.status : null;
  const combined = `${stdout}${stderr}`;
  return Object.freeze({
    spawnError, errorCode, timedOut, exitCode,
    stdout, stderr, combined,
    markerInOutput: combined.includes(marker)
  });
}

/** Classify a Codex outcome into an abstract CODEX_OUTCOMES value, or null when Codex ran to a clean exit=0. */
export function classifyCodexOutcome(codexResult) {
  if (codexResult.spawnError !== null || codexResult.errorCode === "ENOENT" || codexResult.errorCode === "EACCES") {
    return CODEX_OUTCOMES.NOT_INSTALLED;
  }
  if (codexResult.timedOut) return CODEX_OUTCOMES.TIMEOUT;
  if (AUTH_REQUIRED_PATTERNS.some((rx) => rx.test(codexResult.combined))) return CODEX_OUTCOMES.AUTH;
  if (USAGE_LIMIT_PATTERNS.some((rx) => rx.test(codexResult.combined))) return CODEX_OUTCOMES.USAGE_LIMIT;
  if (INTERACTIVE_PATTERNS.some((rx) => rx.test(codexResult.combined))) return CODEX_OUTCOMES.INTERACTIVE;
  if (typeof codexResult.exitCode !== "number" || codexResult.exitCode !== 0) return CODEX_OUTCOMES.CRASH;
  return null;
}

/** Collapse whitespace, trim, cap at OUTPUT_SUMMARY_LIMIT chars. Empty text → "No output captured." */
export function summarizeOutput(text) {
  const trimmed = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (trimmed === "") return "No output captured.";
  return trimmed.length > OUTPUT_SUMMARY_LIMIT ? `${trimmed.slice(0, OUTPUT_SUMMARY_LIMIT)}...` : trimmed;
}

/** SHA-256 of a utf8 string. Tiny wrapper for callers that hash an already-in-memory decision/prompt. */
export function sha256Hex(content) {
  return createHash("sha256").update(String(content)).digest("hex");
}
