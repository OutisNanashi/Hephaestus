import fs from "node:fs";
import path from "node:path";
import { fail, HephaestusError } from "./errors.js";
import { resolveSafePath, assertRealPathWithinRoot } from "./safe-path.js";
import { validateState } from "./state.js";

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTAINER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const RESOURCE_NAMES = Object.freeze(["state", "log", "prompts", "testReports", "reviewReports"]);
const DEFAULT_PATHS = Object.freeze({
  state: "STATE.json",
  log: "BUILD_LOG.md",
  prompts: "out/prompts",
  testReports: "out/test_reports",
  reviewReports: "out/review_reports"
});
const PROJECT_STATUSES = new Set(["running", "paused", "blocked", "stopped", "idle"]);

function readJson(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Multi-project registry could not be read: ${error.message}`, "FILE_READ_FAILED");
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`Multi-project registry contains invalid JSON: ${error.message}`, "INVALID_JSON");
  }
}

function nonEmptyText(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string.`, "INVALID_MULTI_PROJECT_REGISTRY");
  return value;
}

function relativeResource(value, projectPath, label) {
  const item = nonEmptyText(value, label);
  if (path.isAbsolute(item) || path.win32.isAbsolute(item)) fail(`${label} must be relative to its project root.`, "INVALID_MULTI_PROJECT_REGISTRY");
  return resolveSafePath(projectPath, item);
}

function normalizeContainer(raw, id) {
  const value = raw === undefined ? { id: `hephaestus-${id}`, workspace: "/workspace" } : raw;
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !["id", "workspace"].includes(key))) {
    fail("Project container configuration is invalid.", "INVALID_MULTI_PROJECT_REGISTRY");
  }
  const containerId = nonEmptyText(value.id, "Project container id");
  const workspace = nonEmptyText(value.workspace, "Project workspace");
  if (!CONTAINER_ID.test(containerId) || !workspace.startsWith("/") || workspace.includes("\0") || workspace.split("/").includes("..")) {
    fail("Project container configuration is unsafe.", "INVALID_MULTI_PROJECT_REGISTRY");
  }
  return Object.freeze({ id: containerId, workspace });
}

function normalizePaths(raw, projectPath) {
  const value = raw === undefined ? DEFAULT_PATHS : raw;
  if (!value || Array.isArray(value) || typeof value !== "object" || RESOURCE_NAMES.some((key) => !(key in value)) || Object.keys(value).some((key) => !RESOURCE_NAMES.includes(key))) {
    fail("Project paths must declare state, log, prompts, testReports, and reviewReports.", "INVALID_MULTI_PROJECT_REGISTRY");
  }
  return Object.freeze(Object.fromEntries(RESOURCE_NAMES.map((name) => {
    const resourcePath = relativeResource(value[name], projectPath, `Project ${name} path`);
    if (fs.existsSync(resourcePath)) assertRealPathWithinRoot(projectPath, resourcePath);
    return [name, resourcePath];
  })));
}

function normalizeProject(raw, allowedRoot, index) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") fail(`Registry project at index ${index} must be an object.`, "INVALID_MULTI_PROJECT_REGISTRY");
  const allowedKeys = ["id", "path", "assignedAgent", "container", "paths"];
  if (Object.keys(raw).some((key) => !allowedKeys.includes(key))) fail(`Registry project at index ${index} contains unsupported keys.`, "INVALID_MULTI_PROJECT_REGISTRY");
  const id = nonEmptyText(raw.id, `Registry project at index ${index} id`);
  if (!PROJECT_ID.test(id)) fail(`Registry project at index ${index} has an invalid id.`, "INVALID_MULTI_PROJECT_REGISTRY");
  const configuredPath = resolveSafePath(allowedRoot, nonEmptyText(raw.path, `Registry project at index ${index} path`));
  const projectPath = fs.existsSync(configuredPath) ? assertRealPathWithinRoot(allowedRoot, configuredPath) : configuredPath;
  const assignedAgent = raw.assignedAgent === undefined ? "unassigned" : nonEmptyText(raw.assignedAgent, "Project assigned agent");
  return Object.freeze({ id, path: projectPath, assignedAgent, container: normalizeContainer(raw.container, id), paths: normalizePaths(raw.paths, projectPath) });
}

