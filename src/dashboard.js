import fs from "node:fs";
import { HephaestusError } from "./errors.js";
import { loadMultiProjectRegistry, projectResource, projectStatus, readProjectState } from "./multi-project.js";
import { redactSecrets } from "./notification.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

const UNKNOWN = "unknown";

function displayText(value, fallback = null) {
  return typeof value === "string" && value.trim() !== "" ? redactSecrets(value.trim()) : fallback;
}

function errorCode(error) {
  return error instanceof HephaestusError ? error.code : "DASHBOARD_STATE_UNAVAILABLE";
}

function latestLogSummary(project) {
  try {
    const root = assertRealPathWithinRoot(project.path, project.path);
    const logPath = projectResource(project, "log");
    assertRealPathWithinRoot(root, logPath);
    if (!fs.statSync(logPath).isFile()) return null;
    const line = fs.readFileSync(logPath, "utf8").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).at(-1);
    return line === undefined ? null : redactSecrets(line.slice(0, 240));
  } catch {
    return null;
  }
}

function unavailableRow(project, stateError) {
  return Object.freeze({
    id: project.id,
    projectName: redactSecrets(project.id),
    status: "unavailable",
    currentPhase: null,
    currentTask: null,
    assignedAgent: displayText(project.assignedAgent, "unassigned"),
    containerStatus: UNKNOWN,
    testStatus: UNKNOWN,
    reviewStatus: UNKNOWN,
    mergeStatus: UNKNOWN,
    blocked: false,
    manualAction: null,
    latestNotification: null,
    latestLogSummary: latestLogSummary(project),
    stateAvailable: false,
    stateError
  });
}

function dashboardRow(project) {
  try {
    const state = readProjectState(project);
    const merged = state.mergeStatus === "merged";
    return Object.freeze({
      id: project.id,
      projectName: redactSecrets(project.id),
      status: merged ? "merged" : projectStatus(state),
      currentPhase: displayText(state.currentPhase),
      currentTask: displayText(state.currentTask),
      assignedAgent: displayText(state.assignedAgent, displayText(project.assignedAgent, "unassigned")),
      containerStatus: displayText(state.containerStatus, UNKNOWN),
      testStatus: UNKNOWN,
      reviewStatus: displayText(state.reviewStatus, UNKNOWN),
      mergeStatus: displayText(state.mergeStatus, UNKNOWN),
      blocked: state.blocked,
      manualAction: state.blocked ? displayText(state.nextAction, "manual action required") : null,
      latestNotification: null,
      latestLogSummary: latestLogSummary(project),
      stateAvailable: true,
      stateError: null
    });
  } catch (error) {
    return unavailableRow(project, errorCode(error));
  }
}

/** Build a deterministic, read-only supervision view from declared project data. */
export function dashboardStatus(projects) {
  if (!Array.isArray(projects)) throw new TypeError("Dashboard projects must be an array.");
  return Object.freeze(projects.map(dashboardRow).sort((left, right) => left.id.localeCompare(right.id)));
}

/** Load the registry and renderable status rows without invoking conductor actions. */
export function loadDashboardStatus(registryPath, allowedRoot) {
  return dashboardStatus(loadMultiProjectRegistry(registryPath, allowedRoot));
}
