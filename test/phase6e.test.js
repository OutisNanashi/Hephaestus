import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runAgentTask } from "../src/agent.js";
import { CLASSIFICATIONS, detectHelpEvidence, runCodexDiscovery } from "../src/agent-discovery.js";
import { runCodexSmoke } from "../src/agent-smoke.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function fakeSpawn(perCommand) {
  const calls = [];
  const fn = (executable, args, options) => {
    calls.push(Object.freeze({ executable, args: [...args], shell: options?.shell, env: { ...options?.env } }));
    const key = args.includes("--version") ? "version" : args.includes("--help") ? "help" : "other";
    const behavior = perCommand[key];
    if (typeof behavior !== "function") throw new Error(`fakeSpawn has no behavior for ${key}`);
    return behavior(executable, args, options);
  };
  fn.calls = calls;
  return fn;
}

const enoent = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("not found"), { code: "ENOENT" }) });
const okVersion = (stdout = "codex 0.1.0\n") => () => ({ status: 0, stdout, stderr: "" });
const okHelp = (stdout) => () => ({ status: 0, stdout, stderr: "" });

const PASS_HELP_TEXT = [
  "Usage: codex [options]",
  "  --prompt <text>       Pass a prompt non-interactively",
  "  --read-only           Disable file writes (read-only sandbox)",
  "  --no-approval         Run without interactive approval"
].join("\n");

const PROMPT_ONLY_HELP_TEXT = [
  "Usage: codex [options]",
  "  --prompt <text>       Pass a prompt non-interactively"
].join("\n");

const INTERACTIVE_HELP_TEXT = [
  "Usage: codex",
  "  Interactive mode only. A terminal (tty) is required."
].join("\n");

const AUTH_REQUIRED_HELP_TEXT = [
  PASS_HELP_TEXT,
  "Not authenticated. Please sign in by running `codex login`."
].join("\n");

test("discovery rejects unsupported request keys so executable/argv/shell cannot be smuggled", () => {
  for (const evilKey of ["executable", "argv", "shell", "shellCommand", "command", "cwd"]) {
    assert.throws(() => runCodexDiscovery({ [evilKey]: "/bin/sh -c rm" }), (error) => code(error, "INVALID_DISCOVERY_REQUEST"));
  }
});

