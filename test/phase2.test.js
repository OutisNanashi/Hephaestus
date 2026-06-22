import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createBrainRequest } from "../src/brain.js";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { inspectProject } from "../src/inspection.js";
import { runMockCycle } from "../src/mock-cycle.js";
import { loadState } from "../src/state.js";

const validState = Object.freeze({
  currentPhase: "2",
  currentTask: "run-mocked-brain-cycle",
  currentBranch: "main",
  currentPr: null,
  assignedAgent: null,
  attemptCount: 0,
  blocked: false,
  usageLimitPaused: false,
  lastSuccessfulStep: null,
  reviewStatus: "not-started",
  mergeStatus: "not-started",
  containerStatus: "not-started",
  lastGptDecision: null,
  nextAction: "cycle"
});

const validDecision = Object.freeze({
  nextAction: "implement-safe-change",
  rationale: "The plan and current state provide enough context for the declared task.",
  allowedFiles: ["src/demo.js", "test/demo.test.js"],
  requiredTests: ["npm test"],
  stopConditions: ["Stop if required files are missing.", "Stop if tests fail."]
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeContext() {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "PLAN.md"), "# Demonstration project goal\n\nBuild a safe demonstration.\n");
  fs.writeFileSync(path.join(projectPath, "BUILDING_REFERENCE.md"), "# Reference\n");
  fs.writeFileSync(path.join(projectPath, "BUILD_LOG.md"), "# Build log\n\nExisting history remains.\n");
  fs.writeFileSync(path.join(projectPath, "CURRENT_TASK.md"), "# Current task\n\nRun a mocked cycle.\n");
  writeJson(path.join(projectPath, "STATE.json"), validState);
  fs.mkdirSync(path.join(allowedRoot, "mocks"));
  writeJson(path.join(allowedRoot, "mocks", "decision.json"), validDecision);
  fs.writeFileSync(path.join(allowedRoot, "mocks", "agent-output.md"), "# Mock agent output\n\nNo command ran.\n");
  const configPath = path.join(directory, "config.json");
  writeJson(configPath, {
    allowedRoot: "./projects",
    registryPath: "./projects.json",
    logDirectory: "./logs"
  });
  writeJson(path.join(directory, "projects.json"), {
    projects: [{ id: "demo-project", path: "demo-project" }]
  });
  return {
    directory,
    allowedRoot,
    projectPath,
    configPath,
    mockGptPath: "mocks/decision.json",
    mockAgentOutputPath: "mocks/agent-output.md"
  };
}

function runSuccessfulCycle(context) {
  return runMockCycle({
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    mockGptPath: context.mockGptPath,
    mockAgentOutputPath: context.mockAgentOutputPath
  });
}

function assertCode(error, code) {
  assert.ok(error instanceof HephaestusError);
  assert.equal(error.code, code);
  return true;
}

