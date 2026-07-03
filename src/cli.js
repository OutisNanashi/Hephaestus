#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { HephaestusError } from "./errors.js";
import { ensureProjectLogDirectory } from "./logging.js";
import { inspectProject, saveInspectionReport, toInspectionSummary } from "./inspection.js";
import { runMockCycle } from "./mock-cycle.js";
import { runSandboxCommand } from "./sandbox.js";
import { runAgentTask } from "./agent.js";
import { runAgentPreflight } from "./agent-preflight.js";
import { createAgentRunPlan } from "./agent-run-plan.js";
import { runCodexSmoke } from "./agent-smoke.js";
import { runCodexDiscovery } from "./agent-discovery.js";
import { runCodexReadonlySmoke } from "./agent-readonly-exec.js";
import { runCodexReadonlyInspect } from "./agent-readonly-inspect.js";
import { runCodexReadonlyInspectRecord } from "./agent-readonly-inspect-record.js";
import { runCodexReadonlyPromptRecord } from "./agent-readonly-prompt-record.js";
import { runActivationFixtureCleanup } from "./activation-fixture-hygiene.js";
import { runActivationCloseoutReadonlyCodex } from "./activation-closeout.js";
import { runActivationMockedBrainReadonlyHandoff } from "./brain-readonly-handoff.js";
import { runActivationProviderBrainReadonlyHandoff } from "./brain-provider-readonly-handoff.js";
import { verifyTestEvidence } from "./test-gate.js";
import { commitTask, createTaskBranch, fixturePr, recordGitMetadata } from "./git-workflow.js";
import { validateProjectDirectory } from "./project.js";
import { getProject, loadProjectRegistry } from "./registry.js";
import { ingestReviewFixture } from "./review.js";
import { createMergeRelay, evaluateMergeReadiness, saveMergeReadinessReport } from "./merge-gate.js";
import { resolveSafePath } from "./safe-path.js";
import { createNotificationEvent, redactNotificationEvent, renderNotification } from "./notification.js";
import { globalProjectStatus, loadMultiProjectRegistry, projectStatus, readProjectState, transitionProjectStatus } from "./multi-project.js";
import { saveState } from "./state.js";
import { loadDashboardStatus } from "./dashboard.js";
import { runLiveBrainCycle } from "./live-brain.js";

