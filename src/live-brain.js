import fs from "node:fs";
import path from "node:path";
import { createBrainRequest } from "./brain.js";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { requestOpenAIDecision } from "./openai-provider.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

const OPENAI_PROVIDERS = new Set(["openai", "gpt"]);
const MAX_PLAN_CONTEXT_CHARS = 6_000;
const MAX_AGENT_OUTPUT_CHARS = 2_000;
const REQUIRED_PROMPT_SECTIONS = Object.freeze([
  "Project name:",
  "Current phase:",
  "Current task:",
  "## Objective",
  "## Context Files To Read",
  "## Allowed Changes and Files",
  "## What To Build",
  "## What Not To Build Yet",
  "## Forbidden Changes",
  "## Required Tests",
  "## Required Evidence",
  "## Stop Conditions",
  "## Completion Criteria",
  "## Final Report Format"
]);

function safeAllowedFiles(projectPath, decision) {
  for (const file of decision.allowedFiles) {
    if (path.isAbsolute(file) || path.win32.isAbsolute(file)) fail("Provider allowedFiles must stay relative to the selected project.", "INVALID_PROVIDER_DECISION");
    if (file.split(/[\\/]+/u).some((segment) => /^\.env(?:\.|$)/iu.test(segment))) fail("Provider allowedFiles must not name environment files.", "INVALID_PROVIDER_DECISION");
    resolveSafePath(projectPath, file);
  }
  return decision;
}

function savePrompt(projectPath, prompt, promptOutputPath) {
  const destination = promptOutputPath ? path.resolve(promptOutputPath) : path.join(projectPath, "out", "prompts", "next-task.md");
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  assertRealPathWithinRoot(directory, directory);
  if (!promptOutputPath) {
    assertRealPathWithinRoot(projectPath, directory);
    if (fs.existsSync(destination)) assertRealPathWithinRoot(projectPath, destination);
  }
  fs.writeFileSync(destination, `${prompt}\n`, "utf8");
  return destination;
}

function providerInput(request, task, projectName) {
  const planContext = request.planContext.slice(0, MAX_PLAN_CONTEXT_CHARS);
  // The freshest agent report matters most, so keep its tail when truncating.
  const agentOutput = typeof request.agentOutput === "string" && request.agentOutput.trim() !== ""
    ? request.agentOutput.slice(-MAX_AGENT_OUTPUT_CHARS)
    : null;
  const agentSection = agentOutput === null ? "" : `\n\nLatest coding-agent report (decide whether the task is complete, needs repair, or is blocked):\n${agentOutput}`;
  return `Return only JSON with nextAction, rationale, allowedFiles, requiredTests, stopConditions, and loopSignal. loopSignal must be "continue" when the coding agent should run the planned task next, "task-complete" when the latest agent report shows the current task is finished and verified, or "blocked" when automation cannot safely proceed and the owner must act. Plan one bounded coding-agent task for project ${projectName}. Task: ${task}. allowedFiles must be relative project paths, never .env files. Do not include secrets, unrelated paths, command execution, or file edits by the model itself.\n\nGoal: ${request.projectGoal ?? "unspecified"}\nPhase: ${request.currentPhase}\nCurrent task: ${request.currentTask}\nPlan excerpt:\n${planContext}${agentSection}`;
}

