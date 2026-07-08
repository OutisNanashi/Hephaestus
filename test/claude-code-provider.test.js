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
  const directory = writableTemporaryDirectory("hephaestus-claude-");
  const root = path.join(directory, "projects");
  makeProject(root, "claudey");
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: [{ id: "claudey", path: "claudey", provider: "claude-code" }] });
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

test("Claude Code is a known, preflight-supported provider that is not live-executable", () => {
  assert.ok(PROVIDER_ADAPTER_IDS.includes("claude-code"));
  const claude = getProviderAdapter("claude-code");
  assert.ok(claude, "claude-code should be a registered provider");
  assert.equal(claude.displayName, "Claude Code");
  assert.equal(claude.capabilities.supportsPreflight, true);
  assert.equal(claude.capabilities.localProcess, true);
  assert.equal(claude.capabilities.headless, true);
  assert.equal(claude.capabilities.nonInteractive, true);
  // Conservative: no execution/sandbox/git capability yet.
  assert.equal(claude.capabilities.nativeSandbox, false);
  assert.equal(claude.capabilities.supportsWorkspaceWrite, false);
  assert.equal(claude.capabilities.canCommit, false);
  assert.equal(claude.capabilities.canOpenPr, false);
  assert.equal(claude.capabilities.canMergeAfterApproval, false);
  assert.equal(claude.capabilities.conductorOwnsGit, true);
  assert.equal(claude.liveExecutable, false);
  // agent-adapters metadata stays execution-disabled with a safe probe target.
  const meta = getAdapter("claude-code");
  assert.equal(meta.executionAllowed, false);
  assert.equal(meta.preflightSupported, true);
  assert.equal(meta.expectedExecutable, "claude");
});

test("Claude Code is not live-executable by default or when config tries to enable it", () => {
  assert.equal(isProviderLiveExecutable("claude-code"), false);
  assert.ok(!listLiveExecutableProviderIds().includes("claude-code"));
  const claudeOn = { providers: { "claude-code": { enabled: true, executionEnabled: true } } };
  assert.equal(isProviderLiveExecutable("claude-code", claudeOn), false);
  // Enabling Claude Code changes nothing about the live set (still Codex only).
  assert.deepEqual(listLiveExecutableProviderIds(claudeOn), ["codex"]);
  assert.equal(isProviderLiveExecutable("codex"), true, "Codex behavior is unchanged");
});

test("Claude Code runTask refuses cleanly and never spawns", () => {
  let spawned = false;
  const adapter = getProviderAdapter("claude-code");
  const result = adapter.runTask({ spawn: () => { spawned = true; return {}; } });
  assert.equal(spawned, false);
  assert.equal(result.executed, false);
  assert.equal(result.supported, false);
  assert.equal(result.classification, "PROVIDER_NOT_ENABLED");
  assert.equal(result.reason, "preflight-only");
  assert.match(result.detail, /not enabled/u);
});

test("Claude Code preflight passes on a fake claude --version and never logs in or sends a prompt", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "1.2.3 (Claude Code)\n", stderr: "" }));
  const report = getProviderAdapter("claude-code").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.adapterId, "claude-code");
  assert.equal(report.available, true);
  assert.equal(report.reason, "version-detected");
  assert.equal(report.promptSent, false);
  assert.equal(report.mutatedProjectFiles, false);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].executable, "claude");
  assert.deepEqual(spawn.calls[0].args, ["--version"]);
  assert.equal(spawn.calls[0].shell, false);
});

test("Claude Code preflight reports a clean missing-cli result when claude is absent", () => {
  const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("claude not found"), { code: "ENOENT" }) }));
  const report = getProviderAdapter("claude-code").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.available, false);
  assert.equal(report.reason, "executable-not-found");
  assert.equal(report.version, null);
});

test("Claude Code preflight redacts secret-like output", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "claude 1.2.3\nANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop123456\n", stderr: "" }));
  const report = getProviderAdapter("claude-code").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(/sk-ant-[A-Za-z0-9]/u.test(JSON.stringify(report)), false);
});

test("status --providers includes Claude Code readiness read-only and spawns nothing", () => {
  const c = context();
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("status must not contact external services"); };
  try {
    const before = fs.readdirSync(c.root, { recursive: true }).sort();
    const output = capture(() => assert.equal(run(["status", "--providers", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only-providers");
    const claude = result.providers.find((row) => row.id === "claudey");
    assert.equal(claude.provider, "claude-code");
    assert.equal(claude.known, true);
    assert.equal(claude.preflightSupported, true);
    assert.equal(claude.liveExecutable, false);
    assert.equal(claude.reason, "not-live-executable-capability");
    assert.equal(claude.preflight, undefined);
    assert.deepEqual(fs.readdirSync(c.root, { recursive: true }).sort(), before);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(c.directory, { recursive: true, force: true });
  }
});

test("status --providers --preflight uses the injected fake spawn for Claude Code and redacts secrets", () => {
  const c = context();
  const spawn = fakeSpawn((executable, args) => {
    if (executable === "claude" && args.includes("--version")) return { status: 0, stdout: "claude 1.2.3\nANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop123456\n", stderr: "" };
    return { status: 127, stdout: "", stderr: "unexpected" };
  });
  try {
    const output = capture(() => assert.equal(run(["status", "--providers", "--preflight", "--config", c.config], { providerPreflightSpawn: spawn }), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only-providers-preflight");
    const claude = result.providers.find((row) => row.id === "claudey");
    assert.ok(claude.preflight);
    assert.equal(claude.preflight.available, true);
    assert.equal(claude.preflight.reason, "version-detected");
    assert.ok(spawn.calls.some((call) => call.executable === "claude" && call.args.includes("--version")));
    assert.ok(spawn.calls.every((call) => call.args.includes("--version")), "only safe --version probes");
    assert.equal(/sk-ant-[A-Za-z0-9]/u.test(output), false);
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});