const HELP = `Hephaestus Phase 10\n\nUsage:\n  hephaestus --help\n  hephaestus status [--config <file>]\n  hephaestus pause --project <id> [--config <file>]\n  hephaestus resume --project <id> [--config <file>]\n  hephaestus stop --project <id> [--config <file>]\n  hephaestus validate [--config <file>] [--project <id>]\n  hephaestus inspect [--config <file>] [--project <id>] [--save-report]\n  hephaestus live-brain [--config <file>] [--project <id>] [--task <task>]\n  hephaestus cycle --project <id> --mock-gpt <fixture> --mock-agent-output <fixture>\n  hephaestus sandbox-run --project <id> --command <allowlisted-id>\n  hephaestus agent-run --project <id> --adapter <fixture-agent> --prompt <relative-file>\n  hephaestus agent-preflight --adapter <id>\n  hephaestus agent-run-plan --project <id> --adapter <id> --prompt <relative-file>\n  hephaestus agent-smoke --project <id> --adapter codex\n  hephaestus agent-discover --adapter codex\n  hephaestus agent-codex-readonly-smoke --project <id>\n  hephaestus agent-codex-readonly-inspect --project <id>\n  hephaestus agent-codex-readonly-inspect-record --project <id>\n  hephaestus agent-codex-readonly-prompt-record --project <id>\n  hephaestus activation-clean-fixture-artifacts --project <id>\n  hephaestus activation-closeout-readonly-codex --project <id> [--write-report]\n  hephaestus activation-mocked-brain-readonly-handoff --project <id>\n  hephaestus activation-provider-brain-readonly-handoff --project <id>\n  hephaestus verify-tests [--config <file>] [--project <id>]\n  hephaestus git-branch --project <id> --task <task-id>\n  hephaestus git-commit --project <id> --message <message>\n  hephaestus pr-open --project <id> --provider fixture-pr --task <task-id>\n  hephaestus review ingest <project-name> --fixture <fixture-name>\n  hephaestus review-ingest --project <id> --source mocked\n  hephaestus merge check <project-name> --fixture <fixture-name>\n  hephaestus merge-check --project <id> [--fixture <fixture-name>]\n  hephaestus merge relay <project-name> --fixture <fixture-name>\n  hephaestus notify render <project-name> --fixture <fixture-name>\n\nCommands:\n  status        List each registered project without mutating state or starting work.\n  pause         Pause only the named project by writing its own STATE.json; other projects are untouched.\n  resume        Resume only the named project by writing its own STATE.json; other projects are untouched.\n  stop          Stop only the named project by writing its own STATE.json; other projects are untouched.\n  validate      Validate one registered project and create its log directory.\n  inspect       Read and summarize one registered project without changing it.\n  live-brain    Run one live configured brain call and save a bounded prompt; never runs an agent.\n  cycle         Run one local mocked brain cycle using declared fixture files.\n  sandbox-run   Run one fixed allowlisted command in an isolated container.\n  agent-run     Run one fixture agent process inside the isolated container.\n  agent-preflight Inspect an adapter without sending a prompt; real adapters cannot execute tasks.\n  agent-run-plan Build a dry-run, secret-free run plan; real-agent execution stays blocked.\n  agent-smoke   Run the hardcoded Codex read-only smoke probe; never sends a project prompt.\n  agent-discover Discover whether Codex CLI documents a safe non-interactive prompt contract.\n  agent-codex-readonly-smoke Run one real Codex exec --sandbox read-only smoke; no project prompt and no writes.\n  agent-codex-readonly-inspect Run one real Codex read-only fixture inspection that emits a structured Step 6G report; no writes.\n  agent-codex-readonly-inspect-record Persist a validated Step 6G read-only Codex inspection as controlled project-local AGENT_OUTPUT.md plus out/agent_outputs/<step-6h>.json; Codex never writes files.\n  agent-codex-readonly-prompt-record Write a controlled Step 6I prompt artifact, read it back, hand off to Codex read-only exec, and persist the validated result.\n  activation-clean-fixture-artifacts Delete only the strictly whitelisted Step 6H/6I activation artifacts under the registered project.\n  activation-closeout-readonly-codex Audit Step 6F-6J read-only Codex activation chain; never runs real Codex; optional --write-report persists a project-local closeout report.\n  activation-mocked-brain-readonly-handoff Generate a controlled mocked brain decision, derive a read-only Codex prompt, hand off, validate, and persist controlled artifacts. No real GPT.\n  activation-provider-brain-readonly-handoff Same as mocked handoff, but decision comes from a formal offline provider interface. No real GPT.\n  verify-tests  Verify the project's recorded test evidence against the declaration.\n  git-branch    Create a deterministic per-task Git branch in the project repo.\n  git-commit    Commit pending project changes with a task-scoped message.\n  pr-open       Produce or update a fixture pull request record for the current task.\n  review ingest Import a declared local review fixture; never contacts providers or merges.\n  review-ingest Import a project's mocked/local review source (--source mocked); never contacts providers or merges.\n  merge check   Evaluate local structured merge evidence and save a readiness report.\n  merge-check   Evaluate a project's local merge evidence (merge-inbox/mocked.json by default); never merges.\n  merge relay   Emit a non-executing merge relay only when readiness is allowed.\n  notify render Render one local notification fixture without sending a message.\n\nSafety:\n  Project status is read-only. Agent prompts must stay inside the selected project. Fixture agents run only through the sandbox. Live brain calls save prompts only and never run coding agents. Merge commands never perform a merge. Notification rendering never contacts Telegram.`;

