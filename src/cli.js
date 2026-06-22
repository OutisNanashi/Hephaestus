#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { HephaestusError } from "./errors.js";
import { ensureProjectLogDirectory } from "./logging.js";
import { inspectProject, saveInspectionReport, toInspectionSummary } from "./inspection.js";
import { validateProjectDirectory } from "./project.js";
import { getProject, loadProjectRegistry } from "./registry.js";

const HELP = `Hephaestus Phase 1\n\nUsage:\n  hephaestus --help\n  hephaestus validate [--config <file>] [--project <id>]\n  hephaestus inspect [--config <file>] [--project <id>] [--save-report]\n\nCommands:\n  validate  Validate one registered project and create its log directory.\n  inspect   Read and summarize one registered project without changing it.\n\nSafety:\n  Project paths must remain within the configured allowedRoot.\n  Inspection writes no project files unless --save-report is supplied.\n  This phase does not execute agents, project commands, containers, or network calls.`;

function parseArguments(argv) {
  const args = [...argv];
  let configPath = "hephaestus.config.json";
  let projectId;
  let saveReport = false;
  const command = args.shift();
  while (args.length > 0) {
    const option = args.shift();
    if (option === "--config") configPath = args.shift();
    else if (option === "--project") projectId = args.shift();
    else if (option === "--save-report") saveReport = true;
    else throw new HephaestusError(`Unknown option: ${option}.`, "INVALID_ARGUMENT");
    if (!configPath || (option === "--project" && !projectId)) {
      throw new HephaestusError(`Option ${option} requires a value.`, "INVALID_ARGUMENT");
    }
  }
  return { command, configPath, projectId, saveReport };
}

export function run(argv) {
  const { command, configPath, projectId, saveReport } = parseArguments(argv);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command !== "validate" && command !== "inspect") throw new HephaestusError(`Unknown command: ${command}.`, "INVALID_ARGUMENT");

  const config = loadConfig(path.resolve(configPath));
  const projects = loadProjectRegistry(config.registryPath, config.allowedRoot);
  const project = getProject(projects, projectId ?? projects[0]?.id);
  if (command === "inspect") {
    const projectState = inspectProject(config.allowedRoot, project.path);
    const reportPath = saveReport ? saveInspectionReport(projectState) : null;
    process.stdout.write(`${JSON.stringify(toInspectionSummary(projectState, reportPath), null, 2)}\n`);
    return 0;
  }

  validateProjectDirectory(config.allowedRoot, project.path);
  const logDirectory = ensureProjectLogDirectory(config.logDirectory, project.id);
  process.stdout.write(`Validated project ${project.id}; log directory: ${logDirectory}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Hephaestus error: ${message}\n`);
    process.exitCode = 1;
  }
}
