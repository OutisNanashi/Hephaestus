import path from "node:path";
import { runCodexWorkspaceExec, WORKSPACE_CLASSIFICATIONS } from "./agent-codex-workspace-exec.js";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { runLiveBrainCycle } from "./live-brain.js";
import {
  createNotificationEvent, createTelegramTransportFromEnvironment,
  dispatchNotification, NotificationDeduper, saveNotificationReport
} from "./notification.js";

const DEFAULT_MAX_CYCLES = 5;
const PROMPT_RELATIVE_PATH = path.join("out", "prompts", "next-task.md");

// Terminal loop statuses; anything else keeps cycling until maxCycles.
export const LOOP_STATUSES = Object.freeze([
  "task-complete", "blocked", "paused", "failed", "max-cycles-reached"
]);

function notificationEventFor({ status, projectId, phase, reason, requiredAction }) {
  const type = status === "paused" ? "usage_limit" : status === "task-complete" ? "phase_completed" : "manual_blocker";
  return createNotificationEvent({
    type,
    project: projectId,
    phase: String(phase),
    status,
    reason,
    requiredAction: requiredAction ?? null,
    timestamp: new Date().toISOString()
  });
}

/** Notification failures must never stop the loop; the result is recorded either way. */
async function notify({ transport, deduper, projectPath, event }) {
  try {
    const result = await dispatchNotification({ event, transport, deduper });
    saveNotificationReport(projectPath, result);
    return result.status;
  } catch {
    return "failed";
  }
}

/**
 * Run the continuous brain -> agent loop for one project: the brain reads the
 * project (including the latest AGENT_OUTPUT.md), decides, and writes a bounded
 * prompt; Codex executes it inside the workspace-write sandbox; the loop feeds
 * the captured result back to the brain until the brain reports task-complete,
 * something blocks or pauses, or the cycle budget runs out.
 */
export async function runLiveLoop({
  allowedRoot, projectPath, projectId, brain, task,
  maxCycles = DEFAULT_MAX_CYCLES,
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawn,
  telegram,
  now = () => new Date().toISOString()
}) {
  if (!Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > 50) {
    fail("Live loop maxCycles must be an integer between 1 and 50.", "INVALID_LIVE_LOOP_REQUEST");
  }
  const transport = createTelegramTransportFromEnvironment(telegram, env, fetchImpl);
  const deduper = new NotificationDeduper();
  const cycles = [];
  const finish = async (status, reason, requiredAction, phase) => {
    let notification = "skipped";
    if (LOOP_STATUSES.includes(status) && status !== "max-cycles-reached") {
      const validatedProjectPath = cycles.length > 0 ? cycles[cycles.length - 1].projectPath : path.resolve(allowedRoot, projectPath);
      notification = await notify({
        transport, deduper,
        projectPath: validatedProjectPath,
        event: notificationEventFor({ status, projectId, phase, reason, requiredAction })
      });
    }
    return Object.freeze({ status, reason, cycles: Object.freeze(cycles), notification });
  };

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const projectState = inspectProject(allowedRoot, projectPath);
    const phase = projectState.currentPhase;
    if (projectState.state.blocked) {
      return finish("blocked", `Project is blocked (${projectState.state.nextAction}); owner action is required before the loop can continue.`, projectState.state.nextAction, phase);
    }
    if (projectState.state.usageLimitPaused) {
      return finish("paused", "Project is paused for an agent usage limit; resume after the limit resets.", null, phase);
    }

    const brainCycle = await runLiveBrainCycle({
      allowedRoot,
      projectPath,
      brain,
      task,
      projectName: projectId,
      env,
      fetchImpl
    });
    const record = {
      cycle,
      startedAt: now(),
      projectPath: projectState.projectPath,
      decision: brainCycle.decision,
      promptPath: brainCycle.promptPath,
      execClassification: null
    };
    cycles.push(record);

    if (brainCycle.decision.loopSignal === "task-complete") {
      return finish("task-complete", `GPT reports the current task is complete: ${brainCycle.decision.rationale}`, null, phase);
    }
    if (brainCycle.decision.loopSignal === "blocked") {
      return finish("blocked", `GPT reports automation cannot safely continue: ${brainCycle.decision.rationale}`, brainCycle.decision.nextAction, phase);
    }

    const exec = runCodexWorkspaceExec({
      allowedRoot,
      projectPath,
      projectId,
      promptPath: PROMPT_RELATIVE_PATH,
      explicitWorkspaceExecPermit: true,
      env,
      ...(spawn === undefined ? {} : { spawn })
    });
    record.execClassification = exec.classification;
    record.execReportPath = exec.reportPath;
    record.finishedAt = now();

    if (exec.classification === WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT) {
      return finish("paused", `Codex usage limit reached${exec.retryAfter ? `; try again at ${exec.retryAfter}` : ""}.`, null, phase);
    }
    if (exec.classification !== WORKSPACE_CLASSIFICATIONS.PASS) {
      const status = exec.state.blocked ? "blocked" : "failed";
      return finish(status, `Codex run ended with ${exec.classification}: ${exec.summary}`, exec.manualAction, phase);
    }
    // PASS: AGENT_OUTPUT.md is fresh; the next cycle's brain call reads it and decides.
  }
  return finish("max-cycles-reached", `Loop stopped after ${maxCycles} cycles without a terminal signal.`, null, null);
}
