import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { runMultiProjectLoops } from "../src/conductor.js";
import { HephaestusError } from "../src/errors.js";
import { loadMultiProjectRegistry, projectResource } from "../src/multi-project.js";
import { resolveSafePath } from "../src/safe-path.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const baseState = Object.freeze({
  currentPhase: "9", currentTask: "multi-project", currentBranch: "main", currentPr: null, assignedAgent: null,
  attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null,
  mergeStatus: "not-started", containerStatus: "healthy", lastGptDecision: null, nextAction: "project-idle"
});

const decision = Object.freeze({
  nextAction: "implement-safe-change",
  rationale: "Fixture decision for a deterministic multi-project run.",
  allowedFiles: ["src/demo.js"],
  requiredTests: ["npm test"],
  stopConditions: ["Stop if required files are missing."]
});

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }
function capture(action) {
  let output = ""; const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try { action(); } finally { process.stdout.write = original; }
  return output;
}

function makeProject(root, id, state = baseState) {
  const project = path.join(root, id);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "PLAN.md"), `# ${id} plan goal\n\nBuild the ${id} project.\n`);
  for (const file of ["BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, file), `${id}\n`);
  writeJson(path.join(project, "STATE.json"), state);
  return project;
}

function entry(id) {
  return {
    id, path: id, assignedAgent: `fixture-agent-${id}`,
    container: { id: `hephaestus-${id}`, workspace: "/workspace" },
    paths: { state: "STATE.json", log: "BUILD_LOG.md", prompts: "out/prompts", testReports: "out/test_reports" }
  };
}

function context(states = {}) {
  const directory = writableTemporaryDirectory("hephaestus-phase9-parallel-");
  const root = path.join(directory, "projects");
  makeProject(root, "alpha", states.alpha ?? baseState);
  makeProject(root, "beta", states.beta ?? baseState);
  fs.mkdirSync(path.join(root, "mocks"));
  writeJson(path.join(root, "mocks", "decision.json"), decision);
  fs.writeFileSync(path.join(root, "mocks", "agent-output.md"), "# Mock agent output\n\nNo command ran.\n");
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: [entry("beta"), entry("alpha")] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, registry, config, mockGpt: "mocks/decision.json", mockAgent: "mocks/agent-output.md" };
}

function withFetchGuard(action) {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("multi-project run must not contact external services"); };
  try { action(() => fetchCalled); } finally { globalThis.fetch = originalFetch; }
}

function runArgs(c) { return ["run", "--mock-gpt", c.mockGpt, "--mock-agent-output", c.mockAgent, "--config", c.config]; }

test("one invocation runs two registered project loops that each write only inside their own paths", () => {
  const c = context();
  withFetchGuard((wasFetchCalled) => {
    try {
      const output = capture(() => assert.equal(run(runArgs(c)), 0));
      const result = JSON.parse(output);
      assert.equal(result.mode, "multi-project-run");
      assert.deepEqual(result.results.map((item) => [item.id, item.result]), [["alpha", "completed"], ["beta", "completed"]]);
      for (const id of ["alpha", "beta"]) {
        const other = id === "alpha" ? "beta" : "alpha";
        const prompt = fs.readFileSync(path.join(c.root, id, "out", "prompts", "next-task.md"), "utf8");
        assert.ok(prompt.includes(id), `${id} prompt should reference its own plan`);
        assert.ok(!prompt.includes(`${other} plan goal`), `${id} prompt must not leak ${other}'s plan`);
        assert.ok(fs.readFileSync(path.join(c.root, id, "AGENT_OUTPUT.md"), "utf8").includes("Mock agent output"));
        assert.ok(fs.readFileSync(path.join(c.root, id, "BUILD_LOG.md"), "utf8").includes("mock-cycle"));
      }
      // No root-level STATE.json or BUILD_LOG.md is ever created outside a project directory.
      for (const stray of ["STATE.json", "BUILD_LOG.md"]) assert.equal(fs.existsSync(path.join(c.directory, stray)), false);
      assert.equal(wasFetchCalled(), false);
    } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
  });
});

