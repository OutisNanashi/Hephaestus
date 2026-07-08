import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { getAdapter } from "../src/agent-adapters.js";
import {
  getProviderAdapter, isProviderLiveExecutable, listLiveExecutableProviderIds,
  PROVIDER_ADAPTER_IDS
} from "../src/provider-adapters.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function capture(action) {
  let output = ""; const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try { action(); } finally { process.stdout.write = original; }
  return output;
}

const baseState = Object.freeze({
  currentPhase: "9", currentTask: "providers", currentBranch: "main", currentPr: null, assignedAgent: null,
  attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null,
  mergeStatus: "not-started", containerStatus: "healthy", lastGptDecision: null, nextAction: "project-idle"
});

function makeProject(root, id) {
  const project = path.join(root, id);
  fs.mkdirSync(project, { recursive: true });
  for (const file of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, file), `${id}\n`);
  writeJson(path.join(project, "STATE.json"), baseState);
  return project;
}

function context() {
  const directory = writableTemporaryDirectory("hephaestus-cursor-");
  const root = path.join(directory, "projects");
  makeProject(root, "cursorly");
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: [{ id: "cursorly", path: "cursorly", provider: "cursor-agent" }] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, registry, config };
}

function fakeSpawn(behavior) {
  const calls = [];
  const spawn = (executable, args, options) => { calls.push({ executable, args: [...args], shell: options?.shell }); return behavior(executable, args, options); };
  spawn.calls = calls;
  return spawn;
}

test("Cursor Agent is a known, preflight-supported provider that is not live-executable", () => {
  assert.ok(PROVIDER_ADAPTER_IDS.includes("cursor-agent"));
  const cursor = getProviderAdapter("cursor-agent");
  assert.ok(cursor, "cursor-agent should be a registered provider");
  assert.equal(cursor.displayName, "Cursor Agent + Grok 4.5");
  assert.equal(cursor.capabilities.supportsPreflight, true);
  assert.equal(cursor.capabilities.localProcess, true);
  assert.equal(cursor.capabilities.headless, true);
  assert.equal(cursor.capabilities.nonInteractive, true);
  // Conservative: no execution/sandbox/git capability yet.
  assert.equal(cursor.capabilities.nativeSandbox, false);
  assert.equal(cursor.capabilities.supportsWorkspaceWrite, false);
  assert.equal(cursor.capabilities.canCommit, false);
  assert.equal(cursor.capabilities.canOpenPr, false);
  assert.equal(cursor.capabilities.canMergeAfterApproval, false);
  assert.equal(cursor.capabilities.conductorOwnsGit, true);
  assert.equal(cursor.liveExecutable, false);
  // agent-adapters metadata stays execution-disabled with a safe probe target.
  const meta = getAdapter("cursor-agent");
  assert.equal(meta.executionAllowed, false);
  assert.equal(meta.preflightSupported, true);
  assert.equal(meta.expectedExecutable, "cursor-agent");
});

test("Cursor Agent metadata records Grok 4.5 as the intended model without enabling execution", () => {
  const cursor = getProviderAdapter("cursor-agent");
  assert.equal(cursor.intendedModel, "grok-4.5");
  assert.equal(getAdapter("cursor-agent").intendedModel, "grok-4.5");
  // Recording model intent must not make the provider live-executable.
  assert.equal(cursor.liveExecutable, false);
  assert.equal(isProviderLiveExecutable("cursor-agent"), false);
  // Providers without a declared intended model report null (no accidental default).
  assert.equal(getProviderAdapter("codex").intendedModel, null);
});

test("Cursor Agent is not live-executable by default or when config tries to enable it", () => {
  assert.equal(isProviderLiveExecutable("cursor-agent"), false);
  assert.ok(!listLiveExecutableProviderIds().includes("cursor-agent"));
  const cursorOn = { providers: { "cursor-agent": { enabled: true, executionEnabled: true } } };
  assert.equal(isProviderLiveExecutable("cursor-agent", cursorOn), false);
  // Enabling Cursor Agent changes nothing about the live set (still Codex only).
  assert.deepEqual(listLiveExecutableProviderIds(cursorOn), ["codex"]);
  assert.equal(isProviderLiveExecutable("codex"), true, "Codex behavior is unchanged");
});

