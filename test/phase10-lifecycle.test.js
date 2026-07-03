import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { validateState } from "../src/state.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const baseState = Object.freeze({
  currentPhase: "10", currentTask: "multi-project", currentBranch: "main", currentPr: null, assignedAgent: null,
  attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null, reviewStatus: "not-started",
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

function entry(id) {
  return {
    id, path: id, assignedAgent: `fixture-agent-${id}`,
    container: { id: `hephaestus-${id}`, workspace: "/workspace" },
    paths: { state: "STATE.json", log: "BUILD_LOG.md", prompts: "out/prompts", testReports: "out/test_reports", reviewReports: "out/review_reports" }
  };
}

function context() {
  const directory = writableTemporaryDirectory("hephaestus-phase10b-");
  const root = path.join(directory, "projects");
  makeProject(root, "alpha");
  makeProject(root, "beta");
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: [entry("beta"), entry("alpha")] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, registry, config };
}

function stateOf(root, id) { return validateState(JSON.parse(fs.readFileSync(path.join(root, id, "STATE.json"), "utf8"))); }

for (const [action, expectedStatus, expectedNext] of [["pause", "paused", "project-paused"], ["resume", "idle", "project-idle"], ["stop", "stopped", "project-stopped"]]) {
  test(`${action} mutates only the selected project and leaves the other project's state byte-identical`, () => {
    const c = context();
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { fetchCalled = true; throw new Error("lifecycle must not contact external services"); };
    try {
      const betaBefore = fs.readFileSync(path.join(c.root, "beta", "STATE.json"), "utf8");
      const before = fs.readdirSync(c.root, { recursive: true }).sort();
      const output = capture(() => assert.equal(run([action, "--project", "alpha", "--config", c.config]), 0));
      const result = JSON.parse(output);
      assert.deepEqual([result.mode, result.project, result.action, result.status, result.nextAction], ["lifecycle", "alpha", action, expectedStatus, expectedNext]);
      // Selected project transitioned and stays schema-valid.
      const alpha = stateOf(c.root, "alpha");
      assert.equal(alpha.nextAction, expectedNext);
      assert.doesNotThrow(() => validateState(alpha));
      // Other project untouched, byte-for-byte; no new files or external calls.
      assert.equal(fs.readFileSync(path.join(c.root, "beta", "STATE.json"), "utf8"), betaBefore);
      assert.deepEqual(fs.readdirSync(c.root, { recursive: true }).sort(), before);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(c.directory, { recursive: true, force: true });
    }
  });
}

test("lifecycle writes no root BUILD_LOG.md or root STATE.json and creates no out/ or AGENT_OUTPUT.md", () => {
  const c = context();
  try {
    capture(() => assert.equal(run(["stop", "--project", "alpha", "--config", c.config]), 0));
    for (const stray of ["BUILD_LOG.md", "STATE.json"]) assert.equal(fs.existsSync(path.join(c.directory, stray)), false);
    assert.equal(fs.existsSync(path.join(c.root, "alpha", "out")), false);
    assert.equal(fs.existsSync(path.join(c.root, "alpha", "AGENT_OUTPUT.md")), false);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("lifecycle rejects an unknown project id safely without writing anything", () => {
  const c = context();
  try {
    const before = fs.readdirSync(c.root, { recursive: true }).sort();
    assert.throws(() => run(["pause", "--project", "ghost", "--config", c.config]), (error) => code(error, "PROJECT_NOT_REGISTERED"));
    assert.deepEqual(fs.readdirSync(c.root, { recursive: true }).sort(), before);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("lifecycle requires an explicit --project target", () => {
  const c = context();
  try {
    assert.throws(() => run(["resume", "--config", c.config]), (error) => code(error, "INVALID_ARGUMENT"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("lifecycle fails safely when a registered project path is missing", () => {
  const c = context();
  try {
    fs.rmSync(path.join(c.root, "alpha"), { recursive: true, force: true });
    assert.throws(() => run(["pause", "--project", "alpha", "--config", c.config]), (error) => code(error, "PATH_RESOLUTION_FAILED"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("lifecycle rejects a traversal id that cannot match any normalized registered project", () => {
  const c = context();
  try {
    assert.throws(() => run(["stop", "--project", "../beta", "--config", c.config]), (error) => code(error, "PROJECT_NOT_REGISTERED"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("global status still reports each project independently after a lifecycle change", () => {
  const c = context();
  try {
    capture(() => assert.equal(run(["pause", "--project", "alpha", "--config", c.config]), 0));
    const output = capture(() => assert.equal(run(["status", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.deepEqual(result.projects.map((item) => [item.id, item.status]), [["alpha", "paused"], ["beta", "idle"]]);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