function captureOutput(action) {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...args) => {
    output += chunk;
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

test("brain request is created from normalized project state", () => {
  const context = makeContext();
  try {
    const request = createBrainRequest(inspectProject(context.allowedRoot, context.projectPath));
    assert.equal(request.projectPath, fs.realpathSync(context.projectPath));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("brain request includes PLAN.md-derived project goal", () => {
  const context = makeContext();
  try {
    assert.equal(createBrainRequest(inspectProject(context.allowedRoot, context.projectPath)).projectGoal, "Demonstration project goal");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("brain request includes the current phase", () => {
  const context = makeContext();
  try {
    assert.equal(createBrainRequest(inspectProject(context.allowedRoot, context.projectPath)).currentPhase, validState.currentPhase);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("brain request includes the current task", () => {
  const context = makeContext();
  try {
    assert.equal(createBrainRequest(inspectProject(context.allowedRoot, context.projectPath)).currentTask, validState.currentTask);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("mocked cycle creates a generated prompt file", () => {
  const context = makeContext();
  try {
    const result = runSuccessfulCycle(context);
    assert.ok(fs.statSync(result.promptPath).isFile());
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("cycle command runs one declared mocked cycle through the registry", () => {
  const context = makeContext();
  try {
    const output = captureOutput(() => assert.equal(run([
      "cycle", "--config", context.configPath, "--project", "demo-project",
      "--mock-gpt", context.mockGptPath, "--mock-agent-output", context.mockAgentOutputPath
    ]), 0));
    const result = JSON.parse(output);
    assert.equal(result.status, "completed");
    assert.equal(result.projectPath, fs.realpathSync(context.projectPath));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("generated prompt includes project goal, phase, and task", () => {
  const context = makeContext();
  try {
    const prompt = fs.readFileSync(runSuccessfulCycle(context).promptPath, "utf8");
    assert.match(prompt, /Demonstration project goal/u);
    assert.match(prompt, new RegExp(`Current phase: ${validState.currentPhase}`, "u"));
    assert.match(prompt, new RegExp(`Current task: ${validState.currentTask}`, "u"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("generated prompt includes allowed files, tests, and stop conditions", () => {
  const context = makeContext();
  try {
    const prompt = fs.readFileSync(runSuccessfulCycle(context).promptPath, "utf8");
    assert.match(prompt, /src\/demo\.js/u);
    assert.match(prompt, /npm test/u);
    assert.match(prompt, /Stop if required files are missing\./u);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("STATE.json records the validated mocked decision", () => {
  const context = makeContext();
  try {
    runSuccessfulCycle(context);
    const state = loadState(context.projectPath);
    assert.equal(state.nextAction, validDecision.nextAction);
    assert.deepEqual(JSON.parse(state.lastGptDecision), validDecision);
    assert.equal(state.blocked, false);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("empty mocked GPT response is rejected", () => {
  const context = makeContext();
  try {
    fs.writeFileSync(path.join(context.allowedRoot, context.mockGptPath), "\n");
    assert.throws(() => runSuccessfulCycle(context), (error) => assertCode(error, "EMPTY_MOCK_RESPONSE"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("malformed mocked GPT decision is rejected", () => {
  const context = makeContext();
  try {
    writeJson(path.join(context.allowedRoot, context.mockGptPath), { nextAction: "missing-required-fields" });
    assert.throws(() => runSuccessfulCycle(context), (error) => assertCode(error, "INVALID_MOCK_DECISION"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("mock provider failure becomes blocked and retryable state", () => {
  const context = makeContext();
  try {
    writeJson(path.join(context.allowedRoot, context.mockGptPath), {
      providerFailure: true,
      message: "Temporary mock outage.",
      retryable: true
    });
    const result = runSuccessfulCycle(context);
    const state = loadState(context.projectPath);
    assert.equal(result.status, "blocked");
    assert.equal(state.blocked, true);
    assert.equal(state.nextAction, "retry-mock-gpt");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("mocked agent output is saved to AGENT_OUTPUT.md", () => {
  const context = makeContext();
  try {
    const result = runSuccessfulCycle(context);
    assert.equal(fs.readFileSync(result.agentOutputPath, "utf8"), "# Mock agent output\n\nNo command ran.\n");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("BUILD_LOG.md receives an append-only cycle entry", () => {
  const context = makeContext();
  try {
    const before = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    runSuccessfulCycle(context);
    const after = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    assert.ok(after.startsWith(before));
    assert.match(after, /\[phase-2-mock-cycle\] status=completed/u);
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("mock cycle has no terminal-command execution capability", () => {
  const source = fs.readFileSync(path.resolve("src/mock-cycle.js"), "utf8");
  assert.doesNotMatch(source, /node:child_process|execFile|spawn\(/u);
});

test("mock provider has no real GPT or API call capability", () => {
  const source = fs.readFileSync(path.resolve("src/mock-provider.js"), "utf8");
  assert.doesNotMatch(source, /https?:\/\/|fetch\(/u);
});

test("mock cycle has no real coding-agent execution capability", () => {
  const source = fs.readFileSync(path.resolve("src/mock-cycle.js"), "utf8");
  assert.doesNotMatch(source, /child_process|spawnSync|spawn\(/u);
});

test("mock cycle has no container runner capability", () => {
  const source = fs.readFileSync(path.resolve("src/mock-cycle.js"), "utf8");
  assert.doesNotMatch(source, /docker|podman|container runtime/u);
});
