import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { containerReadableTemporaryDirectory, makeTreeContainerReadable } from "./helpers/writable-temp.js";
import { withEmptyPath } from "./helpers/spawned-cli.js";
import { runAgentTask } from "../src/agent.js";
import { ADAPTER_IDS, getAdapter, listAdapters, redactPreflightText, requireAdapter } from "../src/agent-adapters.js";
import { runAgentPreflight } from "../src/agent-preflight.js";
import { run as runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { HephaestusError } from "../src/errors.js";
import {
  getProviderAdapter, isProviderLiveExecutable, listLiveExecutableProviderIds,
  listProviderAdapters, providerExecutionConfigured, PROVIDER_ADAPTER_IDS,
  runProviderTask, selectLiveProvider
} from "../src/provider-adapters.js";

const validState = Object.freeze({
  currentPhase: "6B", currentTask: "real-adapter-boundary", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return containerReadableTemporaryDirectory("hephaestus-6b-"); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext() {
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
  fs.writeFileSync(path.join(projectPath, "out", "prompts", "next-task.md"), "# Delivered prompt\n\nDo the declared task.\n");
  makeTreeContainerReadable(directory);
  return { directory, allowedRoot, projectPath, promptPath: "out/prompts/next-task.md" };
}

function fakeSpawn(behavior) {
  return (executable, args, options) => {
    fakeSpawn.lastCall = Object.freeze({ executable, args: [...args], shell: options.shell, env: options.env });
    return behavior(executable, args, options);
  };
}

test("registry exposes fixture, codex, claude-code, and opencode adapters with correct kinds", () => {
  const ids = ADAPTER_IDS;
  for (const required of ["fixture-agent", "codex", "claude-code", "opencode"]) {
    assert.ok(ids.includes(required), `missing adapter ${required}`);
    const meta = getAdapter(required);
    assert.ok(meta, `metadata missing for ${required}`);
  }
  assert.equal(getAdapter("fixture-agent").kind, "fixture");
  assert.equal(getAdapter("fixture-agent").executionAllowed, true);
  for (const realId of ["codex", "claude-code", "opencode"]) {
    const meta = getAdapter(realId);
    assert.equal(meta.kind, "real");
    assert.equal(meta.executionAllowed, false);
    assert.equal(meta.defaultEnabled, false);
    assert.equal(meta.preflightSupported, true);
    assert.ok(typeof meta.expectedExecutable === "string" && meta.expectedExecutable.length > 0);
    assert.ok(typeof meta.disabledReason === "string" && meta.disabledReason.length > 0);
  }
  for (const meta of listAdapters()) {
    assert.equal(/sk-[A-Za-z0-9]/u.test(JSON.stringify(meta)), false);
    assert.equal(/ghp_/u.test(JSON.stringify(meta)), false);
  }
  assert.equal(getAdapter("unknown-agent"), null);
  assert.throws(() => requireAdapter("unknown-agent"), (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE"));
});

test("Codex provider adapter exposes capability metadata and remains the only live-executable provider", () => {
  assert.deepEqual(PROVIDER_ADAPTER_IDS, ["codex", "factory-droid", "claude-code"]);
  assert.deepEqual(listProviderAdapters().map((adapter) => adapter.id), ["codex", "factory-droid", "claude-code"]);
  const codex = getProviderAdapter("codex");
  assert.ok(codex);
  assert.equal(codex.displayName, "Codex");
  assert.equal(codex.liveExecutable, true);
  assert.equal(codex.capabilities.localProcess, true);
  assert.equal(codex.capabilities.headless, true);
  assert.equal(codex.capabilities.nonInteractive, true);
  assert.equal(codex.capabilities.nativeSandbox, true);
  assert.equal(codex.capabilities.supportsWorkspaceWrite, true);
  assert.equal(codex.capabilities.shellFalseSupported, true);
  assert.equal(codex.capabilities.safeEnvAllowlistSupported, true);
  assert.equal(codex.capabilities.usageLimitDetectable, true);
  assert.equal(codex.capabilities.conductorOwnsGit, true);
  assert.equal(codex.capabilities.canMergeAfterApproval, false);
  // Codex is still the only provider that may be routed for real execution.
  assert.deepEqual(listLiveExecutableProviderIds(), ["codex"]);
  assert.equal(isProviderLiveExecutable("codex"), true);
  // Claude Code is now a known provider, but still not live-executable.
  assert.ok(getProviderAdapter("claude-code"));
  assert.equal(getProviderAdapter("claude-code").liveExecutable, false);
});

test("Factory Droid appears as a known provider with detection-only capabilities and no execution", () => {
  const factory = getProviderAdapter("factory-droid");
  assert.ok(factory, "factory-droid should be a registered provider");
  assert.equal(factory.displayName, "Factory Droid");
  assert.equal(factory.capabilities.supportsPreflight, true);
  assert.equal(factory.capabilities.headless, true);
  assert.equal(factory.capabilities.nonInteractive, true);
  assert.equal(factory.capabilities.longRunning, true);
  assert.equal(factory.capabilities.structuredReport, true);
  // No execution/sandbox/merge capability is claimed in preflight-only mode.
  assert.equal(factory.capabilities.nativeSandbox, false);
  assert.equal(factory.capabilities.supportsWorkspaceWrite, false);
  assert.equal(factory.capabilities.canCommit, false);
  assert.equal(factory.capabilities.canOpenPr, false);
  assert.equal(factory.capabilities.canMergeAfterApproval, false);
  // Known but not live-executable.
  assert.equal(factory.liveExecutable, false);
  assert.equal(isProviderLiveExecutable("factory-droid"), false);
  assert.ok(!listLiveExecutableProviderIds().includes("factory-droid"));
});

test("Factory Droid preflight passes when a fake droid binary reports its version, without leaking secrets", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "droid 2.4.1\nAPI_KEY=sk-abcdefghijklmnop123456\n", stderr: "" }));
  const report = getProviderAdapter("factory-droid").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.adapterId, "factory-droid");
  assert.equal(report.available, true);
  assert.equal(report.reason, "version-detected");
  assert.equal(report.preflightSupported, true);
  assert.equal(report.mutatedProjectFiles, false);
  assert.equal(report.promptSent, false);
  assert.equal(fakeSpawn.lastCall.executable, "droid");
  assert.deepEqual(fakeSpawn.lastCall.args, ["--version"]);
  assert.equal(fakeSpawn.lastCall.shell, false);
  // Secrets in probe output are redacted, never surfaced.
  assert.equal(/sk-[A-Za-z0-9]/u.test(JSON.stringify(report)), false);
});

