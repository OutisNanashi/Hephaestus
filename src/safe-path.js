import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

function hasTraversalSegment(candidate) {
  return candidate.split(/[\\/]+/u).some((segment) => segment === "..");
}

function isPlatformAbsolute(candidate) {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

function assertPathInput(candidate, label) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.trim() !== candidate) {
    fail(`${label} must be a non-empty, trimmed string.`, "INVALID_PATH");
  }
  if (candidate.includes("\0") || hasTraversalSegment(candidate)) {
    fail(`${label} contains a forbidden path traversal or null byte.`, "UNSAFE_PATH");
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve a project path while retaining the configured root as a hard boundary.
 * Absolute paths are allowed only when they are already within that boundary.
 */
export function resolveSafePath(allowedRoot, candidate) {
  assertPathInput(allowedRoot, "Allowed root");
  assertPathInput(candidate, "Project path");

  const root = path.resolve(allowedRoot);
  const target = isPlatformAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);

  if (!isWithin(root, target)) {
    fail("Project path is outside the configured allowed root.", "OUTSIDE_ALLOWED_ROOT");
  }
  if (target === root) {
    fail("Project path must name a project directory below the allowed root.", "INVALID_PROJECT_PATH");
  }
  return target;
}

/** Reject an existing path whose symlink target escapes the configured root. */
export function assertRealPathWithinRoot(allowedRoot, target) {
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(allowedRoot);
    realTarget = fs.realpathSync(target);
  } catch (error) {
    fail(`Unable to resolve project path safely: ${error.message}`, "PATH_RESOLUTION_FAILED");
  }
  if (!isWithin(realRoot, realTarget)) {
    fail("Project path resolves outside the configured allowed root.", "OUTSIDE_ALLOWED_ROOT");
  }
  return realTarget;
}

/** Resolve a configuration-owned relative path without permitting traversal. */
export function resolveConfigPath(configDirectory, candidate, label) {
  assertPathInput(candidate, label);
  if (isPlatformAbsolute(candidate)) {
    fail(`${label} must be relative to the configuration file.`, "INVALID_CONFIG_PATH");
  }
  return path.resolve(configDirectory, candidate);
}
