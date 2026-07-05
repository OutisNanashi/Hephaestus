import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { globalProjectStatus, loadMultiProjectRegistry, projectResource, projectStatus, transitionProjectStatus } from "../src/multi-project.js";
import { resolveSafePath } from "../src/safe-path.js";
import { saveState } from "../src/state.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const baseState = Object.freeze({
  currentPhase: "9", currentTask: "multi-project", currentBranch: "main", currentPr: null, assignedAgent: null,
  attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null,
  mergeStatus: "not-started", containerStatus: "healthy", lastGptDecision: null, nextAction: "project-idle"
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
  for (const file of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, file), `${id}\n`);
  writeJson(path.join(project, "STATE.json"), state);
  return project;
}

function entry(id, overrides = {}) {
  return {
    id,
    path: id,
    assignedAgent: `fixture-agent-${id}`,
    container: { id: `hephaestus-${id}`, workspace: "/workspace" },
    paths: { state: "STATE.json", log: "BUILD_LOG.md", prompts: "out/prompts", testReports: "out/test_reports" },
    ...overrides
  };
}

function context(states = {}) {
  const directory = writableTemporaryDirectory("hephaestus-phase9-");
  const root = path.join(directory, "projects");
  makeProject(root, "alpha", states.alpha ?? baseState);
  makeProject(root, "beta", states.beta ?? { ...baseState, nextAction: "agent-running" });
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: [entry("beta"), entry("alpha")] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, registry, config };
}

test("multi-project registry normalizes independent projects and resources deterministically", () => {
  const c = context();
  try {
    const projects = loadMultiProjectRegistry(c.registry, c.root);
    assert.deepEqual(projects.map((item) => item.id), ["alpha", "beta"]);
    assert.notEqual(projectResource(projects[0], "log"), projectResource(projects[1], "log"));
    assert.notEqual(projects[0].container.id, projects[1].container.id);
    assert.equal(projects[0].assignedAgent, "fixture-agent-alpha");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("registry rejects duplicate or nested roots, duplicate containers, and traversal", () => {
  const c = context();
  try {
    writeJson(c.registry, { projects: [entry("alpha"), entry("beta", { path: "alpha" })] });
    assert.throws(() => loadMultiProjectRegistry(c.registry, c.root), (error) => code(error, "INVALID_MULTI_PROJECT_REGISTRY"));
    writeJson(c.registry, { projects: [entry("alpha"), entry("beta", { path: "alpha/child" })] });
    assert.throws(() => loadMultiProjectRegistry(c.registry, c.root), (error) => code(error, "INVALID_MULTI_PROJECT_REGISTRY"));
    writeJson(c.registry, { projects: [entry("alpha"), entry("beta", { container: { id: "hephaestus-alpha", workspace: "/workspace" } })] });
    assert.throws(() => loadMultiProjectRegistry(c.registry, c.root), (error) => code(error, "INVALID_MULTI_PROJECT_REGISTRY"));
    writeJson(c.registry, { projects: [entry("alpha"), entry("beta", { paths: { ...entry("beta").paths, log: "../alpha/BUILD_LOG.md" } })] });
    assert.throws(() => loadMultiProjectRegistry(c.registry, c.root), (error) => code(error, "UNSAFE_PATH"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("project controls are deterministic and one paused or blocked project leaves another unchanged", () => {
  const alpha = { ...baseState, blocked: true, nextAction: "manual-review" };
  const beta = { ...baseState, nextAction: "agent-running" };
  assert.equal(projectStatus(alpha), "blocked");
  assert.equal(projectStatus(beta), "running");
  const paused = transitionProjectStatus(beta, "pause");
  assert.equal(projectStatus(paused), "paused");
  assert.equal(projectStatus(beta), "running");
  assert.equal(projectStatus(transitionProjectStatus(paused, "resume")), "idle");
  assert.equal(projectStatus(transitionProjectStatus(beta, "stop")), "stopped");
  assert.throws(() => transitionProjectStatus(beta, "launch"), (error) => code(error, "INVALID_PROJECT_STATUS_ACTION"));
});

test("project state, log, prompt, and test resources never cross project boundaries", () => {
  const c = context();
  try {
    const [alpha, beta] = loadMultiProjectRegistry(c.registry, c.root);
    for (const resource of ["prompts", "testReports"]) {
      const alphaDirectory = projectResource(alpha, resource);
      fs.mkdirSync(alphaDirectory, { recursive: true });
      fs.writeFileSync(path.join(alphaDirectory, `${resource}.txt`), "alpha only\n");
      assert.equal(fs.existsSync(path.join(projectResource(beta, resource), `${resource}.txt`)), false);
    }
    fs.appendFileSync(projectResource(alpha, "log"), "alpha log only\n");
    assert.equal(fs.readFileSync(projectResource(beta, "log"), "utf8").includes("alpha log only"), false);
    const betaBefore = fs.readFileSync(projectResource(beta, "state"), "utf8");
    saveState(alpha.path, { ...baseState, nextAction: "alpha-updated" });
    assert.equal(fs.readFileSync(projectResource(beta, "state"), "utf8"), betaBefore);
    assert.throws(() => resolveSafePath(alpha.path, "../beta/STATE.json"), (error) => code(error, "UNSAFE_PATH"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("global status is deterministic, lists every project, and never writes files or starts work", () => {
  const c = context({ alpha: { ...baseState, usageLimitPaused: true, nextAction: "agent-usage-limit-paused" } });
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("status must not contact external services"); };
  try {
    const before = fs.readdirSync(c.root, { recursive: true }).sort();
    const output = capture(() => assert.equal(run(["status", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only");
    assert.deepEqual(result.projects.map((item) => [item.id, item.status]), [["alpha", "paused"], ["beta", "running"]]);
    assert.deepEqual(globalProjectStatus(loadMultiProjectRegistry(c.registry, c.root)), result.projects);
    assert.deepEqual(fs.readdirSync(c.root, { recursive: true }).sort(), before);
    assert.equal(fs.existsSync(path.join(c.root, "alpha", "out")), false);
    assert.equal(fs.existsSync(path.join(c.root, "alpha", "AGENT_OUTPUT.md")), false);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(c.directory, { recursive: true, force: true });
  }
});

test("global status fails safely when a registered project path is missing", () => {
  const c = context();
  try {
    fs.rmSync(path.join(c.root, "beta"), { recursive: true, force: true });
    assert.throws(() => run(["status", "--config", c.config]), (error) => code(error, "PATH_RESOLUTION_FAILED"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("legacy single-project registries remain valid for the read-only global status command", () => {
  const c = context();
  try {
    writeJson(c.registry, { projects: [{ id: "alpha", path: "alpha" }] });
    const output = capture(() => assert.equal(run(["status", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].assignedAgent, "unassigned");
    assert.equal(result.projects[0].status, "idle");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