test("missing codex on PATH classifies as STEP_6E_BLOCKED_CODEX_NOT_INSTALLED", () => {
  const spawn = fakeSpawn({ version: enoent, help: enoent });
  const report = runCodexDiscovery({ env: { PATH: "/nonexistent" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.NOT_INSTALLED);
  assert.equal(report.codexOnPath, false);
  assert.equal(report.codexVersion, null);
  assert.equal(report.step6fSafeToDesign, false);
  assert.match(report.manualAction, /Install the Codex CLI/u);
});

test("discovery uses only hardcoded codex executable, hardcoded argv, and shell:false", () => {
  const spawn = fakeSpawn({ version: okVersion(), help: okHelp(PASS_HELP_TEXT) });
  runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(spawn.calls.length, 2);
  for (const call of spawn.calls) {
    assert.equal(call.executable, "codex");
    assert.equal(call.shell, false);
    assert.equal(call.env.LANG, "C.UTF-8");
  }
  assert.deepEqual(spawn.calls[0].args, ["--version"]);
  assert.deepEqual(spawn.calls[1].args, ["--help"]);
});

test("version succeeds but help fails with a non-ENOENT error classifies as STEP_6E_BLOCKED_DISCOVERY_COMMAND_FAILED", () => {
  const spawn = fakeSpawn({
    version: okVersion(),
    help: () => ({ status: 2, stdout: "", stderr: "internal error\n" })
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.DISCOVERY_FAILED);
});

test("help with no documented prompt mechanism classifies as STEP_6E_BLOCKED_PROMPT_CONTRACT_UNKNOWN", () => {
  const spawn = fakeSpawn({
    version: okVersion(),
    help: okHelp("Usage: codex\n  --version            Print version")
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.PROMPT_CONTRACT_UNKNOWN);
  assert.equal(report.nonInteractivePromptDocumented, false);
  assert.equal(report.step6fSafeToDesign, false);
});

test("interactive-only help classifies as STEP_6E_BLOCKED_UNSAFE_OR_INTERACTIVE_ONLY", () => {
  const spawn = fakeSpawn({
    version: okVersion(),
    help: okHelp(INTERACTIVE_HELP_TEXT)
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.INTERACTIVE_ONLY);
  assert.equal(report.interactiveOnly, true);
});

test("documented prompt contract without a safe mode also classifies as STEP_6E_BLOCKED_UNSAFE_OR_INTERACTIVE_ONLY", () => {
  const spawn = fakeSpawn({
    version: okVersion(),
    help: okHelp(PROMPT_ONLY_HELP_TEXT)
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.INTERACTIVE_ONLY);
  assert.equal(report.nonInteractivePromptDocumented, true);
  assert.equal(report.safeModeDocumented, false);
});

test("authentication-required help classifies as STEP_6E_BLOCKED_CODEX_NOT_AUTHENTICATED", () => {
  const spawn = fakeSpawn({
    version: okVersion(),
    help: okHelp(AUTH_REQUIRED_HELP_TEXT)
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.NOT_AUTHENTICATED);
  assert.equal(report.authenticationProblemDocumented, true);
});

test("fully documented safe contract with no auth problem classifies as STEP_6E_PASS", () => {
  const spawn = fakeSpawn({
    version: okVersion("codex 1.2.3\n"),
    help: okHelp(PASS_HELP_TEXT)
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.classification, CLASSIFICATIONS.PASS);
  assert.equal(report.codexOnPath, true);
  assert.match(report.codexVersion, /codex 1\.2\.3/u);
  assert.equal(report.nonInteractivePromptDocumented, true);
  assert.equal(report.safeModeDocumented, true);
  assert.equal(report.authenticationProblemDocumented, false);
  assert.equal(report.step6fSafeToDesign, true);
  assert.equal(report.manualAction, null);
});

test("captured output redacts api-key / token / github-shaped secrets and never includes them in JSON", () => {
  const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
  const githubSecret = "ghp_ABCDEFGHIJ1234567890zzzz";
  const spawn = fakeSpawn({
    version: okVersion(`codex 0.1.0 token=${secret}\n`),
    help: okHelp(`${PASS_HELP_TEXT}\nauth-token: ${githubSecret}`)
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(githubSecret), false);
});

test("each discovery command captures stdout, stderr, exitCode, argv, executable, and timestamps", () => {
  const spawn = fakeSpawn({
    version: () => ({ status: 0, stdout: "codex 0.1.0\n", stderr: "" }),
    help: () => ({ status: 0, stdout: PASS_HELP_TEXT, stderr: "warn\n" })
  });
  const report = runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
  assert.equal(report.discoveryCommands.length, 2);
  for (const entry of report.discoveryCommands) {
    assert.equal(entry.executable, "codex");
    assert.deepEqual([...entry.argv], entry.name === "version" ? ["--version"] : ["--help"]);
    assert.equal(entry.shell, false);
    assert.equal(typeof entry.startedAt, "string");
    assert.equal(typeof entry.finishedAt, "string");
    assert.equal(typeof entry.exitCode, "number");
  }
});

test("detectHelpEvidence isolates pattern matching and reports each evidence flag independently", () => {
  assert.deepEqual(detectHelpEvidence(PASS_HELP_TEXT), {
    nonInteractivePromptDocumented: true,
    safeModeDocumented: true,
    interactiveOnly: false,
    authenticationProblemDocumented: false
  });
  assert.deepEqual(detectHelpEvidence("no relevant info"), {
    nonInteractivePromptDocumented: false,
    safeModeDocumented: false,
    interactiveOnly: false,
    authenticationProblemDocumented: false
  });
  assert.equal(detectHelpEvidence(AUTH_REQUIRED_HELP_TEXT).authenticationProblemDocumented, true);
});

test("discovery never mutates project files in the working directory and never spawns shell processes", () => {
  const directory = temporaryDirectory();
  try {
    const projectPath = path.join(directory, "demo-project");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, "PLAN.md"), "# Plan\n");
    const before = fs.readFileSync(path.join(projectPath, "PLAN.md"), "utf8");
    const spawn = fakeSpawn({ version: enoent, help: enoent });
    runCodexDiscovery({ env: { PATH: "/usr/bin" }, spawn });
    assert.equal(fs.readFileSync(path.join(projectPath, "PLAN.md"), "utf8"), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CLI agent-discover emits classification JSON and exits non-zero when codex is not installed", () => {
  let stdout = "";
  const originalWrite = process.stdout.write;
  let exitCode;
  try {
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    exitCode = runCli(["agent-discover", "--adapter", "codex"]);
  } finally { process.stdout.write = originalWrite; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.classification, CLASSIFICATIONS.NOT_INSTALLED);
  assert.equal(parsed.codexOnPath, false);
  assert.equal(parsed.step6fSafeToDesign, false);
  assert.notEqual(exitCode, 0);
});

test("CLI agent-discover rejects non-codex adapter selections", () => {
  let stdout = "";
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    assert.throws(
      () => runCli(["agent-discover", "--adapter", "claude-code"]),
      (error) => code(error, "INVALID_ARGUMENT")
    );
  } finally { process.stdout.write = originalWrite; }
});

test("Step 6E does not enable real-agent execution; runAgentTask still rejects codex", () => {
  const directory = temporaryDirectory();
  try {
    const allowedRoot = path.join(directory, "projects");
    const projectPath = path.join(allowedRoot, "demo-project");
    fs.mkdirSync(path.join(projectPath, "out", "prompts"), { recursive: true });
    for (const [name, content] of Object.entries({
      "PLAN.md": "# Project\n", "BUILDING_REFERENCE.md": "# Ref\n",
      "BUILD_LOG.md": "# Log\n", "CURRENT_TASK.md": "# Task\n"
    })) fs.writeFileSync(path.join(projectPath, name), content);
    fs.writeFileSync(path.join(projectPath, "STATE.json"), `${JSON.stringify({
      currentPhase: "6E", currentTask: "discovery", currentBranch: "main", currentPr: null,
      assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
      lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
      containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(projectPath, "out", "prompts", "next-task.md"), "# Prompt\n");
    assert.throws(
      () => runAgentTask({ allowedRoot, projectPath, adapterId: "codex", promptPath: "out/prompts/next-task.md" }),
      (error) => code(error, "REAL_AGENT_EXECUTION_DISABLED")
    );
    assert.throws(
      () => runCodexSmoke({ adapterId: "codex", allowedRoot, projectPath, explicitSmokePermit: true, autoApproval: true, spawn: () => { throw new Error("must not spawn"); } }),
      (error) => code(error, "REAL_AGENT_AUTO_APPROVAL_DISABLED")
    );
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
