import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { validateProjectDirectory } from "./project.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

const REQUIRED_DOCUMENTS = Object.freeze({
  plan: "PLAN.md",
  buildingReference: "BUILDING_REFERENCE.md",
  buildLog: "BUILD_LOG.md",
  currentTask: "CURRENT_TASK.md"
});
const OPTIONAL_DOCUMENTS = Object.freeze({
  agentOutput: "AGENT_OUTPUT.md",
  reviewNotes: "REVIEW_NOTES.md"
});

function readRequiredDocument(projectPath, fileName) {
  const filePath = path.join(projectPath, fileName);
  try {
    assertRealPathWithinRoot(projectPath, filePath);
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code) throw error;
    fail(`Project is missing required file: ${fileName}.`, "MISSING_REQUIRED_PROJECT_FILE");
  }
}

function readOptionalDocument(projectPath, fileName) {
  const filePath = path.join(projectPath, fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    assertRealPathWithinRoot(projectPath, filePath);
    if (!fs.statSync(filePath).isFile()) {
      fail(`Optional project file is not a regular file: ${fileName}.`, "INVALID_OPTIONAL_PROJECT_FILE");
    }
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code) throw error;
    fail(`Optional project file could not be read: ${fileName}.`, "FILE_READ_FAILED");
  }
}

function readDocuments(projectPath) {
  const documents = {};
  for (const [key, fileName] of Object.entries(REQUIRED_DOCUMENTS)) {
    documents[key] = readRequiredDocument(projectPath, fileName);
  }
  for (const [key, fileName] of Object.entries(OPTIONAL_DOCUMENTS)) {
    documents[key] = readOptionalDocument(projectPath, fileName);
  }
  return Object.freeze(documents);
}

/**
 * Read a project without changing it. The resulting object deliberately has no
 * inferred fields: unavailable optional documents are represented as null.
 */
export function inspectProject(allowedRoot, projectPath) {
  const validatedProject = validateProjectDirectory(allowedRoot, projectPath);
  const documents = readDocuments(validatedProject.path);
  return Object.freeze({
    projectPath: validatedProject.path,
    currentPhase: validatedProject.state.currentPhase,
    currentTask: validatedProject.state.currentTask,
    state: validatedProject.state,
    documents,
    uncertainty: Object.freeze([])
  });
}

export function toInspectionSummary(projectState, reportPath = null) {
  const summary = {
    projectPath: projectState.projectPath,
    currentPhase: projectState.currentPhase,
    currentTask: projectState.currentTask,
    optionalFiles: {
      agentOutput: projectState.documents.agentOutput !== null,
      reviewNotes: projectState.documents.reviewNotes !== null
    },
    uncertainty: projectState.uncertainty
  };
  if (reportPath !== null) summary.reportPath = reportPath;
  return Object.freeze(summary);
}

function ensureReportDirectory(projectPath) {
  const outDirectory = path.join(projectPath, "out");
  const summariesDirectory = path.join(outDirectory, "summaries");
  for (const directory of [outDirectory, summariesDirectory]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    assertRealPathWithinRoot(projectPath, directory);
    if (!fs.statSync(directory).isDirectory()) {
      fail("Inspection report directory is not a directory.", "INVALID_REPORT_DIRECTORY");
    }
  }
  return summariesDirectory;
}

/** Write a deterministic report only when the caller explicitly asks for it. */
export function saveInspectionReport(projectState) {
  const reportPath = path.join(ensureReportDirectory(projectState.projectPath), "inspection.json");
  assertRealPathWithinRoot(projectState.projectPath, path.dirname(reportPath));
  if (fs.existsSync(reportPath)) {
    assertRealPathWithinRoot(projectState.projectPath, reportPath);
    if (!fs.statSync(reportPath).isFile()) {
      fail("Inspection report path is not a regular file.", "INVALID_REPORT_PATH");
    }
  }
  fs.writeFileSync(`${reportPath}`, `${JSON.stringify(projectState, null, 2)}\n`, "utf8");
  return reportPath;
}
