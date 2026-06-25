import fs from "node:fs";
import path from "node:path";
import { HephaestusError, fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;
const PATH_ERROR_CODES = new Set(["OUTSIDE_ALLOWED_ROOT", "INVALID_PATH", "UNSAFE_PATH", "INVALID_PROJECT_PATH", "PATH_RESOLUTION_FAILED"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "allowedRoot", "projectPath", "projectId",
  "explicitCleanupPermit", "now"
]);

const CLEANUP_FILE_TARGETS = Object.freeze([
  Object.freeze({ kind: "exact", relative: "AGENT_OUTPUT.md" }),
  Object.freeze({ kind: "exact", relative: "out/prompts/step-6i-readonly-prompt.md" }),
  Object.freeze({ kind: "exact", relative: "out/summaries/step-6k-readonly-codex-closeout.json" })
]);

const CLEANUP_DIR_PATTERNS = Object.freeze([
  Object.freeze({ directory: "out/agent_outputs", pattern: /^step-6h-readonly-inspect-[A-Za-z0-9_.\-]+\.json$/u }),
  Object.freeze({ directory: "out/agent_outputs", pattern: /^step-6i-readonly-prompt-record-[A-Za-z0-9_.\-]+\.json$/u })
]);

const CLEANUP_EMPTY_DIRECTORIES = Object.freeze(["out/prompts", "out/agent_outputs", "out/summaries", "out"]);

const PROTECTED_PROJECT_FILES = Object.freeze([
  "PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "STATE.json", "CURRENT_TASK.md",
  "package.json", "package-lock.json"
]);

const PROTECTED_PROJECT_DIRS = Object.freeze(["src", "test"]);

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6J_PASS",
  PASS_NO_ARTIFACTS: "STEP_6J_PASS_NO_ARTIFACTS",
  UNSAFE_PROJECT: "STEP_6J_BLOCKED_UNSAFE_PROJECT",
  MISSING_PROJECT: "STEP_6J_BLOCKED_MISSING_PROJECT",
  CLEANUP_REFUSED: "STEP_6J_BLOCKED_CLEANUP_REFUSED",
  FORBIDDEN_TARGET: "STEP_6J_BLOCKED_FORBIDDEN_TARGET",
  DELETE_FAILED: "STEP_6J_BLOCKED_DELETE_FAILED",
  INVALID_REQUEST: "STEP_6J_BLOCKED_INVALID_REQUEST"
});

export const CLEANUP_WHITELIST = Object.freeze({
  exactFiles: Object.freeze(CLEANUP_FILE_TARGETS.map((entry) => entry.relative)),
  patternedDirectories: Object.freeze(CLEANUP_DIR_PATTERNS.map((entry) => Object.freeze({
    directory: entry.directory,
    pattern: entry.pattern.source
  }))),
  emptyDirectories: CLEANUP_EMPTY_DIRECTORIES
});

function defaultNow() { return new Date().toISOString(); }