test("Factory Droid preflight returns a clean missing-cli result when droid is absent", () => {
  const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("droid not found"), { code: "ENOENT" }) }));
  const report = getProviderAdapter("factory-droid").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.adapterId, "factory-droid");
  assert.equal(report.available, false);
  assert.equal(report.reason, "executable-not-found");
  assert.equal(report.version, null);
  assert.match(report.detail, /not installed or not on PATH/u);
});

test("Factory Droid runTask refuses execution in preflight-only mode and never spawns", () => {
  let spawned = false;
  const result = runProviderTask("factory-droid", { spawn: () => { spawned = true; return {}; } });
  assert.equal(spawned, false, "factory runTask must not spawn any process");
  assert.equal(result.executed, false);
  assert.equal(result.supported, false);
  assert.equal(result.classification, "PROVIDER_NOT_ENABLED");
  assert.equal(result.reason, "preflight-only");
  assert.match(result.detail, /not enabled/u);
});

test("provider live-execution gate defaults to Codex-only with no config present", () => {
  assert.equal(isProviderLiveExecutable("codex"), true);
  assert.equal(isProviderLiveExecutable("codex", null), true);
  assert.equal(isProviderLiveExecutable("factory-droid"), false);
  assert.deepEqual(listLiveExecutableProviderIds(null), ["codex"]);
  // Preflight support is orthogonal to live execution and stays on for both providers.
  assert.equal(getAdapter("codex").preflightSupported, true);
  assert.equal(getAdapter("factory-droid").preflightSupported, true);
});

test("provider live-execution gate rejects unknown and known-but-not-live providers with distinct errors", () => {
  assert.throws(() => selectLiveProvider("does-not-exist"), (error) => code(error, "PROVIDER_ADAPTER_NOT_AVAILABLE"));
  assert.throws(() => selectLiveProvider("factory-droid"), (error) => code(error, "PROVIDER_NOT_LIVE_EXECUTABLE"));
  assert.equal(selectLiveProvider("codex").id, "codex");
});

