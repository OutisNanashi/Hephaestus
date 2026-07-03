import { fail } from "./errors.js";
import { projectStatus, readProjectState } from "./multi-project.js";

const RESULT_STATUSES = new Set(["completed", "blocked", "paused", "stopped", "failed", "skipped"]);

function row(project, result, detail) {
  return Object.freeze({ id: project.id, assignedAgent: project.assignedAgent, container: project.container, result, detail: detail ?? null });
}

/**
 * Run one independent loop per registered project in a single invocation.
 * Each project's loop is isolated: paused/stopped projects are skipped, and a
 * failure or blocker in one project is captured as that project's own result
 * without stopping the others. `runProject(project, state)` performs the real
 * (or mocked) per-project loop and returns { status, detail }; it must write only
 * inside the project's own configured paths — the caller supplies that behaviour.
 */
export function runMultiProjectLoops(projects, runProject) {
  if (!Array.isArray(projects)) fail("Projects must be an array.", "INVALID_MULTI_PROJECT_REGISTRY");
  if (typeof runProject !== "function") fail("Multi-project runner requires a per-project loop function.", "INVALID_ARGUMENT");
  const rows = projects.map((project) => {
    let state;
    try {
      state = readProjectState(project);
    } catch (error) {
      return row(project, "failed", error.code ?? "PROJECT_STATE_UNREADABLE");
    }
    const status = projectStatus(state);
    if (status === "paused") return row(project, "paused", "skipped: project paused");
    if (status === "stopped") return row(project, "stopped", "skipped: project stopped");
    try {
      const outcome = runProject(project, state) ?? {};
      const result = RESULT_STATUSES.has(outcome.status) ? outcome.status : "completed";
      return row(project, result, outcome.detail);
    } catch (error) {
      // One project failing must never stop or corrupt another project's loop.
      return row(project, "failed", error.code ?? error.message ?? "run failed");
    }
  });
  return Object.freeze([...rows].sort((left, right) => left.id.localeCompare(right.id)));
}