function assertRequestShape(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Activation cleanup request must be an object.", "INVALID_CLEANUP_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Activation cleanup request contains an unsupported field: ${key}.`, "INVALID_CLEANUP_REQUEST");
    }
  }
}

function relativeWithSlashes(absolute, projectPath) {
  return path.relative(projectPath, absolute).split(path.sep).join("/");
}

function safeJoinUnderProject(projectPath, relative) {
  return resolveSafePath(projectPath, relative);
}

function deleteFileSafely(projectPath, relative, deleted, forbiddenTargets, refusedTargets) {
  let absolute;
  try {
    absolute = safeJoinUnderProject(projectPath, relative);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      forbiddenTargets.push(relative);
      return false;
    }
    throw error;
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    refusedTargets.push({ relative, reason: error?.code ?? "stat-failed" });
    return false;
  }
  if (!stat.isFile()) {
    refusedTargets.push({ relative, reason: "not-a-regular-file" });
    return false;
  }
  if (PROTECTED_PROJECT_FILES.includes(relative)) {
    forbiddenTargets.push(relative);
    return false;
  }
  if (PROTECTED_PROJECT_DIRS.some((dir) => relative.startsWith(`${dir}/`) || relative === dir)) {
    forbiddenTargets.push(relative);
    return false;
  }
  try {
    fs.unlinkSync(absolute);
    deleted.push(relative);
    return true;
  } catch (error) {
    refusedTargets.push({ relative, reason: error?.code ?? "unlink-failed" });
    return false;
  }
}

function listMatchingFiles(projectPath, directoryRelative, pattern, refusedTargets) {
  let absoluteDirectory;
  try {
    absoluteDirectory = safeJoinUnderProject(projectPath, directoryRelative);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) return [];
    throw error;
  }
  let entries;
  try {
    entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    refusedTargets.push({ relative: directoryRelative, reason: error?.code ?? "readdir-failed" });
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!pattern.test(entry.name)) continue;
    matches.push(`${directoryRelative}/${entry.name}`);
  }
  matches.sort();
  return matches;
}

function isDirectoryEmpty(projectPath, relative, refusedTargets) {
  let absolute;
  try {
    absolute = safeJoinUnderProject(projectPath, relative);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) return false;
    throw error;
  }
  let entries;
  try {
    entries = fs.readdirSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    refusedTargets.push({ relative, reason: error?.code ?? "readdir-failed" });
    return false;
  }
  return entries.length === 0;
}

function removeEmptyDirectorySafely(projectPath, relative, deletedDirs, refusedTargets) {
  if (!isDirectoryEmpty(projectPath, relative, refusedTargets)) return false;
  let absolute;
  try {
    absolute = safeJoinUnderProject(projectPath, relative);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) return false;
    throw error;
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    refusedTargets.push({ relative, reason: error?.code ?? "stat-failed" });
    return false;
  }
  if (!stat.isDirectory()) {
    refusedTargets.push({ relative, reason: "not-a-directory" });
    return false;
  }
  try {
    fs.rmdirSync(absolute);
    deletedDirs.push(relative);
    return true;
  } catch (error) {
    refusedTargets.push({ relative, reason: error?.code ?? "rmdir-failed" });
    return false;
  }
}

function freezeReport({ classification, projectId, allowedRoot, projectPath, deleted, deletedDirs, forbiddenTargets, refusedTargets, now }) {
  const timestamp = now();
  const cleanupSafe = classification === CLASSIFICATIONS.PASS || classification === CLASSIFICATIONS.PASS_NO_ARTIFACTS;
  return Object.freeze({
    classification,
    mode: "activation-fixture-hygiene",
    project: Object.freeze({ id: projectId ?? null, allowedRoot: allowedRoot ?? null, resolvedPath: projectPath ?? null }),
    cleanupSafe,
    deletedFiles: Object.freeze([...deleted]),
    deletedDirs: Object.freeze([...deletedDirs]),
    forbiddenTargets: Object.freeze([...forbiddenTargets]),
    refusedTargets: Object.freeze(refusedTargets.map((entry) => Object.freeze({ ...entry }))),
    whitelist: CLEANUP_WHITELIST,
    recordedAt: timestamp,
    step6kSafeToDesign: cleanupSafe,
    manualAction: manualActionFor(classification)
  });
}

function manualActionFor(classification) {
  switch (classification) {
    case CLASSIFICATIONS.PASS: return null;
    case CLASSIFICATIONS.PASS_NO_ARTIFACTS: return null;
    case CLASSIFICATIONS.MISSING_PROJECT:
      return "Register the requested project or correct the --project argument before retrying Step 6J.";
    case CLASSIFICATIONS.UNSAFE_PROJECT:
      return "Provide a project whose path resolves inside the configured allowed root before retrying Step 6J.";
    case CLASSIFICATIONS.FORBIDDEN_TARGET:
      return "Step 6J refused to act on a forbidden target; investigate before retrying.";
    case CLASSIFICATIONS.DELETE_FAILED:
      return "Step 6J failed to delete a whitelisted artifact; inspect filesystem permissions and retry.";
    case CLASSIFICATIONS.CLEANUP_REFUSED:
      return "Step 6J refused the cleanup due to unsafe conditions; investigate before retrying.";
    case CLASSIFICATIONS.INVALID_REQUEST:
      return "Step 6J rejected the cleanup request shape; correct the request before retrying.";
    default:
      return "Unknown Step 6J classification; investigate before proceeding.";
  }
}

/** Delete only the strictly whitelisted activation artifacts under a registered project; never touches anything else. */
export function runActivationFixtureCleanup(request) {
  assertRequestShape(request);
  if (request.explicitCleanupPermit !== true) {
    fail("Activation cleanup requires explicitCleanupPermit=true.", "CLEANUP_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Activation cleanup requires allowedRoot.", "INVALID_CLEANUP_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Activation cleanup requires projectPath.", "INVALID_CLEANUP_REQUEST");
  }
  if (typeof request.projectId !== "string" || !PROJECT_ID_PATTERN.test(request.projectId)) {
    fail("Activation cleanup requires a safe projectId.", "INVALID_CLEANUP_REQUEST");
  }

  const projectId = request.projectId;
  const allowedRoot = path.resolve(request.allowedRoot);
  const now = typeof request.now === "function" ? request.now : defaultNow;

  let projectPath = null;
  try {
    projectPath = resolveSafePath(allowedRoot, request.projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeReport({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath: null,
        deleted: [], deletedDirs: [], forbiddenTargets: [], refusedTargets: [], now
      });
    }
    throw error;
  }
  if (!fs.existsSync(projectPath)) {
    return freezeReport({
      classification: CLASSIFICATIONS.MISSING_PROJECT,
      projectId, allowedRoot, projectPath,
      deleted: [], deletedDirs: [], forbiddenTargets: [], refusedTargets: [], now
    });
  }
  try {
    assertRealPathWithinRoot(allowedRoot, projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeReport({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath,
        deleted: [], deletedDirs: [], forbiddenTargets: [], refusedTargets: [], now
      });
    }
    throw error;
  }

  const deleted = [];
  const deletedDirs = [];
  const forbiddenTargets = [];
  const refusedTargets = [];

  for (const target of CLEANUP_FILE_TARGETS) {
    deleteFileSafely(projectPath, target.relative, deleted, forbiddenTargets, refusedTargets);
  }

  for (const directoryTarget of CLEANUP_DIR_PATTERNS) {
    const matches = listMatchingFiles(projectPath, directoryTarget.directory, directoryTarget.pattern, refusedTargets);
    for (const match of matches) {
      deleteFileSafely(projectPath, match, deleted, forbiddenTargets, refusedTargets);
    }
  }

  for (const directoryRelative of CLEANUP_EMPTY_DIRECTORIES) {
    removeEmptyDirectorySafely(projectPath, directoryRelative, deletedDirs, refusedTargets);
  }

  if (forbiddenTargets.length > 0) {
    return freezeReport({
      classification: CLASSIFICATIONS.FORBIDDEN_TARGET,
      projectId, allowedRoot, projectPath,
      deleted, deletedDirs, forbiddenTargets, refusedTargets, now
    });
  }
  if (refusedTargets.some((entry) => entry.reason !== "stat-failed")) {
    const hasRealRefusal = refusedTargets.some((entry) => entry.reason !== "stat-failed" && entry.reason !== "readdir-failed");
    if (hasRealRefusal) {
      return freezeReport({
        classification: CLASSIFICATIONS.DELETE_FAILED,
        projectId, allowedRoot, projectPath,
        deleted, deletedDirs, forbiddenTargets, refusedTargets, now
      });
    }
  }

  const classification = (deleted.length === 0 && deletedDirs.length === 0)
    ? CLASSIFICATIONS.PASS_NO_ARTIFACTS
    : CLASSIFICATIONS.PASS;
  return freezeReport({
    classification, projectId, allowedRoot, projectPath,
    deleted, deletedDirs, forbiddenTargets, refusedTargets, now
  });
}

/** Convenience helper for tests that need a clean canonical fixture without invoking the CLI. */
export function ensureCleanFixture(allowedRoot, projectPath, projectId) {
  return runActivationFixtureCleanup({
    allowedRoot, projectPath, projectId,
    explicitCleanupPermit: true
  });
}
