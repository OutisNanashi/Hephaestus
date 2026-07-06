import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { createTaskBranch, resetToBase } from "./git-workflow.js";
import { requestNextPhasePlan } from "./phase-plan.js";
import { validateProjectDirectory } from "./project.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { saveState } from "./state.js";

// A phase may only be left behind once it is genuinely merged. In Auto-merge Mode
// the conductor recorded that in STATE.json; safe blockage over blind progress.
function assertCurrentPhaseMerged(state) {
  const merged = state.mergeStatus === "merged" || state.mergeGate?.mergeResult != null;
  if (!merged) {
    fail("The current phase is not merged yet; next-phase refuses to skip ahead.", "PHASE_NOT_MERGED");
  }
}

function writeCurrentTask(projectPath, taskMarkdown) {
  const destination = path.join(projectPath, "CURRENT_TASK.md");
  if (fs.existsSync(destination)) assertRealPathWithinRoot(projectPath, destination);
  fs.writeFileSync(destination, taskMarkdown.endsWith("\n") ? taskMarkdown : `${taskMarkdown}\n`, "utf8");
  return destination;
}

// Next-phase state: drop the finished phase's agent report and merge gate so the
// next phase starts clean; the schema treats both as optional, so omitting clears them.
function nextPhaseState(previous, { phase, taskId, branch }) {
  const next = { ...previous };
  delete next.agent;
  delete next.mergeGate;
  return {
    ...next,
    currentPhase: String(phase),
    currentTask: taskId,
    currentBranch: branch,
    currentPr: null,
    blocked: false,
    usageLimitPaused: false,
    attemptCount: 0,
    mergeStatus: "not-started",
    lastSuccessfulStep: `phase-${previous.currentPhase}-merged`,
    lastGptDecision: null,
    nextAction: "run-agent"
  };
}

function completedState(previous, rationale) {
  const next = { ...previous };
  delete next.agent;
  return {
    ...next,
    currentBranch: "master",
    blocked: false,
    usageLimitPaused: false,
    nextAction: "project-complete",
    lastSuccessfulStep: `phase-${previous.currentPhase}-merged`,
    lastGptDecision: JSON.stringify({ phasePlan: { status: "all-complete", rationale } }).slice(0, 500)
  };
}

/**
 * Advance a merged project to the next phase. The brain reads PLAN.md and the
 * build log, decides the next bounded task (or reports all-complete), and this
 * function does the git plumbing: reset to base, create the task branch, write
 * CURRENT_TASK.md, and advance STATE.json. It never runs the coding agent.
 */
export async function advanceToNextPhase({ allowedRoot, projectPath, projectId, base = "master", brain, env = process.env, fetchImpl = globalThis.fetch }) {
  const validated = validateProjectDirectory(allowedRoot, projectPath);
  assertCurrentPhaseMerged(validated.state);
  const apiKey = env.OPENAI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") fail("Missing required local environment variable: OPENAI_API_KEY.", "OPENAI_API_KEY_MISSING");
  if (!brain || typeof brain.model !== "string" || brain.model.trim() === "") fail("OpenAI brain configuration is required.", "INVALID_OPENAI_CONFIG");

  // Return to base first so the plan is judged against the merged tree and the
  // build log that records the completed phases.
  resetToBase(validated.path, base);
  const planContext = fs.readFileSync(path.join(validated.path, "PLAN.md"), "utf8");
  const buildLog = fs.existsSync(path.join(validated.path, "BUILD_LOG.md")) ? fs.readFileSync(path.join(validated.path, "BUILD_LOG.md"), "utf8") : "";
  const plan = await requestNextPhasePlan({ apiKey, model: brain.model, planContext, buildLog, currentPhase: validated.state.currentPhase, fetchImpl });

  if (plan.status === "all-complete") {
    saveState(validated.path, completedState(validated.state, plan.rationale));
    fs.appendFileSync(path.join(validated.path, "BUILD_LOG.md"), `\n[next-phase] all phases complete: ${plan.rationale}\n`, "utf8");
    return Object.freeze({ status: "all-complete", rationale: plan.rationale });
  }

  // Create the branch on the clean base tree before writing files, so
  // createTaskBranch's clean-tree guard holds; the writes land on the new branch.
  const branch = createTaskBranch(validated.path, projectId, plan.taskId);
  const stalePath = path.join(validated.path, "AGENT_OUTPUT.md");
  if (fs.existsSync(stalePath)) fs.rmSync(stalePath, { force: true });
  writeCurrentTask(validated.path, plan.taskMarkdown);
  saveState(validated.path, nextPhaseState(validated.state, { phase: plan.phase, taskId: plan.taskId, branch }));
  fs.appendFileSync(path.join(validated.path, "BUILD_LOG.md"), `\n[next-phase] phase=${plan.phase} task=${plan.taskId} branch=${branch}\n`, "utf8");
  return Object.freeze({ status: "phase-ready", phase: String(plan.phase), taskId: plan.taskId, branch, rationale: plan.rationale });
}
