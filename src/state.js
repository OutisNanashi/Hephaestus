import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

const REQUIRED_STATE_KEYS = [
  "currentPhase", "currentTask", "currentBranch", "currentPr", "assignedAgent",
  "attemptCount", "blocked", "usageLimitPaused", "lastSuccessfulStep", "reviewStatus",
  "mergeStatus", "containerStatus", "lastGptDecision", "nextAction"
];
const STRING_OR_NULL_KEYS = new Set(["currentPr", "assignedAgent", "lastSuccessfulStep", "lastGptDecision"]);

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
    if (!REQUIRED_STATE_KEYS.includes(key)) {
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
  return Object.freeze({ ...state });
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

/** Persist only a state object that still satisfies the Phase 0 schema. */
export function saveState(projectPath, state) {
  const validatedState = validateState(state);
  const statePath = path.join(projectPath, "STATE.json");
  let resolvedWritePath;
  if (fs.existsSync(statePath)) {
    resolvedWritePath = assertRealPathWithinRoot(projectPath, statePath);
  } else {
    const resolvedProjectPath = assertRealPathWithinRoot(projectPath, projectPath);
    resolvedWritePath = path.join(resolvedProjectPath, "STATE.json");
  }
  try {
    fs.writeFileSync(resolvedWritePath, `${JSON.stringify(validatedState, null, 2)}\n`, "utf8");
  } catch (error) {
    fail(`STATE.json could not be written: ${error.message}`, "STATE_WRITE_FAILED");
  }
  return validatedState;
}
