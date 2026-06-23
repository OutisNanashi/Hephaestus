import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

const REQUIRED_STATE_KEYS = [
  "currentPhase", "currentTask", "currentBranch", "currentPr", "assignedAgent",
  "attemptCount", "blocked", "usageLimitPaused", "lastSuccessfulStep", "reviewStatus",
  "mergeStatus", "containerStatus", "lastGptDecision", "nextAction"
];
const OPTIONAL_STATE_KEYS = new Set(["review", "mergeGate"]);
const STRING_OR_NULL_KEYS = new Set(["currentPr", "assignedAgent", "lastSuccessfulStep", "lastGptDecision"]);

function validateReviewDetails(review) {
  const keys = ["attempted", "ingestionStatus", "unresolvedBlockers", "dismissedCount", "resolvedCount", "activeSources", "unavailableSources", "mergeBlocked", "ingestedAt", "failureReason"];
  if (review === null || Array.isArray(review) || typeof review !== "object") fail("STATE.json review must be an object.", "INVALID_STATE");
  if (keys.some((key) => !(key in review)) || Object.keys(review).some((key) => !keys.includes(key))) fail("STATE.json review has an invalid schema.", "INVALID_STATE");
  if (typeof review.attempted !== "boolean" || typeof review.mergeBlocked !== "boolean") fail("STATE.json review flags must be booleans.", "INVALID_STATE");
  if (!["succeeded", "failed"].includes(review.ingestionStatus)) fail("STATE.json review ingestionStatus is invalid.", "INVALID_STATE");
  for (const key of ["unresolvedBlockers", "dismissedCount", "resolvedCount"]) if (!Number.isSafeInteger(review[key]) || review[key] < 0) fail(`STATE.json review ${key} must be a non-negative integer.`, "INVALID_STATE");
  for (const key of ["activeSources", "unavailableSources"]) {
    if (!Array.isArray(review[key]) || review[key].some((value) => typeof value !== "string" || value.trim() === "") || new Set(review[key]).size !== review[key].length) fail(`STATE.json review ${key} must be a unique string array.`, "INVALID_STATE");
  }
  for (const key of ["ingestedAt", "failureReason"]) if (review[key] !== null && (typeof review[key] !== "string" || review[key].trim() === "")) fail(`STATE.json review ${key} must be a string or null.`, "INVALID_STATE");
  return Object.freeze({ ...review, activeSources: Object.freeze([...review.activeSources]), unavailableSources: Object.freeze([...review.unavailableSources]) });
}

function validateMergeResult(result) {
  if (result === null) return null;
  const keys = ["project", "phase", "pr", "headCommit", "mergeCommit", "actor", "mergedAt", "gateReportPath"];
  if (!result || Array.isArray(result) || typeof result !== "object" || keys.some((key) => !(key in result)) || Object.keys(result).some((key) => !keys.includes(key))) fail("STATE.json merge result has an invalid schema.", "INVALID_STATE");
  for (const key of keys) if (typeof result[key] !== "string" || result[key].trim() === "") fail(`STATE.json merge result ${key} must be a non-empty string.`, "INVALID_STATE");
  return Object.freeze({ ...result });
}

function validateMergeGateDetails(mergeGate) {
  const keys = ["readiness", "implementationRetested", "reviewRetested", "nextPhaseEligible", "mergeResult"];
  if (!mergeGate || Array.isArray(mergeGate) || typeof mergeGate !== "object" || keys.some((key) => !(key in mergeGate)) || Object.keys(mergeGate).some((key) => !keys.includes(key))) fail("STATE.json mergeGate has an invalid schema.", "INVALID_STATE");
  if (!new Set(["not-run", "blocked", "allowed", "merged"]).has(mergeGate.readiness)) fail("STATE.json mergeGate readiness is invalid.", "INVALID_STATE");
  for (const key of ["implementationRetested", "reviewRetested", "nextPhaseEligible"]) if (typeof mergeGate[key] !== "boolean") fail(`STATE.json mergeGate ${key} must be a boolean.`, "INVALID_STATE");
  const mergeResult = validateMergeResult(mergeGate.mergeResult);
  if (mergeGate.nextPhaseEligible !== (mergeResult !== null)) fail("STATE.json mergeGate nextPhaseEligible must match merge result presence.", "INVALID_STATE");
  if (mergeGate.readiness === "merged" && mergeResult === null) fail("STATE.json mergeGate merged readiness requires a merge result.", "INVALID_STATE");
  if (mergeGate.readiness !== "merged" && mergeResult !== null) fail("STATE.json mergeGate merge result is only valid when readiness is merged.", "INVALID_STATE");
  return Object.freeze({ ...mergeGate, mergeResult });
}

