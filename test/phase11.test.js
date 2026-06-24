import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { loadDashboardStatus } from "../src/dashboard.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const baseState = Object.freeze({
  currentPhase: "11", currentTask: "dashboard", currentBranch: "main", currentPr: null, assignedAgent: null,
  attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null, reviewStatus: "not-started",
  mergeStatus: "not-started", containerStatus: "healthy", lastGptDecision: null, nextAction: "project-idle"
});

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function project(root, id, state, log = "# Build log\n\nNo entries.\n") {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(directory, name), `${id}\n`);
  fs.writeFileSync(path.join(directory, "BUILD_LOG.md"), log);
  if (state !== undefined) writeJson(path.join(directory, "STATE.json"), state);
  return directory;
}

function entry(id, overrides = {}) {
  return {
    id,
    path: id,
    assignedAgent: `agent-${id}`,
    container: { id: `hephaestus-${id}`, workspace: "/workspace" },
    paths: { state: "STATE.json", log: "BUILD_LOG.md", prompts: "out/prompts", testReports: "out/test_reports", reviewReports: "out/review_reports" },
    ...overrides
  };
}

function context() {
  const directory = writableTemporaryDirectory("hephaestus-phase11-");
  const root = path.join(directory, "projects");
  project(root, "blocked", { ...baseState, blocked: true, nextAction: "manual-review", currentTask: "review PR" });
  project(root, "running", { ...baseState, nextAction: "agent-running", currentTask: "build status" });
  project(root, "merged", { ...baseState, mergeStatus: "merged", currentTask: "phase complete" });
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: [entry("running"), entry("merged"), entry("blocked")] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, registry, config };
}

function capture(action) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try { action(); } finally { process.stdout.write = original; }
  return output;
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map((item) => {
    const file = path.join(root, item);
    return fs.statSync(file).isFile() ? [item, fs.readFileSync(file, "utf8")] : [item, "directory"];
  });
}

test("dashboard reads the registry and state into deterministic separate project rows", () => {
  const c = context();
  try {
    const rows = loadDashboardStatus(c.registry, c.root);
    assert.deepEqual(rows.map((row) => row.id), ["blocked", "merged", "running"]);
    assert.equal(rows.find((row) => row.id === "running").currentPhase, "11");
    assert.equal(rows.find((row) => row.id === "running").assignedAgent, "agent-running");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dashboard displays blocked, running, and merged projects correctly", () => {
  const c = context();
  try {
    const rows = loadDashboardStatus(c.registry, c.root);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.manualAction]), [
      ["blocked", "blocked", "manual-review"], ["merged", "merged", null], ["running", "running", null]
    ]);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dashboard handles missing optional registry fields and missing project state gracefully", () => {
  const c = context();
  try {
    project(c.root, "missing-state", undefined);
    writeJson(c.registry, { projects: [entry("missing-state", { assignedAgent: undefined, container: undefined, paths: undefined })] });
    const [row] = loadDashboardStatus(c.registry, c.root);
    assert.equal(row.assignedAgent, "unassigned");
    assert.equal(row.status, "unavailable");
    assert.equal(row.stateAvailable, false);
    assert.equal(row.stateError, "PATH_RESOLUTION_FAILED");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dashboard handles an empty project registry gracefully", () => {
  const c = context();
  try {
    writeJson(c.registry, { projects: [] });
    assert.deepEqual(loadDashboardStatus(c.registry, c.root), []);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dashboard handles malformed state safely without aborting other display data", () => {
  const c = context();
  try {
    fs.writeFileSync(path.join(c.root, "running", "STATE.json"), "{ invalid json\n");
    const rows = loadDashboardStatus(c.registry, c.root);
    const row = rows.find((item) => item.id === "running");
    assert.equal(row.status, "unavailable");
    assert.equal(row.stateError, "INVALID_JSON");
    assert.equal(rows.find((item) => item.id === "blocked").status, "blocked");
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dashboard CLI is read-only and remains independent of conductor actions", () => {
  const c = context();
  try {
    const beforeProjects = snapshot(c.root);
    const beforeRegistry = fs.readFileSync(c.registry, "utf8");
    const output = capture(() => assert.equal(run(["dashboard", "--config", c.config]), 0));
    const parsed = JSON.parse(output);
    assert.equal(parsed.mode, "read-only-dashboard");
    assert.deepEqual(snapshot(c.root), beforeProjects);
    assert.equal(fs.readFileSync(c.registry, "utf8"), beforeRegistry);
    assert.equal(fs.existsSync(path.join(c.root, "blocked", "out")), false);
    const source = fs.readFileSync(new URL("../src/dashboard.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /runMockCycle|runAgentTask|transitionProjectStatus|saveState|createMergeRelay|dispatchNotification/u);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("dashboard redacts obvious secrets and has deterministic output", () => {
  const c = context();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDE";
  try {
    fs.writeFileSync(path.join(c.root, "blocked", "BUILD_LOG.md"), `token=${secret}\n`);
    writeJson(path.join(c.root, "blocked", "STATE.json"), { ...baseState, blocked: true, nextAction: `password=${secret}` });
    const first = JSON.stringify(loadDashboardStatus(c.registry, c.root));
    const second = JSON.stringify(loadDashboardStatus(c.registry, c.root));
    assert.equal(first, second);
    assert.equal(first.includes(secret), false);
    assert.match(first, /\[REDACTED\]/u);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