function list(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function generateBoundedPrompt({ request, decision, requestedTask, projectName }) {
  const goal = request.projectGoal ?? "Unspecified; use the PLAN.md context below.";
  return `# Hephaestus bounded coding-agent prompt

Project name: ${projectName}
Project path: ${request.projectPath}
Project goal: ${goal}
Current phase: ${request.currentPhase}
Current task: ${requestedTask}

## Objective
Complete exactly this bounded task: ${decision.nextAction}

Rationale: ${decision.rationale}

## Context Files To Read
- PLAN.md
- STATE.json
- CURRENT_TASK.md
- package.json

## Allowed Changes and Files
${list(decision.allowedFiles)}

## What To Build
- The smallest project-local implementation needed for the objective.
- Only changes that fit the allowed files and the current task.

## What Not To Build Yet
- Do not implement anything beyond this bounded task.
- Do not start later PLAN.md phases or features that were not requested.

## Forbidden Changes
- Do not change files outside the allowed list.
- Do not read, reveal, modify, commit, or stage secrets or .env files.
- Do not modify PLAN.md, BUILDING_REFERENCE.md, STATE.json, CURRENT_TASK.md, BUILD_LOG.md, or TESTS.json; the conductor owns them.
- Do not merge, force push, deploy, or spend money.
- Do not bypass GPT approval, safety validation, or configured stop conditions.

## Required Tests
${list(decision.requiredTests)}

## Required Evidence
- Exact files changed.
- Exact test commands run with exit codes.
- Confirmation that no secrets were read, printed, changed, committed, or staged.
- Confirmation that no work occurred outside the selected project.
- Any blocker details needed for GPT approval.

## Stop Conditions
${list(decision.stopConditions)}
- Stop if a required file is missing.
- Stop if the task would require changes outside the allowed files.
- Stop if tests cannot be run or fail after one focused repair attempt.
- Stop if secrets, credentials, or files outside this project are needed.

## Completion Criteria
- Only the allowed files were changed.
- Required tests were run and passed.
- No secrets were read, printed, changed, committed, or staged.
- No work occurred outside the selected project.
- The final report clearly states changed files, tests run, and any blockers.

## Final Report Format
Return:
- Summary
- Files changed
- Tests run with exit codes
- Blockers, or "None"

## PLAN.md Context
${request.planContext}`;
}

function validatePromptShape(prompt) {
  if (REQUIRED_PROMPT_SECTIONS.some((section) => !prompt.includes(section))) {
    fail("Generated prompt is missing required bounded prompt sections.", "INVALID_GENERATED_PROMPT");
  }
  if (/openai[-_ ]?api[-_ ]?key|bearer\s+[a-z0-9._-]+/iu.test(prompt)) {
    fail("Generated prompt appears to contain secret material.", "INVALID_GENERATED_PROMPT");
  }
  return prompt;
}

function normalizeProvider(value) {
  if (value === undefined || value === null || value === "") return "openai";
  if (typeof value !== "string") fail("Live brain provider must be OpenAI/GPT.", "INVALID_BRAIN_PROVIDER");
  const provider = value.trim().toLowerCase();
  if (!OPENAI_PROVIDERS.has(provider)) fail("Live brain provider must be OpenAI/GPT.", "INVALID_BRAIN_PROVIDER");
  return "openai";
}

/** Call one approved provider and save only a bounded future-agent prompt; no agent or command is run. */
export async function runLiveBrainCycle({ allowedRoot, projectPath, brain, task, projectName = path.basename(projectPath), promptOutputPath, env = process.env, fetchImpl = globalThis.fetch }) {
  const provider = normalizeProvider(env.HEPHAESTUS_BRAIN_PROVIDER ?? brain?.provider);
  const apiKey = env.OPENAI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") fail("Missing required local environment variable: OPENAI_API_KEY.", "OPENAI_API_KEY_MISSING");
  if (!brain || typeof brain.model !== "string" || brain.model.trim() === "") fail("OpenAI brain configuration is required.", "INVALID_OPENAI_CONFIG");
  const projectState = inspectProject(allowedRoot, projectPath);
  const request = createBrainRequest(projectState);
  const requestedTask = typeof task === "string" && task.trim() !== "" ? task.trim() : request.currentTask;
  const input = providerInput(request, requestedTask, projectName);
  const decision = safeAllowedFiles(projectState.projectPath, await requestOpenAIDecision({ apiKey, model: brain.model, input, fetchImpl }));
  const prompt = validatePromptShape(generateBoundedPrompt({ request, decision, requestedTask, projectName }));
  return Object.freeze({ projectPath: projectState.projectPath, provider, decision, promptPath: savePrompt(projectState.projectPath, prompt, promptOutputPath), requestedTask });
}