test("config can disable Codex live execution and cannot enable Factory beyond its capability", () => {
  // Codex is opt-out: explicit executionEnabled:false disables it.
  const codexOff = { providers: { codex: { enabled: true, executionEnabled: false } } };
  assert.equal(isProviderLiveExecutable("codex", codexOff), false);
  assert.deepEqual(listLiveExecutableProviderIds(codexOff), []);
  assert.throws(() => selectLiveProvider("codex", { config: codexOff }), (error) => code(error, "PROVIDER_NOT_LIVE_EXECUTABLE"));

  // Enabling Factory in config records intent but the capability gate still blocks it.
  const factoryOn = { providers: { "factory-droid": { enabled: true, executionEnabled: true } } };
  assert.equal(providerExecutionConfigured("factory-droid", factoryOn), true);
  assert.equal(isProviderLiveExecutable("factory-droid", factoryOn), false);
  assert.throws(() => selectLiveProvider("factory-droid", { config: factoryOn }), (error) => code(error, "PROVIDER_NOT_LIVE_EXECUTABLE"));
  // Codex stays live under a config that only mentions Factory.
  assert.equal(isProviderLiveExecutable("codex", factoryOn), true);
});

test("enabling Factory in config does not bypass its preflight-only runTask refusal, and preflight still runs", () => {
  const factoryOn = { providers: { "factory-droid": { enabled: true, executionEnabled: true } } };
  // Even fully "enabled" in config, direct execution refuses without spawning.
  let spawned = false;
  const result = runProviderTask("factory-droid", { spawn: () => { spawned = true; return {}; } });
  assert.equal(spawned, false);
  assert.equal(result.executed, false);
  assert.equal(result.classification, "PROVIDER_NOT_ENABLED");
  // Preflight is still permitted for the known provider while live execution is off.
  assert.equal(isProviderLiveExecutable("factory-droid", factoryOn), false);
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "droid 2.4.1\n", stderr: "" }));
  const report = getProviderAdapter("factory-droid").preflight({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.available, true);
  assert.equal(report.reason, "version-detected");
});

