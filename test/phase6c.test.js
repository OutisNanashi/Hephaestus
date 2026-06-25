import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkAgentPermit, permitForFixtureExecution } from "../src/agent-permit.js";
import { createAgentRunPlan } from "../src/agent-run-plan.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const validState = Object.freeze({
  currentPhase: "6C", currentTask: "real-agent-permit-and-plan", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext(prompt = "# Delivered prompt\n\nDo the declared task.\n") {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(path.join(projectPath, "out", "prompts"), { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Agent project\n",
    "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n\nExisting entry.\n",
    "CURRENT_TASK.md": "# Run task\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  fs.writeFileSync(path.join(projectPath, "out", "prompts", "next-task.md"), prompt);
  return { directory, allowedRoot, projectPath, promptPath: "out/prompts/next-task.md" };
}

function baseRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    projectName: "demo-project",
    projectPath: context.projectPath,
    allowedRoot: context.allowedRoot,
    promptPath: context.promptPath,
    dryRun: true,
    executionRequested: false,
    autoApproval: false,
    ...overrides
  };
}

test("fixture execution permit is allowed when sandbox is ready and reflects intent to mutate project state", () => {
  const context = makeContext();
  try {
    const permit = permitForFixtureExecution(baseRequest(context, { adapterId: "fixture-agent" }));
    assert.equal(permit.allowed, true);
    assert.equal(permit.mode, "execution");
    assert.equal(permit.executionWouldStart, true);
    assert.equal(permit.projectStateWouldMutate, true);
    assert.equal(permit.promptSent, false);
    assert.deepEqual(permit.reasonCodes, []);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("dry-run plans for codex, claude-code, and opencode are created with execution blocked", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["codex", "claude-code", "opencode"]) {
      const plan = createAgentRunPlan(baseRequest(context, { adapterId }));
      assert.equal(plan.adapter.id, adapterId);
      assert.equal(plan.adapter.kind, "real");
      assert.equal(plan.adapter.executionAllowed, false);
      assert.equal(plan.execution.status, "planned");
      assert.equal(plan.execution.executionWouldStart, false);
      assert.equal(plan.execution.promptSent, false);
      assert.equal(plan.execution.projectStateWouldMutate, false);
      assert.equal(plan.invocation.shell, false);
      assert.equal(plan.invocation.autoApproval, false);
      assert.equal(plan.invocation.argv, null);
      assert.equal(plan.safetyChecklist.realAgentExecutionDenied, true);
      assert.equal(plan.safetyChecklist.shellFalse, true);
      assert.equal(plan.safetyChecklist.noProjectMutation, true);
      assert.equal(plan.safetyChecklist.invocationContractDefined, false);
      assert.equal(plan.prompt.includedContent, false);
      assert.equal(plan.prompt.content, null);
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("requesting execution for a real adapter is rejected with REAL_AGENT_EXECUTION_DISABLED in reason codes", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["codex", "claude-code", "opencode"]) {
      const permit = checkAgentPermit(baseRequest(context, { adapterId, dryRun: false, executionRequested: true }));
      assert.equal(permit.allowed, false);
      assert.equal(permit.executionWouldStart, false);
      assert.equal(permit.projectStateWouldMutate, false);
      assert.ok(permit.reasonCodes.includes("REAL_AGENT_EXECUTION_DISABLED"));
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("unknown adapter is rejected, even before path resolution side effects", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => checkAgentPermit(baseRequest(context, { adapterId: "made-up-agent" })),
      (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("missing, empty, traversal, and outside-root prompt paths are rejected by name", () => {
  const context = makeContext();
  try {
    fs.rmSync(path.join(context.projectPath, context.promptPath));
    assert.throws(() => checkAgentPermit(baseRequest(context)), (error) => code(error, "PATH_RESOLUTION_FAILED"));
    fs.writeFileSync(path.join(context.projectPath, context.promptPath), "   \n\n");
    assert.throws(() => checkAgentPermit(baseRequest(context)), (error) => code(error, "EMPTY_AGENT_PROMPT"));
    fs.writeFileSync(path.join(context.projectPath, context.promptPath), "# OK\n");
    assert.throws(() => checkAgentPermit(baseRequest(context, { promptPath: "../outside.md" })), (error) => code(error, "INVALID_AGENT_PROMPT_PATH"));
    assert.throws(() => checkAgentPermit(baseRequest(context, { projectPath: context.directory })), (error) => code(error, "OUTSIDE_ALLOWED_ROOT"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("auto-approval for a real adapter is rejected via reason codes, not silently permitted", () => {
  const context = makeContext();
  try {
    const permit = checkAgentPermit(baseRequest(context, { autoApproval: true }));
    assert.equal(permit.allowed, false);
    assert.ok(permit.reasonCodes.includes("REAL_AGENT_AUTO_APPROVAL_DISABLED"));
    const plan = createAgentRunPlan(baseRequest(context, { autoApproval: true }));
    assert.equal(plan.execution.status, "blocked");
    assert.ok(plan.execution.reasonCodes.includes("REAL_AGENT_AUTO_APPROVAL_DISABLED"));
    assert.equal(plan.invocation.autoApproval, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("explicit real-agent permit flag is still denied in Step 6C", () => {
  const context = makeContext();
  try {
    const permit = checkAgentPermit(baseRequest(context, { explicitRealAgentPermit: true, executionRequested: true, dryRun: false }));
    assert.equal(permit.allowed, false);
    assert.ok(permit.reasonCodes.includes("REAL_AGENT_EXECUTION_DISABLED"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("permit rejects unsupported request keys so user-supplied executable or shell command cannot be smuggled in", () => {
  const context = makeContext();
  try {
    for (const evilKey of ["executable", "command", "shellCommand", "argv", "env"]) {
      assert.throws(
        () => checkAgentPermit({ ...baseRequest(context), [evilKey]: "/bin/sh -c 'rm -rf /'" }),
        (error) => code(error, "INVALID_PERMIT_REQUEST")
      );
    }
    assert.throws(() => checkAgentPermit({ ...baseRequest(context), secretsPolicy: { allowSecretEnvironment: true } }), (error) => code(error, "UNSAFE_SECRETS_POLICY"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("dry-run planning does not mutate project files and never spawns a process", () => {
  const context = makeContext();
  try {
    const buildLogBefore = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    const stateBefore = fs.readFileSync(path.join(context.projectPath, "STATE.json"), "utf8");
    const promptBefore = fs.readFileSync(path.join(context.projectPath, context.promptPath), "utf8");
    const plan = createAgentRunPlan(baseRequest(context));
    assert.equal(plan.execution.executionWouldStart, false);
    assert.equal(plan.execution.promptSent, false);
    assert.equal(fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8"), buildLogBefore);
    assert.equal(fs.readFileSync(path.join(context.projectPath, "STATE.json"), "utf8"), stateBefore);
    assert.equal(fs.readFileSync(path.join(context.projectPath, context.promptPath), "utf8"), promptBefore);
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_runs", "current", "prompt.md")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("run plan excludes prompt full content and any secret-shaped strings by default", () => {
  const promptText = "# Plan\n\nOPENAI_API_KEY=sk-abcdefghijklmnop1234567890ZZZZ\ntoken=ghp_ABCDEFGHIJ1234567890zzzz\n";
  const context = makeContext(promptText);
  try {
    const plan = createAgentRunPlan(baseRequest(context));
    const serialized = JSON.stringify(plan);
    assert.equal(plan.prompt.includedContent, false);
    assert.equal(plan.prompt.content, null);
    assert.equal(serialized.includes("sk-abcdefghijklmnop1234567890ZZZZ"), false);
    assert.equal(serialized.includes("ghp_ABCDEFGHIJ1234567890zzzz"), false);
    assert.equal(serialized.includes("OPENAI_API_KEY="), false);
    assert.equal(plan.invocation.shell, false);
    assert.equal(plan.invocation.executable, "codex");
    assert.equal(plan.invocation.argv, null);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-run-plan emits a JSON plan, mutates no files, and reports execution blocked inside the plan", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = runCli(["agent-run-plan", "--config", configPath, "--project", "demo-project", "--adapter", "codex", "--prompt", context.promptPath]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapter.id, "codex");
    assert.equal(parsed.execution.status, "planned");
    assert.equal(parsed.execution.executionWouldStart, false);
    assert.equal(parsed.execution.promptSent, false);
    assert.equal(parsed.invocation.shell, false);
    assert.equal(parsed.invocation.argv, null);
    assert.equal(parsed.prompt.includedContent, false);
    assert.equal(parsed.prompt.content, null);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_runs", "current", "prompt.md")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-run-plan rejects unknown project and unknown adapter before doing any work", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      assert.throws(
        () => runCli(["agent-run-plan", "--config", configPath, "--project", "demo-project", "--adapter", "made-up-agent", "--prompt", context.promptPath]),
        (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE")
      );
      assert.throws(
        () => runCli(["agent-run-plan", "--config", configPath, "--project", "missing-project", "--adapter", "codex", "--prompt", context.promptPath]),
        (error) => code(error, "PROJECT_NOT_REGISTERED")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("run plan reports a stable sha256 of the prompt without storing prompt content", () => {
  const context = makeContext("# Stable prompt\n");
  try {
    const planA = createAgentRunPlan(baseRequest(context));
    const planB = createAgentRunPlan(baseRequest(context));
    assert.equal(planA.prompt.sha256, planB.prompt.sha256);
    assert.equal(typeof planA.prompt.sha256, "string");
    assert.equal(planA.prompt.sha256.length, 64);
    assert.equal(planA.prompt.sizeBytes > 0, true);
    assert.equal(planA.prompt.content, null);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