test("a failing project is isolated as failed and does not stop or corrupt another project", () => {
  const c = context();
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    let betaRan = false;
    const results = runMultiProjectLoops(projects, (target) => {
      if (target.id === "alpha") throw new HephaestusError("agent crashed", "AGENT_CRASHED");
      betaRan = true;
      return { status: "completed", detail: "beta-ok" };
    });
    assert.deepEqual(results.map((item) => [item.id, item.result]), [["alpha", "failed"], ["beta", "completed"]]);
    assert.equal(results.find((item) => item.id === "alpha").detail, "AGENT_CRASHED");
    assert.equal(betaRan, true);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("a blocker in one project is captured without stopping another project", () => {
  const c = context();
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    const results = runMultiProjectLoops(projects, (target) => (target.id === "alpha" ? { status: "blocked", detail: "manual-review" } : { status: "completed" }));
    assert.deepEqual(results.map((item) => [item.id, item.result]), [["alpha", "blocked"], ["beta", "completed"]]);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("a paused project is skipped while the other project still runs", () => {
  const c = context({ alpha: { ...baseState, usageLimitPaused: true, nextAction: "agent-usage-limit-paused" } });
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    const ran = [];
    const results = runMultiProjectLoops(projects, (target) => { ran.push(target.id); return { status: "completed" }; });
    assert.deepEqual(results.map((item) => [item.id, item.result]), [["alpha", "paused"], ["beta", "completed"]]);
    assert.deepEqual(ran, ["beta"]); // alpha's loop never started
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("a stopped project is skipped while the other project still runs", () => {
  const c = context({ alpha: { ...baseState, nextAction: "project-stopped" } });
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    const ran = [];
    const results = runMultiProjectLoops(projects, (target) => { ran.push(target.id); return { status: "completed" }; });
    assert.deepEqual(results.map((item) => [item.id, item.result]), [["alpha", "stopped"], ["beta", "completed"]]);
    assert.deepEqual(ran, ["beta"]);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("a usage-limit pause affects only the paused project's own agent assignment", () => {
  const c = context({ alpha: { ...baseState, usageLimitPaused: true, nextAction: "agent-usage-limit-paused" } });
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    const results = runMultiProjectLoops(projects, () => ({ status: "completed" }));
    const alpha = results.find((item) => item.id === "alpha");
    const beta = results.find((item) => item.id === "beta");
    assert.equal(alpha.result, "paused");
    assert.equal(beta.result, "completed");
    assert.notEqual(alpha.assignedAgent, beta.assignedAgent); // distinct agents; only alpha's is paused
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("per-project container identity and assigned agent stay distinct across the run", () => {
  const c = context();
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    const results = runMultiProjectLoops(projects, () => ({ status: "completed" }));
    assert.notEqual(results[0].container.id, results[1].container.id);
    assert.notEqual(results[0].assignedAgent, results[1].assignedAgent);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("project A cannot reach project B files during a run", () => {
  const c = context();
  withFetchGuard((wasFetchCalled) => {
    try {
      const [alpha, beta] = loadMultiProjectRegistry(c.registry, c.root);
      assert.throws(() => resolveSafePath(alpha.path, "../beta/STATE.json"), (error) => code(error, "UNSAFE_PATH"));
      capture(() => assert.equal(run(runArgs(c)), 0));
      // After a real run, neither project's prompt contains the other's distinctive plan goal.
      const alphaPrompt = fs.readFileSync(path.join(alpha.path, "out", "prompts", "next-task.md"), "utf8");
      const betaPrompt = fs.readFileSync(path.join(beta.path, "out", "prompts", "next-task.md"), "utf8");
      assert.ok(!alphaPrompt.includes("beta plan goal") && !betaPrompt.includes("alpha plan goal"));
      // Beta's state file was not touched by alpha's write and stays outside alpha's root.
      assert.notEqual(projectResource(alpha, "state"), projectResource(beta, "state"));
      assert.equal(wasFetchCalled(), false);
    } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
  });
});

test("global status still reports each project independently after a multi-project run", () => {
  const c = context();
  try {
    capture(() => assert.equal(run(runArgs(c)), 0));
    const output = capture(() => assert.equal(run(["status", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only");
    assert.deepEqual(result.projects.map((item) => [item.id, item.status]), [["alpha", "idle"], ["beta", "idle"]]);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("run requires explicit mock fixtures and never guesses a provider", () => {
  const c = context();
  try {
    assert.throws(() => run(["run", "--config", c.config]), (error) => code(error, "INVALID_ARGUMENT"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