test("loadConfig validates the providers block and rejects unknown providers and bad shapes", () => {
  const directory = temporaryDirectory();
  try {
    const allowedRoot = path.join(directory, "projects");
    fs.mkdirSync(allowedRoot, { recursive: true });
    const base = { allowedRoot: "./projects", registryPath: "./registry.json", logDirectory: "./logs" };
    writeJson(path.join(directory, "ok.json"), { ...base, providers: { codex: { enabled: true }, "factory-droid": { enabled: false, executionEnabled: false } } });
    const config = loadConfig(path.join(directory, "ok.json"));
    assert.equal(config.providers["factory-droid"].executionEnabled, false);
    // Config intent still cannot make Factory live-executable.
    assert.equal(isProviderLiveExecutable("factory-droid", config), false);
    assert.equal(isProviderLiveExecutable("codex", config), true);

    writeJson(path.join(directory, "unknown.json"), { ...base, providers: { devin: { enabled: true } } });
    assert.throws(() => loadConfig(path.join(directory, "unknown.json")), (error) => code(error, "INVALID_CONFIG"));

    writeJson(path.join(directory, "badkey.json"), { ...base, providers: { codex: { executionEnabled: true, bogus: 1 } } });
    assert.throws(() => loadConfig(path.join(directory, "badkey.json")), (error) => code(error, "INVALID_CONFIG"));

    writeJson(path.join(directory, "badtype.json"), { ...base, providers: { codex: { enabled: "yes" } } });
    assert.throws(() => loadConfig(path.join(directory, "badtype.json")), (error) => code(error, "INVALID_CONFIG"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("real adapters cannot execute tasks via runAgentTask and unknown adapters are rejected", () => {
  const context = makeContext();
  try {
    for (const realId of ["codex", "claude-code", "opencode"]) {
      assert.throws(
        () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId: realId, promptPath: context.promptPath }),
        (error) => code(error, "REAL_AGENT_EXECUTION_DISABLED")
      );
    }
    assert.throws(
      () => runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId: "unknown-agent", promptPath: context.promptPath }),
      (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE")
    );
    const stateText = fs.readFileSync(path.join(context.projectPath, "STATE.json"), "utf8");
    assert.equal(JSON.parse(stateText).nextAction, "agent-run");
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_runs", "current", "prompt.md")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("preflight on a real adapter does not mutate project files and reports unavailable when executable is missing", () => {
  const context = makeContext();
  try {
    const buildLogBefore = fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8");
    const stateBefore = fs.readFileSync(path.join(context.projectPath, "STATE.json"), "utf8");
    const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("not found"), { code: "ENOENT" }) }));
    const report = runAgentPreflight({ adapterId: "codex", env: { PATH: "/nonexistent" }, spawn });
    assert.equal(report.adapterId, "codex");
    assert.equal(report.available, false);
    assert.equal(report.reason, "executable-not-found");
    assert.equal(report.executionAllowed, false);
    assert.equal(report.mutatedProjectFiles, false);
    assert.equal(report.promptSent, false);
    assert.equal(report.exitCode, null);
    assert.equal(report.version, null);
    assert.equal(fakeSpawn.lastCall.executable, "codex");
    assert.deepEqual(fakeSpawn.lastCall.args, ["--version"]);
    assert.equal(fakeSpawn.lastCall.shell, false);
    assert.equal(fakeSpawn.lastCall.env.LANG, "C.UTF-8");
    assert.equal(fs.readFileSync(path.join(context.projectPath, "BUILD_LOG.md"), "utf8"), buildLogBefore);
    assert.equal(fs.readFileSync(path.join(context.projectPath, "STATE.json"), "utf8"), stateBefore);
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Codex adapter preflight stays harmless and matches capability metadata", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "codex 0.1.0\n", stderr: "" }));
  const report = runAgentPreflight({ adapterId: "codex", env: { PATH: "/usr/bin" }, spawn });
  const adapter = getProviderAdapter("codex");
  assert.equal(report.adapterId, "codex");
  assert.equal(report.available, true);
  assert.equal(report.preflightSupported, true);
  assert.equal(adapter.capabilities.supportsPreflight, true);
  assert.equal(fakeSpawn.lastCall.executable, "codex");
  assert.deepEqual(fakeSpawn.lastCall.args, ["--version"]);
  assert.equal(fakeSpawn.lastCall.shell, false);
});

