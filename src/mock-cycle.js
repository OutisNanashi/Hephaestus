import fs from "node:fs";
import path from "node:path";
import { createBrainRequest, generateCodingPrompt } from "./brain.js";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { loadMockAgentOutput, requestMockDecision } from "./mock-provider.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { saveState } from "./state.js";

function assertWritableProjectFile(projectPath, fileName) {
  const filePath = path.join(projectPath, fileName);
  if (fs.existsSync(filePath)) {
    assertRealPathWithinRoot(projectPath, filePath);
    if (!fs.statSync(filePath).isFile()) fail(`Project path is not a regular file: ${fileName}.`, "INVALID_PROJECT_FILE");
  }
  return filePath;
}

function ensurePromptsDirectory(projectPath) {
  const outDirectory = path.join(projectPath, "out");
  const promptsDirectory = path.join(outDirectory, "prompts");
  for (const directory of [outDirectory, promptsDirectory]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    assertRealPathWithinRoot(projectPath, directory);
    if (!fs.statSync(directory).isDirectory()) fail("Prompt output path is not a directory.", "INVALID_PROMPT_DIRECTORY");
  }
  return promptsDirectory;
}

function appendBuildLog(projectPath, entry) {
  const buildLogPath = assertWritableProjectFile(projectPath, "BUILD_LOG.md");
  fs.appendFileSync(buildLogPath, `\n${entry}\n`, "utf8");
  return buildLogPath;
}

function failureState(state, message, retryable) {
  return {
    ...state,
    blocked: true,
    lastGptDecision: `mock-provider-failure: ${message}`,
    nextAction: retryable ? "retry-mock-gpt" : "manual-review-required"
  };
}

function decisionState(state, decision) {
  return {
    ...state,
    blocked: false,
    lastGptDecision: JSON.stringify(decision),
    nextAction: decision.nextAction
  };
}

/**
 * Perform exactly one local mocked cycle. All inputs are validated before the
 * successful-cycle writes begin; no command, process, or network action occurs.
 */
export function runMockCycle({ allowedRoot, projectPath, mockGptPath, mockAgentOutputPath }) {
  const projectState = inspectProject(allowedRoot, projectPath);
  const brainRequest = createBrainRequest(projectState);
  const providerResult = requestMockDecision(allowedRoot, mockGptPath);

  if (providerResult.kind === "failure") {
    const updatedState = failureState(projectState.state, providerResult.message, providerResult.retryable);
    const buildLogPath = appendBuildLog(
      projectState.projectPath,
      `[phase-2-mock-cycle] status=blocked retryable=${providerResult.retryable} reason=${providerResult.message}`
    );
    saveState(projectState.projectPath, updatedState);
    return Object.freeze({
      status: "blocked",
      projectPath: projectState.projectPath,
      brainRequest,
      state: updatedState,
      buildLogPath
    });
  }

  const prompt = generateCodingPrompt(brainRequest, providerResult.decision);
  const mockAgentOutput = loadMockAgentOutput(allowedRoot, mockAgentOutputPath);
  const promptsDirectory = ensurePromptsDirectory(projectState.projectPath);
  const promptPath = path.join(promptsDirectory, "next-task.md");
  if (fs.existsSync(promptPath)) assertRealPathWithinRoot(projectState.projectPath, promptPath);
  const agentOutputPath = assertWritableProjectFile(projectState.projectPath, "AGENT_OUTPUT.md");
  const updatedState = decisionState(projectState.state, providerResult.decision);

  fs.writeFileSync(promptPath, `${prompt}\n`, "utf8");
  fs.writeFileSync(agentOutputPath, mockAgentOutput.content, "utf8");
  const buildLogPath = appendBuildLog(
    projectState.projectPath,
    `[phase-2-mock-cycle] status=completed nextAction=${providerResult.decision.nextAction} prompt=${path.basename(promptPath)} agentOutput=${path.basename(mockAgentOutput.path)}`
  );
  saveState(projectState.projectPath, updatedState);
  return Object.freeze({
    status: "completed",
    projectPath: projectState.projectPath,
    brainRequest,
    decision: providerResult.decision,
    promptPath,
    agentOutputPath,
    buildLogPath,
    state: updatedState
  });
}
