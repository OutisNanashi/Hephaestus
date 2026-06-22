import fs from "node:fs";
import { fail } from "./errors.js";
import { resolveSafePath } from "./safe-path.js";

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function parseRegistry(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Project registry could not be read: ${error.message}`, "FILE_READ_FAILED");
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`Project registry contains invalid JSON: ${error.message}`, "INVALID_JSON");
  }
}

export function loadProjectRegistry(registryPath, allowedRoot) {
  const raw = parseRegistry(registryPath);
  if (raw === null || Array.isArray(raw) || typeof raw !== "object" || !Array.isArray(raw.projects)) {
    fail("Project registry must be an object with a projects array.", "INVALID_REGISTRY");
  }
  if (Object.keys(raw).some((key) => key !== "projects")) {
    fail("Project registry contains unsupported keys.", "INVALID_REGISTRY");
  }

  const ids = new Set();
  const projects = raw.projects.map((project, index) => {
    if (project === null || Array.isArray(project) || typeof project !== "object") {
      fail(`Registry project at index ${index} must be an object.`, "INVALID_REGISTRY");
    }
    if (Object.keys(project).some((key) => key !== "id" && key !== "path")) {
      fail(`Registry project at index ${index} contains unsupported keys.`, "INVALID_REGISTRY");
    }
    if (typeof project.id !== "string" || !PROJECT_ID.test(project.id)) {
      fail(`Registry project at index ${index} has an invalid id.`, "INVALID_REGISTRY");
    }
    if (ids.has(project.id)) {
      fail(`Project registry contains duplicate id: ${project.id}.`, "INVALID_REGISTRY");
    }
    ids.add(project.id);
    return Object.freeze({ id: project.id, path: resolveSafePath(allowedRoot, project.path) });
  });
  return Object.freeze(projects);
}

export function getProject(projects, projectId) {
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    fail(`Project is not registered: ${projectId}.`, "PROJECT_NOT_REGISTERED");
  }
  return project;
}