test("Cursor Agent runTask refuses cleanly and never spawns", () => {
  let spawned = false;
  const adapter = getProviderAdapter("cursor-agent");
  const result = adapter.runTask({ spawn: () => { spawned = true; return {}; } });
  assert.equal(spawned, false);
  assert.equal(result.executed, false);
  assert.equal(result.supported, false);
  assert.equal(result.classification, "PROVIDER_NOT_ENABLED");
  assert.equal(result.reason, "preflight-only");
  assert.match(result.detail, /not enabled/u);
});

test("Cursor Agent preflight passes on a fake cursor-agent --version and never logs in or sends a prompt", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "2026.7.1 (cursor-agent)\n", stderr: "" }));
  const report = getProviderAdapter("cursor-agent").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.adapterId, "cursor-agent");
  assert.equal(report.available, true);
  assert.equal(report.reason, "version-detected");
  assert.equal(report.promptSent, false);
  assert.equal(report.mutatedProjectFiles, false);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].executable, "cursor-agent");
  assert.deepEqual(spawn.calls[0].args, ["--version"]);
  assert.equal(spawn.calls[0].shell, false);
});

test("Cursor Agent preflight reports a clean missing-cli result when cursor-agent is absent", () => {
  const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("cursor-agent not found"), { code: "ENOENT" }) }));
  const report = getProviderAdapter("cursor-agent").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.available, false);
  assert.equal(report.reason, "executable-not-found");
  assert.equal(report.version, null);
});

test("Cursor Agent preflight redacts secret-like output", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "cursor-agent 2026.7.1\nCURSOR_API_KEY=sk-cur-abcdefghijklmnop123456\n", stderr: "" }));
  const report = getProviderAdapter("cursor-agent").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(/sk-cur-[A-Za-z0-9]/u.test(JSON.stringify(report)), false);
});

test("status --providers includes Cursor Agent readiness read-only and spawns nothing", () => {
  const c = context();
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("status must not contact external services"); };
  try {
    const before = fs.readdirSync(c.root, { recursive: true }).sort();
    const output = capture(() => assert.equal(run(["status", "--providers", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only-providers");
    const cursor = result.providers.find((row) => row.id === "cursorly");
    assert.equal(cursor.provider, "cursor-agent");
    assert.equal(cursor.known, true);
    assert.equal(cursor.preflightSupported, true);
    assert.equal(cursor.liveExecutable, false);
    assert.equal(cursor.reason, "not-live-executable-capability");
    assert.equal(cursor.preflight, undefined);
    assert.deepEqual(fs.readdirSync(c.root, { recursive: true }).sort(), before);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(c.directory, { recursive: true, force: true });
  }
});

test("status --providers --preflight uses the injected fake spawn for Cursor Agent and redacts secrets", () => {
  const c = context();
  const spawn = fakeSpawn((executable, args) => {
    if (executable === "cursor-agent" && args.includes("--version")) return { status: 0, stdout: "cursor-agent 2026.7.1\nCURSOR_API_KEY=sk-cur-abcdefghijklmnop123456\n", stderr: "" };
    return { status: 127, stdout: "", stderr: "unexpected" };
  });
  try {
    const output = capture(() => assert.equal(run(["status", "--providers", "--preflight", "--config", c.config], { providerPreflightSpawn: spawn }), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only-providers-preflight");
    const cursor = result.providers.find((row) => row.id === "cursorly");
    assert.ok(cursor.preflight);
    assert.equal(cursor.preflight.available, true);
    assert.equal(cursor.preflight.reason, "version-detected");
    assert.ok(spawn.calls.some((call) => call.executable === "cursor-agent" && call.args.includes("--version")));
    assert.ok(spawn.calls.every((call) => call.args.includes("--version")), "only safe --version probes");
    assert.equal(/sk-cur-[A-Za-z0-9]/u.test(output), false);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