const DASHBOARD_HELP = HELP
  .replace("Hephaestus Phase 10", "Hephaestus Phase 11")
  .replace("  hephaestus status [--config <file>]", "  hephaestus status [--config <file>]\n  hephaestus dashboard [--config <file>]")
  .replace("  status        List each registered project without mutating state or starting work.", "  status        List each registered project without mutating state or starting work.\n  dashboard     Render a read-only, redacted supervision view; it cannot control projects.")
  .replace("Project status is read-only.", "Project status and dashboard output are read-only.");

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
  let fixturePath;
  let reviewSource;
  const command = args.shift();
  const reviewSubcommand = command === "review" ? args.shift() : undefined;
  const mergeSubcommand = command === "merge" ? args.shift() : undefined;
  const notifySubcommand = command === "notify" ? args.shift() : undefined;
  let reviewProjectId;
  let mergeProjectId;
  let notifyProjectId;
  if (command === "review" && args[0] && !args[0].startsWith("--")) reviewProjectId = args.shift();
  if (command === "merge" && args[0] && !args[0].startsWith("--")) mergeProjectId = args.shift();
  if (command === "notify" && args[0] && !args[0].startsWith("--")) notifyProjectId = args.shift();
  while (args.length > 0) {
    const option = args.shift();
    if (option === "--config") configPath = takeOptionValue(args, option);
    else if (option === "--project") projectId = takeOptionValue(args, option);
    else if (option === "--save-report") saveReport = true;
    else if (option === "--write-report") saveReport = true;
    else if (option === "--mock-gpt") mockGptPath = takeOptionValue(args, option);
    else if (option === "--mock-agent-output") mockAgentOutputPath = takeOptionValue(args, option);
    else if (option === "--command") commandId = takeOptionValue(args, option);
    else if (option === "--adapter") adapterId = takeOptionValue(args, option);
    else if (option === "--prompt") promptPath = takeOptionValue(args, option);
    else if (option === "--task") task = takeOptionValue(args, option);
    else if (option === "--message") message = takeOptionValue(args, option);
    else if (option === "--provider") provider = takeOptionValue(args, option);
    else if (option === "--fixture") fixturePath = takeOptionValue(args, option);
    else if (option === "--source") reviewSource = takeOptionValue(args, option);
    else throw new HephaestusError(`Unknown option: ${option}.`, "INVALID_ARGUMENT");
  }
  return { command, reviewSubcommand, reviewProjectId, mergeSubcommand, mergeProjectId, notifySubcommand, notifyProjectId, configPath, projectId, saveReport, mockGptPath, mockAgentOutputPath, commandId, adapterId, promptPath, task, message, provider, fixturePath, reviewSource };
}

function mergeFixture(allowedRoot, fixturePath) {
  if (!fixturePath) throw new HephaestusError("merge commands require --fixture.", "INVALID_ARGUMENT");
  const file = resolveSafePath(allowedRoot, fixturePath);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new HephaestusError(`merge fixture could not be read: ${error.message}`, "MERGE_FIXTURE_READ_FAILED");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new HephaestusError(`merge fixture contains invalid JSON: ${error.message}`, "MERGE_FIXTURE_INVALID");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new HephaestusError("merge fixture must be a JSON object.", "MERGE_FIXTURE_INVALID");
  }
  return parsed;
}

function notificationFixture(allowedRoot, fixturePath) {
  if (!fixturePath) throw new HephaestusError("notify render requires --fixture.", "INVALID_ARGUMENT");
  const file = resolveSafePath(allowedRoot, fixturePath);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new HephaestusError(`notification fixture could not be read: ${error.message}`, "NOTIFICATION_FIXTURE_READ_FAILED");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new HephaestusError(`notification fixture contains invalid JSON: ${error.message}`, "NOTIFICATION_FIXTURE_INVALID");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new HephaestusError("notification fixture must be a JSON object.", "NOTIFICATION_FIXTURE_INVALID");
  }
  return parsed;
}

// Local-only review sources. Each maps to a project-relative mocked fixture; no source contacts a real provider.
const MOCKED_REVIEW_SOURCES = Object.freeze({ mocked: "review-inbox/mocked.json" });

export const KNOWN_COMMANDS = Object.freeze([
  "status", "dashboard", "validate", "inspect", "live-brain", "cycle", "sandbox-run",
  "agent-run", "agent-preflight", "agent-run-plan", "agent-smoke", "agent-discover",
  "agent-codex-readonly-smoke", "agent-codex-readonly-inspect", "agent-codex-readonly-inspect-record",
  "agent-codex-readonly-prompt-record", "activation-clean-fixture-artifacts",
  "activation-closeout-readonly-codex", "activation-mocked-brain-readonly-handoff",
  "activation-provider-brain-readonly-handoff",
  "verify-tests", "git-branch", "git-commit", "pr-open", "review-ingest", "merge-check",
  "pause", "resume", "stop"
]);

const LIFECYCLE_ACTIONS = Object.freeze(["pause", "resume", "stop"]);