function assertUniqueProjects(projects) {
  const ids = new Set();
  const roots = [];
  const containers = new Set();
  const resources = new Set();
  for (const project of projects) {
    if (ids.has(project.id)) fail(`Multi-project registry contains duplicate id: ${project.id}.`, "INVALID_MULTI_PROJECT_REGISTRY");
    for (const root of roots) {
      const relative = path.relative(root, project.path);
      const nested = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
      if (nested) fail("Multi-project registry contains overlapping project roots; nested roots are not supported.", "INVALID_MULTI_PROJECT_REGISTRY");
    }
    if (containers.has(project.container.id)) fail(`Multi-project registry contains duplicate container id: ${project.container.id}.`, "INVALID_MULTI_PROJECT_REGISTRY");
    ids.add(project.id); roots.push(project.path); containers.add(project.container.id);
    for (const resourcePath of Object.values(project.paths)) {
      if (resources.has(resourcePath)) fail("Multi-project registry contains shared output paths.", "INVALID_MULTI_PROJECT_REGISTRY");
      resources.add(resourcePath);
    }
  }
}

/** Load a strict, normalized multi-project registry without creating directories or starting work. */
export function loadMultiProjectRegistry(registryPath, allowedRoot) {
  const raw = readJson(registryPath);
  if (!raw || Array.isArray(raw) || typeof raw !== "object" || !Array.isArray(raw.projects) || Object.keys(raw).some((key) => key !== "projects")) {
    fail("Multi-project registry must be an object with a projects array.", "INVALID_MULTI_PROJECT_REGISTRY");
  }
  const projects = raw.projects.map((project, index) => normalizeProject(project, allowedRoot, index));
  assertUniqueProjects(projects);
  return Object.freeze([...projects].sort((left, right) => left.id.localeCompare(right.id)));
}

/** Return only one declared project-owned path; callers cannot supply arbitrary relative paths. */
export function projectResource(project, resourceName) {
  if (!project || !project.paths || !RESOURCE_NAMES.includes(resourceName)) fail("Unknown project resource.", "INVALID_PROJECT_RESOURCE");
  return project.paths[resourceName];
}

export function projectStatus(state) {
  const item = validateState(state);
  if (item.nextAction === "project-stopped") return "stopped";
  if (item.usageLimitPaused) return "paused";
  if (item.blocked) return "blocked";
  if (["agent-running", "project-running"].includes(item.nextAction)) return "running";
  return "idle";
}

/** Produce a new valid state for a project-only control action without persisting it. */
export function transitionProjectStatus(state, action) {
  const item = validateState(state);
  let next;
  if (action === "pause") next = { ...item, blocked: false, usageLimitPaused: true, nextAction: "project-paused" };
  else if (action === "resume") next = { ...item, blocked: false, usageLimitPaused: false, nextAction: "project-idle" };
  else if (action === "stop") next = { ...item, blocked: false, usageLimitPaused: false, nextAction: "project-stopped" };
  else fail("Project status action must be pause, resume, or stop.", "INVALID_PROJECT_STATUS_ACTION");
  return Object.freeze(validateState(next));
}

/** Read one declared project's validated state without creating or changing files. */
export function readProjectState(project) {
  const root = assertRealPathWithinRoot(project.path, project.path);
  const statePath = projectResource(project, "state");
  try {
    assertRealPathWithinRoot(root, statePath);
    if (!fs.statSync(statePath).isFile()) fail("Project state path must be a regular file.", "INVALID_PROJECT_RESOURCE");
    return validateState(JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch (error) {
    if (error instanceof HephaestusError) throw error;
    if (error instanceof SyntaxError) fail("Project state path contains invalid JSON.", "INVALID_JSON");
    fail(`Project state path could not be read: ${error.message}`, "FILE_READ_FAILED");
  }
}

/** Gather a deterministic, read-only status row for every project. */
export function globalProjectStatus(projects) {
  if (!Array.isArray(projects)) fail("Projects must be an array.", "INVALID_MULTI_PROJECT_REGISTRY");
  const rows = projects.map((project) => {
    const state = readProjectState(project);
    const status = projectStatus(state);
    if (!PROJECT_STATUSES.has(status)) fail("Project status is invalid.", "INVALID_PROJECT_STATUS");
    return Object.freeze({
      id: project.id,
      status,
      assignedAgent: project.assignedAgent,
      container: project.container,
      rootPath: project.path,
      paths: project.paths
    });
  });
  return Object.freeze([...rows].sort((left, right) => left.id.localeCompare(right.id)));
}
