import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot } from "./safe-path.js";
import { loadState } from "./state.js";

export const REQUIRED_PROJECT_FILES = Object.freeze([
  "PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "STATE.json", "CURRENT_TASK.md"
]);

export function validateProjectDirectory(allowedRoot, projectPath) {
  let safeProjectPath;
  try {
    safeProjectPath = assertRealPathWithinRoot(allowedRoot, projectPath);
  } catch (error) {
    throw error;
  }
  if (!fs.statSync(safeProjectPath).isDirectory()) {
    fail("Registered project path must be a directory.", "INVALID_PROJECT_DIRECTORY");
  }
  for (const fileName of REQUIRED_PROJECT_FILES) {
    const filePath = path.join(safeProjectPath, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      fail(`Project is missing required file: ${fileName}.`, "MISSING_REQUIRED_PROJECT_FILE");
    }
  }
  const state = loadState(safeProjectPath);
  return Object.freeze({ path: safeProjectPath, state });
}
