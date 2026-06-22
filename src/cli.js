#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { HephaestusError } from "./errors.js";
import { ensureProjectLogDirectory } from "./logging.js";
import { inspectProject, saveInspectionReport, toInspectionSummary } from "./inspection.js";
import { runMockCycle } from "./mock-cycle.js";
import { validateProjectDirectory } from "./project.js";
import { getProject, loadProjectRegistry } from "./registry.js";

const HELP = `Hephaestus Phase 2\n\nUsage:\n  hephaestus --help\n  hephaestus validate [--config <file>] [--project <id>]\n  hephaestus inspect [--config <file>] [--project <id>] [--save-report]\n  hephaestus cycle --project <id> --mock-gpt <fixture> --mock-agent-output <fixture>\n\nCommands:\n  validate  Validate one registered project and create its log directory.\n  inspect   Read and summarize one registered project without changing it.\n  cycle     Run one local mocked brain cycle using declared fixture files.\n\nSafety:\n  Project paths and mock fixtures must remain within the configured allowedRoot.\n  No real GPT, agent, command, container, or network action exists.`;

function parseArguments(argv) {
  const args = [...argv];
  let configPath = "hephaestus.config.json";
  let projectId;
  let saveReport = false;
  let mockGptPath;
  let mockAgentOutputPath;
  const command = args.shift();
  while (args.length > 0) {
    const option = args.shift();
    if (option === "--config") configPath = args.shift();
    else if (option === "--project") projectId = args.shift();
    else if (option === "--save-report") saveReport = true;
    else if (option === "--mock-gpt") mockGptPath = args.shift();
    else if (option === "--mock-agent-output") mockAgentOutputPath = args.shift();
    else throw new HephaestusError(`Unknown option: ${option}.`, "INVALID_ARGUMENT");
    if (!configPath || (option === "--project" && !projectId) || (option === "--mock-gpt" && !mockGptPath) || (option === "--mock-agent-output" && !mockAgentOutputPath)) {
      throw new HephaestusError(`Option ${option} requires a value.`, "INVALID_ARGUMENT");
    }
  }
  return { command, configPath, projectId, saveReport, mockGptPath, mockAgentOutputPath };
}

export function run(argv) {
  const { command, configPath, projectId, saveReport, mockGptPath, mockAgentOutputPath } = parseArguments(argv);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command !== "validate" && command !== "inspect" && command !== "cycle") throw new HephaestusError(`Unknown command: ${command}.`, "INVALID_ARGUMENT");

  const config = loadConfig(path.resolve(configPath));
  const projects = loadProjectRegistry(config.registryPath, config.allowedRoot);
  const project = getProject(projects, projectId ?? projects[0]?.id);
  if (command === "inspect") {
    const projectState = inspectProject(config.allowedRoot, project.path);
    const reportPath = saveReport ? saveInspectionReport(projectState) : null;
    process.stdout.write(`${JSON.stringify(toInspectionSummary(projectState, reportPath), null, 2)}\n`);
    return 0;
  }

  if (command === "cycle") {
    if (!mockGptPath || !mockAgentOutputPath) {
      throw new HephaestusError("cycle requires --mock-gpt and --mock-agent-output fixtures.", "INVALID_ARGUMENT");
    }
    const cycle = runMockCycle({
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      mockGptPath,
      mockAgentOutputPath
    });
    process.stdout.write(`${JSON.stringify({
      status: cycle.status,
      projectPath: cycle.projectPath,
      promptPath: cycle.promptPath ?? null,
      agentOutputPath: cycle.agentOutputPath ?? null,
      buildLogPath: cycle.buildLogPath,
      nextAction: cycle.state.nextAction
    }, null, 2)}\n`);
    return cycle.status === "completed" ? 0 : 1;
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