function runInternal(argv, handlers = {}) {
  const { command, reviewSubcommand, reviewProjectId, mergeSubcommand, mergeProjectId, notifySubcommand, notifyProjectId, configPath, projectId, saveReport, mockGptPath, mockAgentOutputPath, commandId, adapterId, promptPath, task, message, provider, fixturePath, reviewSource } = parseArguments(argv);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${DASHBOARD_HELP}\n`);
    return 0;
  }
  const reviewIngest = command === "review" && reviewSubcommand === "ingest";
  const mergeCommand = command === "merge" && ["check", "relay"].includes(mergeSubcommand);
  const notifyRender = command === "notify" && notifySubcommand === "render";
  if (!KNOWN_COMMANDS.includes(command) && !reviewIngest && !mergeCommand && !notifyRender) throw new HephaestusError(`Unknown command: ${command}.`, "INVALID_ARGUMENT");

  if (command === "agent-discover") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("agent-discover only supports --adapter codex.", "INVALID_ARGUMENT");
    const report = runCodexDiscovery();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.classification === "STEP_6E_PASS" ? 0 : 1;
  }

  if (command === "agent-preflight") {
    if (!adapterId) throw new HephaestusError("agent-preflight requires --adapter.", "INVALID_ARGUMENT");
    const preflight = runAgentPreflight({ adapterId });
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    return preflight.available ? 0 : 1;
  }

  const config = loadConfig(path.resolve(configPath));
  if (command === "status") {
    const projects = loadMultiProjectRegistry(config.registryPath, config.allowedRoot);
    process.stdout.write(`${JSON.stringify({ mode: "read-only", projects: globalProjectStatus(projects) }, null, 2)}\n`);
    return 0;
  }
  if (command === "dashboard") {
    process.stdout.write(`${JSON.stringify({ mode: "read-only-dashboard", projects: loadDashboardStatus(config.registryPath, config.allowedRoot) }, null, 2)}\n`);
    return 0;
  }
  if (LIFECYCLE_ACTIONS.includes(command)) {
    if (!projectId) throw new HephaestusError(`${command} requires --project.`, "INVALID_ARGUMENT");
    // Multi-project registry enforces per-project path/resource isolation; unknown ids fail here, missing paths fail in readProjectState.
    const registered = loadMultiProjectRegistry(config.registryPath, config.allowedRoot);
    const target = registered.find((entry) => entry.id === projectId);
    if (!target) throw new HephaestusError(`Project is not registered: ${projectId}.`, "PROJECT_NOT_REGISTERED");
    const next = transitionProjectStatus(readProjectState(target), command);
    // saveState writes only <project.path>/STATE.json (in-root, atomic); no logs, no external calls, no agents.
    saveState(target.path, next);
    process.stdout.write(`${JSON.stringify({ mode: "lifecycle", project: target.id, action: command, status: projectStatus(next), nextAction: next.nextAction }, null, 2)}\n`);
    return 0;
  }
  const projects = loadProjectRegistry(config.registryPath, config.allowedRoot);
  let project;
  if (notifyRender) {
    if (notifyProjectId && projectId && notifyProjectId !== projectId) throw new HephaestusError("notify render received conflicting project targets.", "INVALID_ARGUMENT");
    const target = notifyProjectId ?? projectId;
    if (!target) throw new HephaestusError("notify render requires an explicit <project-name> or --project target.", "INVALID_ARGUMENT");
    project = getProject(projects, target);
    validateProjectDirectory(config.allowedRoot, project.path);
    const event = createNotificationEvent(notificationFixture(config.allowedRoot, fixturePath));
    process.stdout.write(`${JSON.stringify({ mode: "render-only", event: redactNotificationEvent(event), message: renderNotification(event) }, null, 2)}\n`);
    return 0;
  }
  if (mergeCommand) {
    if (mergeProjectId && projectId && mergeProjectId !== projectId) throw new HephaestusError("merge command received conflicting project targets.", "INVALID_ARGUMENT");
    const target = mergeProjectId ?? projectId;
    if (!target) throw new HephaestusError("merge command requires an explicit <project-name> or --project target.", "INVALID_ARGUMENT");
    project = getProject(projects, target);
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const fixture = mergeFixture(config.allowedRoot, fixturePath);
    const report = evaluateMergeReadiness({ projectPath: validated.path, state: validated.state, input: fixture, now: fixture.now });
    const reportPath = saveMergeReadinessReport(validated.path, { reportMode: "legacy", ...report });
    const relay = mergeSubcommand === "relay" && report.allowed ? createMergeRelay(report) : null;
    process.stdout.write(`${JSON.stringify({ allowed: report.allowed, blockers: report.blockers, reportPath, relay }, null, 2)}\n`);
    return report.allowed ? 0 : 1;
  }
  if (reviewIngest) {
    if (reviewProjectId && projectId && reviewProjectId !== projectId) {
      throw new HephaestusError("review ingest received conflicting project targets.", "INVALID_ARGUMENT");
    }
    const reviewTarget = reviewProjectId ?? projectId;
    if (!reviewTarget) {
      throw new HephaestusError("review ingest requires an explicit <project-name> or --project target.", "INVALID_ARGUMENT");
    }
    if (!fixturePath) throw new HephaestusError("review ingest requires --fixture.", "INVALID_ARGUMENT");
    project = getProject(projects, reviewTarget);
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const result = ingestReviewFixture({ allowedRoot: config.allowedRoot, projectPath: validated.path, fixturePath, state: validated.state });
    process.stdout.write(`${JSON.stringify({ status: result.status, duplicateCount: result.duplicateCount ?? 0, review: result.state.review, notesPath: result.notesPath ?? null, reportPath: result.reportPath ?? null }, null, 2)}\n`);
    return result.status === "completed" ? 0 : 1;
  }
  if (command === "review-ingest") {
    if (!projectId) throw new HephaestusError("review-ingest requires --project.", "INVALID_ARGUMENT");
    const source = reviewSource ?? "mocked";
    const relativeSource = MOCKED_REVIEW_SOURCES[source];
    if (!relativeSource) throw new HephaestusError(`review-ingest only supports --source ${Object.keys(MOCKED_REVIEW_SOURCES).join(", ")}; received: ${source}.`, "INVALID_ARGUMENT");
    project = getProject(projects, projectId);
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const relativeProjectPath = path.relative(path.resolve(config.allowedRoot), validated.path);
    const sourceFixturePath = path.join(relativeProjectPath, relativeSource);
    const result = ingestReviewFixture({ allowedRoot: config.allowedRoot, projectPath: validated.path, fixturePath: sourceFixturePath, state: validated.state });
    process.stdout.write(`${JSON.stringify({ status: result.status, source, duplicateCount: result.duplicateCount ?? 0, review: result.state.review, notesPath: result.notesPath ?? null, reportPath: result.reportPath ?? null }, null, 2)}\n`);
    return result.status === "completed" ? 0 : 1;
  }
  if (command === "merge-check") {
    if (!projectId) throw new HephaestusError("merge-check requires --project.", "INVALID_ARGUMENT");
    project = getProject(projects, projectId);
    const validated = validateProjectDirectory(config.allowedRoot, project.path);
    const relativeProjectPath = path.relative(path.resolve(config.allowedRoot), validated.path);
    // Local structured merge evidence only: a project-relative file or an explicit --fixture. Never contacts Git or GitHub.
    const evidencePath = fixturePath ?? path.join(relativeProjectPath, "merge-inbox", "mocked.json");
    const evidence = mergeFixture(config.allowedRoot, evidencePath);
    const report = evaluateMergeReadiness({ projectPath: validated.path, state: validated.state, input: evidence, now: evidence.now });
    const headSha = { approved: report.approval?.headCommit ?? null, current: report.pr?.headCommit ?? null };
    headSha.match = headSha.approved !== null && headSha.approved === headSha.current;
    const gatesChecked = ["state", "implementation", "tests", "retest-after-fix", "reviews", "gpt-approval", "git-pr", "safety"];
    const reportPath = saveMergeReadinessReport(validated.path, { reportMode: "merge-check", ready: report.allowed, gatesChecked, headSha, ...report });
    process.stdout.write(`${JSON.stringify({ ready: report.allowed, blockers: report.blockers.map((item) => item.code), gatesChecked, headSha, reportPath }, null, 2)}\n`);
    return report.allowed ? 0 : 1;
  }
  project = getProject(projects, projectId ?? projects[0]?.id);
  if (command === "inspect") {
    const projectState = inspectProject(config.allowedRoot, project.path);
    const reportPath = saveReport ? saveInspectionReport(projectState) : null;
    process.stdout.write(`${JSON.stringify(toInspectionSummary(projectState, reportPath), null, 2)}\n`);
    return 0;
  }

  if (command === "live-brain") {
    if (typeof handlers.liveBrain !== "function") throw new HephaestusError("live-brain requires the async CLI runner.", "INVALID_ARGUMENT");
    return handlers.liveBrain({ config, project, task });
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

  if (command === "agent-smoke") {
    if (adapterId !== "codex") throw new HephaestusError("agent-smoke requires --adapter codex.", "INVALID_ARGUMENT");
    const smoke = runCodexSmoke({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      explicitSmokePermit: true,
      autoApproval: false
    });
    process.stdout.write(`${JSON.stringify(smoke, null, 2)}\n`);
    return smoke.status === "completed" && smoke.projectMutated === false ? 0 : 1;
  }

  if (command === "agent-codex-readonly-smoke") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("agent-codex-readonly-smoke only supports --adapter codex.", "INVALID_ARGUMENT");
    const smoke = runCodexReadonlySmoke({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      explicitReadonlySmokePermit: true
    });
    process.stdout.write(`${JSON.stringify(smoke, null, 2)}\n`);
    return smoke.classification === "STEP_6F_PASS" ? 0 : 1;
  }

  if (command === "agent-codex-readonly-inspect") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("agent-codex-readonly-inspect only supports --adapter codex.", "INVALID_ARGUMENT");
    const inspect = runCodexReadonlyInspect({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      explicitReadonlyInspectPermit: true
    });
    process.stdout.write(`${JSON.stringify(inspect, null, 2)}\n`);
    return inspect.classification === "STEP_6G_PASS" ? 0 : 1;
  }

  if (command === "agent-codex-readonly-inspect-record") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("agent-codex-readonly-inspect-record only supports --adapter codex.", "INVALID_ARGUMENT");
    const record = runCodexReadonlyInspectRecord({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      explicitReadonlyInspectRecordPermit: true
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return record.classification === "STEP_6H_PASS" ? 0 : 1;
  }

  if (command === "agent-codex-readonly-prompt-record") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("agent-codex-readonly-prompt-record only supports --adapter codex.", "INVALID_ARGUMENT");
    const record = runCodexReadonlyPromptRecord({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      explicitReadonlyPromptRecordPermit: true
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return record.classification === "STEP_6I_PASS" ? 0 : 1;
  }

  if (command === "activation-clean-fixture-artifacts") {
    const result = runActivationFixtureCleanup({
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      explicitCleanupPermit: true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.cleanupSafe ? 0 : 1;
  }

  if (command === "activation-closeout-readonly-codex") {
    const result = runActivationCloseoutReadonlyCodex({
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      knownCommands: [...KNOWN_COMMANDS],
      explicitCloseoutPermit: true,
      writeReport: saveReport === true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.closeoutPassed ? 0 : 1;
  }

  if (command === "activation-mocked-brain-readonly-handoff") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("activation-mocked-brain-readonly-handoff only supports --adapter codex.", "INVALID_ARGUMENT");
    const result = runActivationMockedBrainReadonlyHandoff({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      explicitMockedBrainHandoffPermit: true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.classification === "STEP_6L_PASS" ? 0 : 1;
  }

  if (command === "activation-provider-brain-readonly-handoff") {
    if (adapterId !== undefined && adapterId !== "codex") throw new HephaestusError("activation-provider-brain-readonly-handoff only supports --adapter codex.", "INVALID_ARGUMENT");
    const result = runActivationProviderBrainReadonlyHandoff({
      adapterId: "codex",
      allowedRoot: config.allowedRoot,
      projectPath: project.path,
      projectId: project.id,
      explicitProviderHandoffPermit: true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.classification === "STEP_6M_PASS" ? 0 : 1;
  }

  if (command === "agent-run-plan") {
    if (!adapterId || !promptPath) throw new HephaestusError("agent-run-plan requires --adapter and --prompt.", "INVALID_ARGUMENT");
    const plan = createAgentRunPlan({
      adapterId,
      projectName: project.id,
      projectPath: project.path,
      allowedRoot: config.allowedRoot,
      promptPath
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
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

export function run(argv) {
  return runInternal(argv);
}

export async function runAsync(argv) {
  return runInternal(argv, {
    liveBrain: async ({ config, project, task }) => {
      const promptOutputPath = path.join(path.dirname(config.configPath), "out", "prompts", "next-task.md");
      const cycle = await runLiveBrainCycle({
        allowedRoot: config.allowedRoot,
        projectPath: project.path,
        brain: config.brain,
        task,
        projectName: project.id,
        promptOutputPath
      });
      process.stdout.write(`${JSON.stringify({
        status: "completed",
        provider: cycle.provider,
        projectPath: cycle.projectPath,
        promptPath: cycle.promptPath,
        requestedTask: cycle.requestedTask,
        nextAction: cycle.decision.nextAction
      }, null, 2)}\n`);
      return 0;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAsync(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Hephaestus error: ${message}\n`);
    process.exitCode = 1;
  }
}
