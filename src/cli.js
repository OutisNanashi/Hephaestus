#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { HephaestusError } from "./errors.js";
import { ensureProjectLogDirectory } from "./logging.js";
import { inspectProject, saveInspectionReport, toInspectionSummary } from "./inspection.js";
import { runMockCycle } from "./mock-cycle.js";
import { runSandboxCommand } from "./sandbox.js";
import { runAgentTask } from "./agent.js";
import { verifyTestEvidence } from "./test-gate.js";
import { commitTask, createTaskBranch, fixturePr, recordGitMetadata } from "./git-workflow.js";
import { validateProjectDirectory } from "./project.js";
import { getProject, loadProjectRegistry } from "./registry.js";

const HELP = `Hephaestus Phase 6\n\nUsage:\n  hephaestus --help\n  hephaestus validate [--config <file>] [--project <id>]\n  hephaestus inspect [--config <file>] [--project <id>] [--save-report]\n  hephaestus cycle --project <id> --mock-gpt <fixture> --mock-agent-output <fixture>\n  hephaestus sandbox-run --project <id> --command <allowlisted-id>\n  hephaestus agent-run --project <id> --adapter <fixture-agent> --prompt <relative-file>\n  hephaestus verify-tests [--config <file>] [--project <id>]\n  hephaestus git-branch --project <id> --task <task-id>\n  hephaestus git-commit --project <id> --message <message>\n  hephaestus pr-open --project <id> --provider fixture-pr --task <task-id>\n\nCommands:\n  validate      Validate one registered project and create its log directory.\n  inspect       Read and summarize one registered project without changing it.\n  cycle         Run one local mocked brain cycle using declared fixture files.\n  sandbox-run   Run one fixed allowlisted command in an isolated container.\n  agent-run     Run one fixture agent process inside the isolated container.\n  verify-tests  Verify the project's recorded test evidence against the declaration.\n  git-branch    Create a deterministic per-task Git branch in the project repo.\n  git-commit    Commit pending project changes with a task-scoped message.\n  pr-open       Produce or update a fixture pull request record for the current task.\n\nSafety:\n  Agent prompts must stay inside the selected project. Fixture agents run only through the sandbox.`;

function takeOptionValue(args, option) {
  if (args.length === 0) {
    throw new HephaestusError(`Option ${option} requires a value.`, "INVALID_ARGUMENT");
  }
  const value = args.shift();
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new HephaestusError(`Option ${option} requires a value.`, "INVALID_ARGUMENT");
  }
  return value;
}

function parseArguments(argv) {
  const args = [...argv];
  let configPath = "hephaestus.config.json";
  let projectId;
  let saveReport = false;
  let mockGptPath;
  let mockAgentOutputPath;
  let commandId;
  let adapterId;
  let promptPath;
  let task;
  let message;
  let provider;
  const command = args.shift();
  while (args.length > 0) {
    const option = args.shift();
    if (option === "--config") configPath = takeOptionValue(args, option);
    else if (option === "--project") projectId = takeOptionValue(args, option);
    else if (option === "--save-report") saveReport = true;
    else if (option === "--mock-gpt") mockGptPath = takeOptionValue(args, option);
    else if (option === "--mock-agent-output") mockAgentOutputPath = takeOptionValue(args, option);
    else if (option === "--command") commandId = takeOptionValue(args, option);
    else if (option === "--adapter") adapterId = takeOptionValue(args, option);
    else if (option === "--prompt") promptPath = takeOptionValue(args, option);
    else if (option === "--task") task = takeOptionValue(args, option);
    else if (option === "--message") message = takeOptionValue(args, option);
    else if (option === "--provider") provider = takeOptionValue(args, option);
    else throw new HephaestusError(`Unknown option: ${option}.`, "INVALID_ARGUMENT");
  }
  return { command, configPath, projectId, saveReport, mockGptPath, mockAgentOutputPath, commandId, adapterId, promptPath, task, message, provider };
}

export function run(argv) {
  const { command, configPath, projectId, saveReport, mockGptPath, mockAgentOutputPath, commandId, adapterId, promptPath, task, message, provider } = parseArguments(argv);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!["validate","inspect","cycle","sandbox-run","agent-run","verify-tests","git-branch","git-commit","pr-open"].includes(command)) throw new HephaestusError(`Unknown command: ${command}.`, "INVALID_ARGUMENT");

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

  if (command === "sandbox-run") {
    if (!commandId) throw new HephaestusError("sandbox-run requires an allowlisted --command id.", "INVALID_ARGUMENT");
    const report = runSandboxCommand({ allowedRoot: config.allowedRoot, projectPath: project.path, commandId });
    process.stdout.write(`${JSON.stringify({
      commandId: report.commandId,
      status: report.status,
      stdout: report.stdout,
      stderr: report.stderr,
      exitCode: report.exitCode,
      timedOut: report.timedOut,
      reportPath: report.reportPath
    }, null, 2)}\n`);
    return report.status === "passed" ? 0 : 1;
  }

  if (command === "agent-run") {
    if (!adapterId || !promptPath) throw new HephaestusError("agent-run requires --adapter and --prompt.", "INVALID_ARGUMENT");
    const result = runAgentTask({ allowedRoot: config.allowedRoot, projectPath: project.path, adapterId, promptPath });
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      adapterId: result.adapterId,
      promptPath: result.promptPath,
      agentOutputLength: result.output.length,
      exitCode: result.report.exitCode,
      nextAction: result.state.nextAction
    }, null, 2)}\n`);
    return result.status === "completed" ? 0 : 1;
  }

  if (command === "verify-tests") {
    const result = verifyTestEvidence(project.path);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "passed" ? 0 : 1;
  }
  if (command === "git-branch") {
    if (!task) throw new HephaestusError("git-branch requires --task.", "INVALID_ARGUMENT");
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const branch = createTaskBranch(validated.path, project.id, task);
    recordGitMetadata(validated.path, validated.state, { branch });
    process.stdout.write(`${branch}\n`);
    return 0;
  }
  if (command === "git-commit") {
    if (!message) throw new HephaestusError("git-commit requires --message.", "INVALID_ARGUMENT");
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const commit = commitTask(validated.path, message);
    recordGitMetadata(validated.path, validated.state, { branch: commit.branch, commit });
    process.stdout.write(`${JSON.stringify(commit)}\n`);
    return 0;
  }
  if (command === "pr-open") {
    if (provider !== "fixture-pr" || !task) throw new HephaestusError("pr-open requires --provider fixture-pr and --task.", "INVALID_ARGUMENT");
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const pr = fixturePr(project.id, task, validated.state.currentPr ? { url: validated.state.currentPr } : null);
    recordGitMetadata(validated.path, validated.state, pr);
    process.stdout.write(`${JSON.stringify(pr)}\n`);
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
