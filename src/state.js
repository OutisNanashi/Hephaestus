import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

const REQUIRED_STATE_KEYS = [
  "currentPhase", "currentTask", "currentBranch", "currentPr", "assignedAgent",
  "attemptCount", "blocked", "usageLimitPaused", "lastSuccessfulStep",
  "mergeStatus", "containerStatus", "lastGptDecision", "nextAction"
];
const OPTIONAL_STATE_KEYS = new Set(["mergeGate", "agent"]);
const STRING_OR_NULL_KEYS = new Set(["currentPr", "assignedAgent", "lastSuccessfulStep", "lastGptDecision"]);

function validateMergeResult(result) {
  if (result === null) return null;
  const keys = ["project", "phase", "pr", "headCommit", "mergeCommit", "actor", "mergedAt", "gateReportPath"];
  if (!result || Array.isArray(result) || typeof result !== "object" || keys.some((key) => !(key in result)) || Object.keys(result).some((key) => !keys.includes(key))) fail("STATE.json merge result has an invalid schema.", "INVALID_STATE");
  for (const key of keys) if (typeof result[key] !== "string" || result[key].trim() === "") fail(`STATE.json merge result ${key} must be a non-empty string.`, "INVALID_STATE");
  return Object.freeze({ ...result });
}

function validateMergeGateDetails(mergeGate) {
  const keys = ["readiness", "implementationRetested", "nextPhaseEligible", "mergeResult"];
  if (!mergeGate || Array.isArray(mergeGate) || typeof mergeGate !== "object" || keys.some((key) => !(key in mergeGate)) || Object.keys(mergeGate).some((key) => !keys.includes(key))) fail("STATE.json mergeGate has an invalid schema.", "INVALID_STATE");
  if (!new Set(["not-run", "blocked", "allowed", "merged"]).has(mergeGate.readiness)) fail("STATE.json mergeGate readiness is invalid.", "INVALID_STATE");
  for (const key of ["implementationRetested", "nextPhaseEligible"]) if (typeof mergeGate[key] !== "boolean") fail(`STATE.json mergeGate ${key} must be a boolean.`, "INVALID_STATE");
  const mergeResult = validateMergeResult(mergeGate.mergeResult);
  if (mergeGate.nextPhaseEligible !== (mergeResult !== null)) fail("STATE.json mergeGate nextPhaseEligible must match merge result presence.", "INVALID_STATE");
  if (mergeGate.readiness === "merged" && mergeResult === null) fail("STATE.json mergeGate merged readiness requires a merge result.", "INVALID_STATE");
  if (mergeGate.readiness !== "merged" && mergeResult !== null) fail("STATE.json mergeGate merge result is only valid when readiness is merged.", "INVALID_STATE");
  return Object.freeze({ ...mergeGate, mergeResult });
}

function validateAgentDetails(agent) {
  const keys = ["lastRunId", "adapterId", "status", "exitCode", "startedAt", "finishedAt", "promptPath", "outputPath", "outputSummary", "usageLimitDetected", "blockerDetected", "errorCategory"];
  if (!agent || Array.isArray(agent) || typeof agent !== "object" || keys.some((key) => !(key in agent)) || Object.keys(agent).some((key) => !keys.includes(key))) fail("STATE.json agent has an invalid schema.", "INVALID_STATE");
  if (!["running", "completed", "blocked", "failed", "paused"].includes(agent.status)) fail("STATE.json agent status is invalid.", "INVALID_STATE");
  for (const key of ["lastRunId", "adapterId", "startedAt", "promptPath", "outputSummary"]) {
    if (typeof agent[key] !== "string" || agent[key].trim() === "") fail(`STATE.json agent ${key} must be a non-empty string.`, "INVALID_STATE");
  }
  for (const key of ["finishedAt", "outputPath", "errorCategory"]) {
    if (agent[key] !== null && (typeof agent[key] !== "string" || agent[key].trim() === "")) fail(`STATE.json agent ${key} must be a string or null.`, "INVALID_STATE");
  }
  if (agent.exitCode !== null && !Number.isSafeInteger(agent.exitCode)) fail("STATE.json agent exitCode must be an integer or null.", "INVALID_STATE");
  for (const key of ["usageLimitDetected", "blockerDetected"]) {
    if (typeof agent[key] !== "boolean") fail(`STATE.json agent ${key} must be a boolean.`, "INVALID_STATE");
  }
  return Object.freeze({ ...agent });
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
  const mergeGate = "mergeGate" in state ? validateMergeGateDetails(state.mergeGate) : undefined;
  const agent = "agent" in state ? validateAgentDetails(state.agent) : undefined;
  return Object.freeze({ ...state, ...(mergeGate === undefined ? {} : { mergeGate }), ...(agent === undefined ? {} : { agent }) });
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
  const serializedState = `${JSON.stringify(validatedState, null, 2)}\n`;
  let temporaryStatePath;
  try {
    rejectStateSymlink(statePath);
    const stateMode = existingStateMode(statePath);
    temporaryStatePath = path.join(resolvedProjectPath, `.STATE.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(temporaryStatePath, serializedState, {
      encoding: "utf8",
      flag: "wx",
      ...(stateMode === undefined ? {} : { mode: stateMode })
    });
    if (stateMode !== undefined) fs.chmodSync(temporaryStatePath, stateMode);
    rejectStateSymlink(statePath);
    try {
      fs.renameSync(temporaryStatePath, statePath);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      rejectStateSymlink(statePath);
      try { fs.unlinkSync(statePath); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
      rejectStateSymlink(statePath);
      fs.writeFileSync(statePath, serializedState, {
        encoding: "utf8",
        flag: "wx",
        ...(stateMode === undefined ? {} : { mode: stateMode })
      });
      if (stateMode !== undefined) fs.chmodSync(statePath, stateMode);
      fs.rmSync(temporaryStatePath, { force: true });
      temporaryStatePath = undefined;
    }
  } catch (error) {
    if (error?.code === "OUTSIDE_ALLOWED_ROOT") throw error;
    fail(`STATE.json could not be written: ${error.message}`, "STATE_WRITE_FAILED");
  } finally {
    if (temporaryStatePath) fs.rmSync(temporaryStatePath, { force: true });
  }
  return validatedState;
}
