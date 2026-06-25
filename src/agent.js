import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  "fixture-agent-usage-limit": "fixture-agent-usage-limit",
  "fixture-agent-blocker": "fixture-agent-blocker",
  "fixture-agent-timeout": "fixture-agent-timeout"
});
const OUTPUT_SUMMARY_LIMIT = 240;

function safePromptPath({ allowedRoot, projectPath, promptPath }) {
  if (typeof promptPath !== "string" || promptPath.length === 0 || promptPath.split(/[\\/]+/u).includes("..")) {
    fail("Agent prompt path must be a non-empty relative path without traversal.", "INVALID_AGENT_PROMPT_PATH");
  }
  const projectRelative = path.isAbsolute(promptPath) ? promptPath : path.join(projectPath, promptPath);
  const resolved = fs.existsSync(projectRelative) ? projectRelative : path.resolve(promptPath);
  assertRealPathWithinRoot(allowedRoot, resolved);
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

function ensureAgentRunDirectory(projectPath) {
  const outDirectory = path.join(projectPath, "out");
  const agentRunDirectory = path.join(outDirectory, "agent_runs");
  const currentDirectory = path.join(agentRunDirectory, "current");
  for (const directory of [outDirectory, agentRunDirectory, currentDirectory]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    assertRealPathWithinRoot(projectPath, directory);
    if (!fs.statSync(directory).isDirectory()) fail("Agent run output path is not a directory.", "INVALID_AGENT_RUN_DIRECTORY");
  }
  return currentDirectory;
}

function readPrompt(promptPath) {
  const prompt = fs.readFileSync(promptPath, "utf8");
  if (prompt.trim() === "") fail("Agent prompt must not be empty.", "EMPTY_AGENT_PROMPT");
  return prompt;
}

function deliverPrompt(projectPath, prompt) {
  const runDirectory = ensureAgentRunDirectory(projectPath);
  const deliveredPromptPath = path.join(runDirectory, "prompt.md");
  if (fs.existsSync(deliveredPromptPath)) assertRealPathWithinRoot(projectPath, deliveredPromptPath);
  fs.writeFileSync(deliveredPromptPath, prompt, "utf8");
  return deliveredPromptPath;
}

function summarize(stdout, stderr) {
  const text = `${stdout}${stderr}`.replace(/\s+/gu, " ").trim();
  if (text === "") return "No output captured.";
  return text.length > OUTPUT_SUMMARY_LIMIT ? `${text.slice(0, OUTPUT_SUMMARY_LIMIT)}...` : text;
}

function agentDetails({ request, status, exitCode, startedAt, finishedAt, outputPath, outputSummary, usageLimitDetected, blockerDetected, errorCategory }) {
  return Object.freeze({
    lastRunId: request.runId,
    adapterId: request.adapterId,
    status,
    exitCode,
    startedAt,
    finishedAt,
    promptPath: path.relative(request.projectPath, request.deliveredPromptPath),
    outputPath: outputPath === null ? null : path.relative(request.projectPath, outputPath),
    outputSummary,
    usageLimitDetected,
    blockerDetected,
    errorCategory
  });
}

function stateForRunning(state, request, startedAt) {
  if (state.nextAction === "agent-running") fail("The current task is already running.", "AGENT_TASK_ALREADY_RUNNING");
  if (state.usageLimitPaused || state.blocked) fail("The current project state is blocked or paused.", "AGENT_STATE_NOT_RUNNABLE");
  if (state.attemptCount >= MAX_ATTEMPTS) fail("Agent retry limit has been reached.", "AGENT_RETRY_LIMIT_REACHED");
  return {
    ...state,
    nextAction: "agent-running",
    agent: agentDetails({
      request,
      status: "running",
      exitCode: null,
      startedAt,
      finishedAt: null,
      outputPath: null,
      outputSummary: "Agent run started.",
      usageLimitDetected: false,
      blockerDetected: false,
      errorCategory: null
    })
  };
}

function completedState(state, agent) {
  return { ...state, blocked: false, usageLimitPaused: false, nextAction: "agent-completed", lastSuccessfulStep: "agent-run", agent };
}

function failedState(state, nextAction, agent) {
  return { ...state, blocked: true, usageLimitPaused: false, attemptCount: state.attemptCount + 1, nextAction, agent };
}

function pausedState(state, agent) {
  return { ...state, blocked: false, usageLimitPaused: true, nextAction: "agent-usage-limit-paused", agent };
}

function statusFromReport(report, output) {
  const usageLimitDetected = /usage limit|rate limit|too many requests/iu.test(output);
  const blockerDetected = /(^|\n)\s*BLOCKED:/iu.test(output);
  if (usageLimitDetected) return { status: "paused", nextAction: "agent-usage-limit-paused", usageLimitDetected, blockerDetected, errorCategory: "usage-limit" };
  if (report.timedOut) return { status: "failed", nextAction: "agent-timeout", usageLimitDetected, blockerDetected, errorCategory: "timeout" };
  if (output.trim() === "") return { status: "blocked", nextAction: "agent-output-empty", usageLimitDetected, blockerDetected: true, errorCategory: "empty-output" };
  if (blockerDetected) return { status: "blocked", nextAction: "agent-blocked", usageLimitDetected, blockerDetected, errorCategory: "agent-blocker" };
  if (report.status !== "passed") return { status: "failed", nextAction: "agent-failed", usageLimitDetected, blockerDetected, errorCategory: "nonzero-exit" };
  return { status: "completed", nextAction: "agent-completed", usageLimitDetected, blockerDetected, errorCategory: null };
}

function markdownBlock(value) {
  return value.trim() === "" ? "(empty)" : value;
}

function writeAgentOutput(projectPath, result) {
  const destination = writableProjectFile(projectPath, "AGENT_OUTPUT.md");
  const content = `# Agent Output

Task id: ${result.taskId}
Run id: ${result.runId}
Adapter: ${result.adapterId}
Status: ${result.status}
Exit code: ${result.exitCode ?? "null"}
Usage limit detected: ${result.usageLimitDetected}
Blocker detected: ${result.blockerDetected}
Error category: ${result.errorCategory ?? "none"}

## Files Claimed Changed
- None

## Tests Claimed Run
- None

## Output Summary
${result.outputSummary}

## Stdout
\`\`\`text
${markdownBlock(result.stdout)}
\`\`\`

## Stderr
\`\`\`text
${markdownBlock(result.stderr)}
\`\`\`
`;
  fs.writeFileSync(destination, content, "utf8");
  return destination;
}

function createAgentRequest({ projectName, projectPath, adapterId, promptPath, deliveredPromptPath, prompt, timeoutMs = 5_000, envPolicy = "sandbox-safe" }) {
  return Object.freeze({
    projectName,
    projectPath,
    adapterId,
    promptPath,
    deliveredPromptPath,
    prompt,
    taskId: path.basename(projectPath),
    runId: `agent-${randomUUID()}`,
    allowedWorkingDirectory: projectPath,
    timeoutMs,
    environmentPolicy: envPolicy
  });
}

/** A process-backed fixture adapter whose process is always the sandboxed Docker command. */
export function runAgentTask({ allowedRoot, projectPath, adapterId, promptPath }) {
  if (!Object.hasOwn(FIXTURE_ADAPTERS, adapterId)) {
    fail(`Agent adapter is not available in the sandbox: ${adapterId}.`, "AGENT_ADAPTER_NOT_AVAILABLE");
  }
  const projectState = inspectProject(allowedRoot, projectPath);
  const sourcePromptPath = safePromptPath({ allowedRoot, projectPath: projectState.projectPath, promptPath });
  const prompt = readPrompt(sourcePromptPath);
  const deliveredPromptPath = deliverPrompt(projectState.projectPath, prompt);
  const startedAt = new Date().toISOString();
  const request = createAgentRequest({
    projectName: path.basename(projectState.projectPath),
    projectPath: projectState.projectPath,
    adapterId,
    promptPath: sourcePromptPath,
    deliveredPromptPath,
    prompt
  });
  const runningState = stateForRunning(projectState.state, request, startedAt);
  saveState(projectState.projectPath, runningState);

  const report = runSandboxCommand({
    allowedRoot,
    projectPath: projectState.projectPath,
    commandId: FIXTURE_ADAPTERS[adapterId]
  });
  const finishedAt = new Date().toISOString();
  const output = outputFromReport(report);
  const classification = statusFromReport(report, output);
  const result = Object.freeze({
    status: classification.status,
    adapterId,
    projectName: request.projectName,
    projectPath: projectState.projectPath,
    promptPath: sourcePromptPath,
    deliveredPromptPath,
    taskId: request.taskId,
    runId: request.runId,
    stdout: report.stdout,
    stderr: report.stderr,
    output,
    exitCode: report.exitCode,
    timedOut: report.timedOut,
    startedAt,
    finishedAt,
    outputSummary: summarize(report.stdout, report.stderr),
    usageLimitDetected: classification.usageLimitDetected,
    blockerDetected: classification.blockerDetected,
    errorCategory: classification.errorCategory,
    report
  });

  const agentOutputPath = writeAgentOutput(projectState.projectPath, result);
  const agent = agentDetails({ request, ...classification, exitCode: report.exitCode, startedAt, finishedAt, outputPath: agentOutputPath, outputSummary: result.outputSummary });
  const nextState = classification.status === "completed"
    ? completedState(runningState, agent)
    : classification.status === "paused"
      ? pausedState(runningState, agent)
      : failedState(runningState, classification.nextAction, agent);
  saveState(projectState.projectPath, nextState);
  appendLog(projectState.projectPath, `[phase-6a-agent-run] timestamp=${finishedAt} event=agent-run project=${request.projectName} adapter=${adapterId} status=${classification.status} exitCode=${report.exitCode ?? "null"} prompt=${path.relative(projectState.projectPath, deliveredPromptPath)} output=${path.relative(projectState.projectPath, agentOutputPath)} nextAction=${nextState.nextAction}`);
  return Object.freeze({ ...result, agentOutputPath, state: nextState });
}
