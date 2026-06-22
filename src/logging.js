import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

export function ensureProjectLogDirectory(logDirectory, projectId) {
  if (typeof projectId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(projectId)) {
    fail("Log directory requires a valid project id.", "INVALID_PROJECT_ID");
  }
  const directory = path.join(logDirectory, projectId);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    fail(`Log directory could not be created: ${error.message}`, "LOG_DIRECTORY_FAILED");
  }
  return directory;
}