test("preflight reports available when the version probe succeeds and redacts apparent secrets", () => {
  const spawn = fakeSpawn(() => ({ status: 0, stdout: "claude-code 1.2.3\ntoken=sk-abcdefghijklmnop123456\n", stderr: "" }));
  const report = runAgentPreflight({ adapterId: "claude-code", env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.available, true);
  assert.equal(report.reason, "version-detected");
  assert.equal(report.exitCode, 0);
  assert.match(report.version, /claude-code 1\.2\.3/u);
  assert.equal(report.version.includes("sk-abcdefghijklmnop123456"), false);
  assert.equal(JSON.stringify(report).includes("sk-abcdefghijklmnop123456"), false);
});

test("preflight reports timed-out and nonzero-exit safely without crashing", () => {
  const timeoutSpawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", signal: "SIGTERM", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }));
  const timeoutReport = runAgentPreflight({ adapterId: "opencode", env: { PATH: "/usr/bin" }, spawn: timeoutSpawn });
  assert.equal(timeoutReport.available, false);
  assert.equal(timeoutReport.reason, "timed-out");
  const nonzeroSpawn = fakeSpawn(() => ({ status: 2, stdout: "", stderr: "version unknown\n" }));
  const nonzeroReport = runAgentPreflight({ adapterId: "opencode", env: { PATH: "/usr/bin" }, spawn: nonzeroSpawn });
  assert.equal(nonzeroReport.available, false);
  assert.equal(nonzeroReport.reason, "nonzero-exit");
  assert.equal(nonzeroReport.exitCode, 2);
});

test("preflight on the fixture adapter reports preflight-not-supported and does not spawn", () => {
  let spawnCalled = false;
  const spawn = () => { spawnCalled = true; return { status: 0, stdout: "", stderr: "" }; };
  const report = runAgentPreflight({ adapterId: "fixture-agent", env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.available, false);
  assert.equal(report.reason, "preflight-not-supported");
  assert.equal(report.preflightSupported, false);
  assert.equal(spawnCalled, false);
});

test("preflight rejects unknown adapters and never sends a prompt", () => {
  const spawn = () => { throw new Error("must not spawn"); };
  assert.throws(() => runAgentPreflight({ adapterId: "made-up-agent", env: { PATH: "/usr/bin" }, spawn }), (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE"));
});

test("config validates the optional adapters block and rejects unsupported keys and unknown adapter ids", () => {
  const directory = temporaryDirectory();
  try {
    const allowedRoot = path.join(directory, "projects");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.writeFileSync(path.join(directory, "projects.json"), `${JSON.stringify({ projects: [] })}\n`);
    const baseConfig = { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" };
    const validPath = path.join(directory, "valid.json");
    writeJson(validPath, { ...baseConfig, adapters: { codex: { enabled: true }, "claude-code": { enabled: false } } });
    const loaded = loadConfig(validPath);
    assert.deepEqual(loaded.adapters, { codex: { enabled: true }, "claude-code": { enabled: false } });

    const unknownPath = path.join(directory, "unknown.json");
    writeJson(unknownPath, { ...baseConfig, adapters: { "not-a-real-agent": { enabled: true } } });
    assert.throws(() => loadConfig(unknownPath), (error) => code(error, "INVALID_CONFIG"));

    const extraKeyPath = path.join(directory, "extra.json");
    writeJson(extraKeyPath, { ...baseConfig, adapters: { codex: { enabled: true, executable: "/etc/passwd" } } });
    assert.throws(() => loadConfig(extraKeyPath), (error) => code(error, "INVALID_CONFIG"));

    const badTypePath = path.join(directory, "type.json");
    writeJson(badTypePath, { ...baseConfig, adapters: { codex: { enabled: "yes" } } });
    assert.throws(() => loadConfig(badTypePath), (error) => code(error, "INVALID_CONFIG"));

    const arrayPath = path.join(directory, "array.json");
    writeJson(arrayPath, { ...baseConfig, adapters: [] });
    assert.throws(() => loadConfig(arrayPath), (error) => code(error, "INVALID_CONFIG"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CLI agent-preflight reports JSON without sending a prompt and exits non-zero when unavailable", () => {
  const directory = temporaryDirectory();
  let stdout = "";
  const originalWrite = process.stdout.write;
  try {
    const emptyPathDir = path.join(directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    const exitCode = withEmptyPath(emptyPathDir, () => runCli(["agent-preflight", "--adapter", "codex"]));
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapterId, "codex");
    assert.equal(parsed.executionAllowed, false);
    assert.equal(parsed.promptSent, false);
    assert.equal(parsed.mutatedProjectFiles, false);
    assert.notEqual(exitCode, 0);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI agent-preflight rejects unknown adapter ids before doing any work", () => {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  try {
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    process.stderr.write = (chunk) => { stderr += chunk; return true; };
    assert.throws(() => runCli(["agent-preflight", "--adapter", "made-up-agent"]), (error) => code(error, "AGENT_ADAPTER_NOT_AVAILABLE"));
    assert.equal(stdout, "");
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
});

test("redactPreflightText masks common api-key, token, github, and slack patterns", () => {
  assert.equal(redactPreflightText("OPENAI_API_KEY=sk-1234567890ABCDEFGH").includes("sk-1234567890ABCDEFGH"), false);
  assert.equal(redactPreflightText("token=ghp_ABCDEFGHIJ1234567890zzzz").includes("ghp_ABCDEFGHIJ1234567890zzzz"), false);
  assert.equal(redactPreflightText("authorization: Bearer abcdefghij0123456789").includes("abcdefghij0123456789"), false);
  assert.equal(redactPreflightText("hello world"), "hello world");
  assert.equal(redactPreflightText(""), "");
});

test("step 6A fixture-agent execution path still works through the registry", () => {
  const context = makeContext();
  try {
    const result = runAgentTask({ allowedRoot: context.allowedRoot, projectPath: context.projectPath, adapterId: "fixture-agent", promptPath: context.promptPath });
    assert.equal(result.status, "completed");
    assert.equal(result.adapterId, "fixture-agent");
    assert.match(fs.readFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "utf8"), /fixture-agent completed/u);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
