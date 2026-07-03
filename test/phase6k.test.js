import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCliSync } from "./helpers/spawned-cli.js";
import {
  CLASSIFICATIONS,
  CLOSEOUT_REPORT_RELATIVE,
  runActivationCloseoutReadonlyCodex
} from "../src/activation-closeout.js";
import { KNOWN_COMMANDS, run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = "src/cli.js";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_COMMANDS = Object.freeze([
  "agent-codex-readonly-smoke",
  "agent-codex-readonly-inspect",
  "agent-codex-readonly-inspect-record",
  "agent-codex-readonly-prompt-record",
  "activation-clean-fixture-artifacts"
]);

const REQUIRED_MODULES = Object.freeze([
  "src/agent-readonly-exec.js",
  "src/agent-readonly-inspect.js",
  "src/agent-readonly-inspect-record.js",
  "src/agent-readonly-prompt-record.js",
  "src/activation-fixture-hygiene.js"
]);

const validState = Object.freeze({
  currentPhase: "6K", currentTask: "activation-closeout", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext(projectId = "example-project") {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, projectId);
  fs.mkdirSync(projectPath, { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Plan\n",
    "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n",
    "CURRENT_TASK.md": "# Task\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  return { directory, allowedRoot, projectPath, projectId };
}

function baseRequest(context, overrides = {}) {
  return {
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    projectId: context.projectId,
    knownCommands: [...KNOWN_COMMANDS],
    explicitCloseoutPermit: true,
    now: () => "2026-06-25T16-00-00-000Z",
    repoRoot: REPO_ROOT,
    ...overrides
  };
}

test("closeout request rejects unsupported / user-supplied keys (executable, argv, shell, command, prompt, …)", () => {
  const context = makeContext();
  try {
    for (const evil of ["executable", "argv", "shell", "shellCommand", "command", "prompt", "promptFile", "instruction", "cwd"]) {
      assert.throws(
        () => runActivationCloseoutReadonlyCodex({ ...baseRequest(context), [evil]: "/bin/sh -c rm" }),
        (error) => code(error, "INVALID_CLOSEOUT_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout requires explicitCloseoutPermit=true", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => runActivationCloseoutReadonlyCodex(baseRequest(context, { explicitCloseoutPermit: false })),
      (error) => code(error, "CLOSEOUT_PERMIT_REQUIRED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout rejects unsafe / traversal project paths as STEP_6K_BLOCKED_UNSAFE_PROJECT", () => {
  const context = makeContext();
  try {
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context, { projectPath: context.directory }));
    assert.equal(report.classification, CLASSIFICATIONS.UNSAFE_PROJECT);
    assert.equal(report.closeoutPassed, false);
    assert.equal(report.step6lOrNextPhaseSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout rejects missing project as STEP_6K_BLOCKED_MISSING_PROJECT", () => {
  const context = makeContext();
  try {
    fs.rmSync(context.projectPath, { recursive: true, force: true });
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.MISSING_PROJECT);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout PASS: required commands, modules, safety invariants, cleanup, fixture-clean all green", () => {
  const context = makeContext();
  try {
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.closeoutPassed, true);
    assert.equal(report.readonlyActivationComplete, true);
    assert.equal(report.workspaceWriteEnabled, false);
    assert.equal(report.arbitraryPromptExecutionEnabled, false);
    assert.equal(report.autonomousExecutionEnabled, false);
    assert.equal(report.step6lOrNextPhaseSafeToDesign, true);
    assert.deepEqual([...report.missingCommands], []);
    assert.deepEqual([...report.missingModules], []);
    assert.equal(report.safetyInvariantsOk, true);
    assert.equal(report.cleanupResult.cleanupSafe, true);
    assert.equal(report.fixtureClean, true);
    assert.equal(report.rootBuildLogCreated, false);
    assert.equal(report.rootStateJsonCreated, false);
    assert.deepEqual([...report.blockedReasons], []);
    assert.equal(report.nextAllowedStep, "6L or later (design only)");
    for (const required of REQUIRED_COMMANDS) assert.ok(report.checkedCommands.includes(required));
    for (const required of REQUIRED_MODULES) assert.ok(report.checkedModules.includes(required));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout MISSING_COMMAND: required command missing from knownCommands → STEP_6K_BLOCKED_MISSING_COMMAND", () => {
  const context = makeContext();
  try {
    const reduced = [...KNOWN_COMMANDS].filter((cmd) => cmd !== "agent-codex-readonly-prompt-record");
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context, { knownCommands: reduced }));
    assert.equal(report.classification, CLASSIFICATIONS.MISSING_COMMAND);
    assert.ok(report.missingCommands.includes("agent-codex-readonly-prompt-record"));
    assert.equal(report.closeoutPassed, false);
    assert.equal(report.step6lOrNextPhaseSafeToDesign, false);
    assert.ok(report.blockedReasons.some((reason) => reason.startsWith("missing-commands:")));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout MISSING_MODULE: a required source module file is absent → STEP_6K_BLOCKED_MISSING_MODULE", () => {
  const context = makeContext();
  try {
    // Point the closeout at a tmp repoRoot that lacks the required modules
    const fakeRepoRoot = path.join(context.directory, "fake-repo");
    fs.mkdirSync(fakeRepoRoot, { recursive: true });
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context, { repoRoot: fakeRepoRoot }));
    assert.equal(report.classification, CLASSIFICATIONS.MISSING_MODULE);
    assert.equal(report.missingModules.length, REQUIRED_MODULES.length);
    assert.equal(report.closeoutPassed, false);
    assert.equal(report.step6lOrNextPhaseSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout FIXTURE_DIRTY: leftover artifact that cleanup cannot remove → STEP_6K_BLOCKED_FIXTURE_DIRTY", () => {
  const context = makeContext();
  try {
    // Plant a NON-whitelisted file under out/ so cleanup can't reach it but it dirties the fixture
    fs.mkdirSync(path.join(context.projectPath, "out"), { recursive: true });
    fs.writeFileSync(path.join(context.projectPath, "out", "non-whitelisted.txt"), "leftover\n");
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.FIXTURE_DIRTY);
    assert.equal(report.fixtureClean, false);
    assert.equal(report.closeoutPassed, false);
    assert.ok(report.blockedReasons.some((reason) => reason.startsWith("fixture-dirty:")));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout invokes Step 6J cleanup and removes Step 6H/6I artifacts before checking fixture cleanliness", () => {
  const context = makeContext();
  try {
    // Plant whitelisted Step 6H/6I artifacts; cleanup must clear them and PASS
    fs.writeFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "# Stale\n");
    fs.mkdirSync(path.join(context.projectPath, "out", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(context.projectPath, "out", "prompts", "step-6i-readonly-prompt.md"), "old\n");
    fs.mkdirSync(path.join(context.projectPath, "out", "agent_outputs"), { recursive: true });
    fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "step-6h-readonly-inspect-x.json"), "{}\n");
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.cleanupResult.classification, "STEP_6J_PASS");
    assert.equal(report.fixtureClean, true);
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout never sets workspaceWriteEnabled / arbitraryPromptExecutionEnabled / autonomousExecutionEnabled to true on PASS", () => {
  const context = makeContext();
  try {
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.workspaceWriteEnabled, false);
    assert.equal(report.arbitraryPromptExecutionEnabled, false);
    assert.equal(report.autonomousExecutionEnabled, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout asserts every Step 6F/6G/6I safety invariant (shell:false, sandbox:read-only, ask-for-approval:never)", () => {
  const context = makeContext();
  try {
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    const ids = report.safetyInvariantResults.map((entry) => entry.id);
    for (const required of [
      "step-6f.shell", "step-6f.sandbox-read-only", "step-6f.ask-for-approval-never",
      "step-6f.argv-no-forbidden-tokens", "step-6f.prompt-hardcoded",
      "step-6g.shell", "step-6g.sandbox-read-only", "step-6g.ask-for-approval-never",
      "step-6g.argv-no-forbidden-tokens",
      "step-6i.shell", "step-6i.sandbox-read-only", "step-6i.ask-for-approval-never",
      "step-6i.marker-pinned", "step-6i.prompt-source-pinned", "step-6i.argv-no-forbidden-tokens",
      "real-agent.executionAllowed-false", "real-agent.preflightSupported-true",
      "cleanup.whitelist-narrow"
    ]) assert.ok(ids.includes(required), `safety invariant ${required} must be checked`);
    assert.equal(report.safetyInvariantResults.every((entry) => entry.ok === true), true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout does NOT write any report by default; only writes when writeReport=true", () => {
  const context = makeContext();
  try {
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.reportWritten, false);
    assert.equal(report.reportPath, null);
    assert.equal(fs.existsSync(path.join(context.projectPath, CLOSEOUT_REPORT_RELATIVE)), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout writes a confined project-local report only when writeReport=true; report path stays inside the project root", () => {
  const context = makeContext();
  try {
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context, { writeReport: true }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.reportWritten, true);
    assert.equal(report.reportPath, CLOSEOUT_REPORT_RELATIVE);
    const absolute = path.join(context.projectPath, CLOSEOUT_REPORT_RELATIVE);
    assert.equal(fs.existsSync(absolute), true);
    const rel = path.relative(context.projectPath, absolute);
    assert.equal(rel.startsWith(".."), false);
    assert.equal(path.isAbsolute(rel), false);
    const payload = JSON.parse(fs.readFileSync(absolute, "utf8"));
    assert.equal(payload.schema, "hephaestus.step-6k.activation-closeout/v1");
    assert.equal(payload.classification, CLASSIFICATIONS.PASS);
    assert.equal(payload.readonlyActivationComplete, true);
    assert.equal(payload.workspaceWriteEnabled, false);
    assert.equal(payload.arbitraryPromptExecutionEnabled, false);
    assert.equal(payload.autonomousExecutionEnabled, false);
    assert.equal(payload.nextAllowedStep, "6L or later (design only)");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout never creates a root BUILD_LOG.md or root STATE.json in the host repo", () => {
  const context = makeContext();
  try {
    const before = {
      buildLog: fs.existsSync(path.join(REPO_ROOT, "BUILD_LOG.md")),
      stateJson: fs.existsSync(path.join(REPO_ROOT, "STATE.json"))
    };
    runActivationCloseoutReadonlyCodex(baseRequest(context, { writeReport: true }));
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "BUILD_LOG.md")), before.buildLog);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "STATE.json")), before.stateJson);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("closeout never runs real Codex (no spawn key in request shape, no spawn observed in PASS path)", () => {
  const context = makeContext();
  try {
    // The closeout request shape does not accept `spawn`. Try to inject one and confirm it is rejected.
    assert.throws(
      () => runActivationCloseoutReadonlyCodex({ ...baseRequest(context), spawn: () => { throw new Error("must not spawn"); } }),
      (error) => code(error, "INVALID_CLOSEOUT_REQUEST")
    );
    // On PASS the closeout completes without invoking codex
    const report = runActivationCloseoutReadonlyCodex(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-closeout-readonly-codex exits 0 on PASS and writes no report by default", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = runCli(["activation-closeout-readonly-codex", "--config", configPath, "--project", "example-project"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.closeoutPassed, true);
    assert.equal(parsed.reportWritten, false);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(context.projectPath, CLOSEOUT_REPORT_RELATIVE)), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-closeout-readonly-codex with --write-report writes a project-local report and exits 0", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = runCli(["activation-closeout-readonly-codex", "--config", configPath, "--project", "example-project", "--write-report"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.reportWritten, true);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(context.projectPath, CLOSEOUT_REPORT_RELATIVE)), true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI activation-closeout-readonly-codex exits 0 on PASS (real process)", () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const result = spawnCliSync(process.execPath, [CLI_PATH, "activation-closeout-readonly-codex", "--config", configPath, "--project", "example-project"], {
      encoding: "utf8",
      shell: false,
      timeout: 60_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.closeoutPassed, true);
    assert.equal(parsed.readonlyActivationComplete, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("KNOWN_COMMANDS export contains every required Step 6F–6J/6K command", () => {
  for (const required of [...REQUIRED_COMMANDS, "activation-closeout-readonly-codex"]) {
    assert.ok(KNOWN_COMMANDS.includes(required), `KNOWN_COMMANDS must include ${required}`);
  }
});
