import { fail } from "./errors.js";
import { AUTO_MERGE_MODE, finishRunLive, MANUAL_MERGE_MODE } from "./auto-merge.js";
import { runLiveLoop } from "./live-loop.js";
import { advanceToNextPhase } from "./phase-transition.js";
import { validateProjectDirectory } from "./project.js";

// A single run advances at most this many phases, so a confused brain can never
// spin the loop forever. The systemd timer resumes anything that hits the cap.
export const MAX_PHASES_PER_RUN = 20;

function currentPhaseMerged(state) {
  return state.mergeStatus === "merged" || state.mergeGate?.mergeResult != null;
}

const DEFAULT_DEPS = Object.freeze({
  readState: ({ config, project }) => validateProjectDirectory(config.allowedRoot, project.path).state,
  runLiveLoop: (args) => runLiveLoop(args),
  autoMerge: (args) => finishRunLive({ mode: AUTO_MERGE_MODE, ...args }),
  advance: ({ config, project }) => advanceToNextPhase({ allowedRoot: config.allowedRoot, projectPath: project.path, projectId: project.id, brain: config.brain })
});

function loopArgs({ config, project, task, maxCycles }) {
  return {
    allowedRoot: config.allowedRoot,
    projectPath: project.path,
    projectId: project.id,
    brain: config.brain,
    task,
    ...(maxCycles === undefined ? {} : { maxCycles }),
    telegram: config.notifications?.telegram
  };
}

/**
 * Drive a project as far as it safely can in one invocation.
 *
 * Manual-merge Mode keeps today's behavior: run one build loop and stop, leaving
 * the merge chain to the operator. Auto-merge Mode chains phases — build the
 * current task, merge it, advance to the next PLAN.md phase, and repeat — until
 * the plan is complete, something blocks or pauses, or the phase budget is hit.
 * Between phases it also resumes: a phase merged by a previous invocation but not
 * yet advanced is advanced first. `--task` is honored only for the first phase so
 * a resumed chain follows the plan, not a stale one-off task.
 */
export async function orchestrateRunLive({ mode = MANUAL_MERGE_MODE, config, project, task, maxCycles, deps = DEFAULT_DEPS }) {
  if (mode === MANUAL_MERGE_MODE) {
    const loop = await deps.runLiveLoop(loopArgs({ config, project, task, maxCycles }));
    const finished = await finishRunLive({ mode, config, project, loop });
    return Object.freeze({ mode, outcome: loop.status, phases: Object.freeze([]), loop, merge: finished.merge ?? null });
  }
  if (mode !== AUTO_MERGE_MODE) fail(`Unknown merge mode: ${mode}.`, "INVALID_ARGUMENT");

  const phases = [];
  const builtTasks = new Set();
  let firstPhase = true;
  for (let advanced = 0; advanced <= MAX_PHASES_PER_RUN; advanced += 1) {
    const state = deps.readState({ config, project });
    if (state.nextAction === "project-complete") {
      return Object.freeze({ mode, outcome: "project-complete", phases: Object.freeze(phases) });
    }

    // Resume: a phase merged by a previous invocation that never advanced.
    if (currentPhaseMerged(state)) {
      const resume = await deps.advance({ config, project });
      phases.push(Object.freeze({ phase: state.currentPhase, task: state.currentTask, stage: "advanced", detail: resume.status }));
      if (resume.status === "all-complete") return Object.freeze({ mode, outcome: "project-complete", phases: Object.freeze(phases) });
      continue;
    }

    if (builtTasks.has(state.currentTask)) {
      return Object.freeze({ mode, outcome: "no-progress", reason: `Task ${state.currentTask} did not advance; stopping to avoid a loop.`, phases: Object.freeze(phases) });
    }
    builtTasks.add(state.currentTask);

    const loop = await deps.runLiveLoop(loopArgs({ config, project, task: firstPhase ? task : undefined, maxCycles }));
    firstPhase = false;
    if (loop.status !== "task-complete") {
      phases.push(Object.freeze({ phase: state.currentPhase, task: state.currentTask, stage: loop.status, detail: loop.reason }));
      return Object.freeze({ mode, outcome: loop.status, reason: loop.reason, phases: Object.freeze(phases) });
    }

    const finished = await deps.autoMerge({ config, project, loop });
    const merge = finished.merge ?? { merged: false };
    if (merge.merged !== true) {
      phases.push(Object.freeze({ phase: state.currentPhase, task: state.currentTask, stage: "merge-blocked", detail: merge.reason ?? merge.rationale ?? null, blockers: merge.blockers ?? null }));
      return Object.freeze({ mode, outcome: "merge-blocked", phases: Object.freeze(phases), merge });
    }

    const advance = await deps.advance({ config, project });
    phases.push(Object.freeze({ phase: state.currentPhase, task: state.currentTask, stage: "merged", pr: merge.pr ?? null, mergeCommit: merge.mergeCommit ?? null, next: advance.status }));
    if (advance.status === "all-complete") {
      return Object.freeze({ mode, outcome: "project-complete", phases: Object.freeze(phases) });
    }
  }
  return Object.freeze({ mode, outcome: "phase-budget-reached", phases: Object.freeze(phases) });
}