export function validateState(state) {
  if (state === null || Array.isArray(state) || typeof state !== "object") {
    fail("STATE.json must contain an object.", "INVALID_STATE");
  }
  for (const key of REQUIRED_STATE_KEYS) {
    if (!(key in state)) {
      fail(`STATE.json is missing required key: ${key}.`, "INVALID_STATE");
    }
  }
  for (const key of Object.keys(state)) {
    if (!REQUIRED_STATE_KEYS.includes(key) && !OPTIONAL_STATE_KEYS.has(key)) {
      fail(`STATE.json contains unsupported key: ${key}.`, "INVALID_STATE");
    }
  }
  for (const key of REQUIRED_STATE_KEYS) {
    const value = state[key];
    if (STRING_OR_NULL_KEYS.has(key)) {
      if (value !== null && typeof value !== "string") fail(`STATE.json ${key} must be a string or null.`, "INVALID_STATE");
    } else if (key === "attemptCount") {
      if (!Number.isSafeInteger(value) || value < 0) fail("STATE.json attemptCount must be a non-negative integer.", "INVALID_STATE");
    } else if (key === "blocked" || key === "usageLimitPaused") {
      if (typeof value !== "boolean") fail(`STATE.json ${key} must be a boolean.`, "INVALID_STATE");
    } else if (typeof value !== "string" || value.length === 0) {
      fail(`STATE.json ${key} must be a non-empty string.`, "INVALID_STATE");
    }
  }
  const review = "review" in state ? validateReviewDetails(state.review) : undefined;
  const mergeGate = "mergeGate" in state ? validateMergeGateDetails(state.mergeGate) : undefined;
  return Object.freeze({ ...state, ...(review === undefined ? {} : { review }), ...(mergeGate === undefined ? {} : { mergeGate }) });
}

export function loadState(projectPath) {
  const statePath = path.join(projectPath, "STATE.json");
  let source;
  try {
    source = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    fail(`STATE.json could not be read: ${error.message}`, "FILE_READ_FAILED");
  }
  try {
    return validateState(JSON.parse(source));
  } catch (error) {
    if (error.code) throw error;
    fail(`STATE.json contains invalid JSON: ${error.message}`, "INVALID_JSON");
  }
}

function rejectStateSymlink(statePath) {
  try {
    if (fs.lstatSync(statePath).isSymbolicLink()) {
      fail("STATE.json must not be a symbolic link.", "OUTSIDE_ALLOWED_ROOT");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function existingStateMode(statePath) {
  try {
    const stateInfo = fs.lstatSync(statePath);
    if (stateInfo.isSymbolicLink()) {
      fail("STATE.json must not be a symbolic link.", "OUTSIDE_ALLOWED_ROOT");
    }
    return stateInfo.mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

/** Persist only a state object that still satisfies the Phase 0 schema. */
export function saveState(projectPath, state) {
  const validatedState = validateState(state);
  const resolvedProjectPath = assertRealPathWithinRoot(projectPath, projectPath);
  const statePath = path.join(resolvedProjectPath, "STATE.json");
  let temporaryDirectory;
  try {
    rejectStateSymlink(statePath);
    const stateMode = existingStateMode(statePath);
    temporaryDirectory = fs.mkdtempSync(path.join(resolvedProjectPath, ".state-write-"));
    const temporaryStatePath = path.join(temporaryDirectory, "STATE.json");
    fs.writeFileSync(temporaryStatePath, `${JSON.stringify(validatedState, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      ...(stateMode === undefined ? {} : { mode: stateMode })
    });
    if (stateMode !== undefined) fs.chmodSync(temporaryStatePath, stateMode);
    rejectStateSymlink(statePath);
    fs.renameSync(temporaryStatePath, statePath);
  } catch (error) {
    if (error?.code === "OUTSIDE_ALLOWED_ROOT") throw error;
    fail(`STATE.json could not be written: ${error.message}`, "STATE_WRITE_FAILED");
  } finally {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return validatedState;
}
