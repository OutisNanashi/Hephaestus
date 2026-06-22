import { fail } from "./errors.js";

function projectGoal(plan) {
  const heading = plan.split(/\r?\n/u).find((line) => /^#+\s+\S/u.test(line));
  return heading ? heading.replace(/^#+\s+/u, "").trim() : null;
}

/** Create a deterministic, read-only request for the mocked Phase 2 brain. */
export function createBrainRequest(projectState) {
  if (!projectState || typeof projectState !== "object") {
    fail("A normalized project state is required to create a brain request.", "INVALID_PROJECT_STATE");
  }
  return Object.freeze({
    projectPath: projectState.projectPath,
    projectGoal: projectGoal(projectState.documents.plan),
    planContext: projectState.documents.plan,
    currentPhase: projectState.currentPhase,
    currentTask: projectState.currentTask,
    uncertainty: projectState.uncertainty
  });
}

function validateStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    fail(`Mock GPT decision ${name} must be a non-empty array of strings.`, "INVALID_MOCK_DECISION");
  }
  return Object.freeze([...value]);
}

/** Validate all decision content before it can influence any project write. */
export function validateMockDecision(decision) {
  if (decision === null || Array.isArray(decision) || typeof decision !== "object") {
    fail("Mock GPT decision must be a JSON object.", "INVALID_MOCK_DECISION");
  }
  const required = ["nextAction", "rationale", "allowedFiles", "requiredTests", "stopConditions"];
  for (const key of required) {
    if (!(key in decision)) fail(`Mock GPT decision is missing required key: ${key}.`, "INVALID_MOCK_DECISION");
  }
  if (Object.keys(decision).some((key) => !required.includes(key))) {
    fail("Mock GPT decision contains unsupported keys.", "INVALID_MOCK_DECISION");
  }
  for (const key of ["nextAction", "rationale"]) {
    if (typeof decision[key] !== "string" || decision[key].trim() === "") {
      fail(`Mock GPT decision ${key} must be a non-empty string.`, "INVALID_MOCK_DECISION");
    }
  }
  return Object.freeze({
    nextAction: decision.nextAction,
    rationale: decision.rationale,
    allowedFiles: validateStringArray(decision.allowedFiles, "allowedFiles"),
    requiredTests: validateStringArray(decision.requiredTests, "requiredTests"),
    stopConditions: validateStringArray(decision.stopConditions, "stopConditions")
  });
}

function list(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

/** Generate a static coding prompt from a validated decision and known state. */
export function generateCodingPrompt(brainRequest, decision) {
  const goal = brainRequest.projectGoal ?? "Unspecified; use the PLAN.md context below.";
  return `# Hephaestus mocked coding task\n\nProject goal: ${goal}\n\nCurrent phase: ${brainRequest.currentPhase}\nCurrent task: ${brainRequest.currentTask}\n\nDecision rationale: ${decision.rationale}\nNext action: ${decision.nextAction}\n\nAllowed files:\n${list(decision.allowedFiles)}\n\nRequired tests:\n${list(decision.requiredTests)}\n\nStop conditions:\n${list(decision.stopConditions)}\n\nPLAN.md context:\n${brainRequest.planContext}`;
}
