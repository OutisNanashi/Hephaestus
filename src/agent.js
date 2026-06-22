import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { runSandboxCommand } from "./sandbox.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { saveState } from "./state.js";

const MAX_ATTEMPTS = 3;
const FIXTURE_ADAPTERS = Object.freeze({
  "fixture-agent": "fixture-agent",
  "fixture-agent-empty": "fixture-agent-empty",
  "fixture-agent-crash": "fixture-agent-crash",
  "fixture-agent-usage-limit": "fixture-agent-usage-limit"
});

function safePromptPath(projectPath, promptPath) {
  if (typeof promptPath !== "string" || promptPath.length === 0 || path.isAbsolute(promptPath) || promptPath.split(/[\\/]+/u).includes("..")) {
    fail("Agent prompt path must be a non-empty relative path without traversal.", "INVALID_AGENT_PROMPT_PATH");
  }
  const resolved = path.join(projectPath, promptPath);
  assertRealPathWithinRoot(projectPath, resolved);
  if (!fs.statSync(resolved).isFile()) fail("Agent prompt path must be a regular file.", "INVALID_AGENT_PROMPT_PATH");
  return resolved;
}

function writableProjectFile(projectPath, name) {
  const target = path.join(projectPath, name);
  if (fs.existsSync(target)) {
    assertRealPathWithinRoot(projectPath, target);
    if (!fs.statSync(target).isFile()) fail(`Project path is not a regular file: ${name}.`, "INVALID_PROJECT_FILE");
  }
  return target;
}

function appendLog(projectPath, line) {
  fs.appendFileSync(writableProjectFile(projectPath, "BUILD_LOG.md"), `\n${line}\n`, "utf8");
}

function outputFromReport(report) {
  return `${report.stdout}${report.stderr}`;
}

function stateForRunning(state) {
  if (state.nextAction === "agent-running") fail("The current task is already running.", "AGENT_TASK_ALREADY_RUNNING");
  if (state.usageLimitPaused || state.blocked) fail("The current project state is blocked or paused.", "AGENT_STATE_NOT_RUNNABLE");
  if (state.attemptCount >= MAX_ATTEMPTS) fail("Agent retry limit has been reached.", "AGENT_RETRY_LIMIT_REACHED");
  return { ...state, nextAction: "agent-running" };
}

function completedState(state) {
  return { ...state, blocked: false, usageLimitPaused: false, nextAction: "agent-completed", lastSuccessfulStep: "agent-run" };
}

function failedState(state, nextAction) {
  return { ...state, blocked: true, usageLimitPaused: false, attemptCount: state.attemptCount + 1, nextAction };
}

function pausedState(state) {
  return { ...state, blocked: false, usageLimitPaused: true, nextAction: "agent-usage-limit-paused" };
}

/** A process-backed fixture adapter whose process is always the sandboxed Docker command. */
export function runAgentTask({ allowedRoot, projectPath, adapterId, promptPath }) {
  if (!Object.hasOwn(FIXTURE_ADAPTERS, adapterId)) {
    fail(`Agent adapter is not available in the sandbox: ${adapterId}.`, "AGENT_ADAPTER_NOT_AVAILABLE");
  }
  const projectState = inspectProject(allowedRoot, projectPath);
  const deliveredPromptPath = safePromptPath(projectState.projectPath, promptPath);
  const runningState = stateForRunning(projectState.state);
  saveState(projectState.projectPath, runningState);

  const report = runSandboxCommand({
    allowedRoot,
    projectPath: projectState.projectPath,
    commandId: FIXTURE_ADAPTERS[adapterId]
  });
  const output = outputFromReport(report);
  let nextState;
  let status;
  if (/usage limit|rate limit|too many requests/iu.test(output)) {
    nextState = pausedState(runningState);
    status = "paused";
  } else if (output.trim() === "") {
    nextState = failedState(runningState, "agent-output-empty");
    status = "blocked";
  } else if (report.status !== "passed") {
    nextState = failedState(runningState, "agent-failed");
    status = "failed";
  } else {
    nextState = completedState(runningState);
    status = "completed";
  }

  if (output.trim() !== "") fs.writeFileSync(writableProjectFile(projectState.projectPath, "AGENT_OUTPUT.md"), output, "utf8");
  saveState(projectState.projectPath, nextState);
  appendLog(projectState.projectPath, `[phase-4-agent-run] adapter=${adapterId} status=${status} prompt=${path.basename(deliveredPromptPath)} exitCode=${report.exitCode}`);
  return Object.freeze({ status, adapterId, promptPath: deliveredPromptPath, output, report, state: nextState });
}
