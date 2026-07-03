import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnCliSync, withEmptyPath } from "./helpers/spawned-cli.js";
import {
  CLASSIFICATIONS,
  CLASSIFICATION_PRIORITY,
  READONLY_SMOKE_ARGV,
  READONLY_SMOKE_FLAGS,
  READONLY_SMOKE_MARKER,
  READONLY_SMOKE_PROMPT,
  runCodexReadonlySmoke
} from "../src/agent-readonly-exec.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = "src/cli.js";

const validState = Object.freeze({
  currentPhase: "6F", currentTask: "codex-readonly-exec", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext() {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, "demo-project");
  fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "test"), { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Agent project\n",
    "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n",
    "CURRENT_TASK.md": "# Task\n",
    "package.json": `${JSON.stringify({ name: "demo-project", version: "0.0.0" }, null, 2)}\n`,
    "src/index.js": "export const greeting = 'hi';\n",
    "test/index.test.js": "import test from 'node:test'; test('noop', () => {});\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  return { directory, allowedRoot, projectPath };
}

function fakeSpawn(behavior) {
  const calls = [];
  const fn = (executable, args, options) => {
    calls.push(Object.freeze({
      executable, args: [...args], shell: options?.shell,
      env: { ...options?.env }, cwd: options?.cwd, timeout: options?.timeout
    }));
    return behavior(executable, args, options, calls);
  };
  fn.calls = calls;
  return fn;
}

function baseRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    explicitReadonlySmokePermit: true,
    env: { PATH: "/usr/bin" },
    ...overrides
  };
}

function snapshot(projectPath) {
  const out = {};
  for (const name of ["PLAN.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "src/index.js", "test/index.test.js"]) {
    const file = path.join(projectPath, name);
    out[name] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return out;
}

test("readonly smoke argv places --sandbox read-only and --ask-for-approval never BEFORE exec (top-level options) and ends with the hardcoded prompt", () => {
  const argv = [...READONLY_SMOKE_ARGV];
  assert.deepEqual(argv.slice(0, 2), ["--sandbox", "read-only"]);
  assert.deepEqual(argv.slice(2, 4), ["--ask-for-approval", "never"]);
  assert.equal(argv[4], "exec");
  assert.equal(argv[5], READONLY_SMOKE_PROMPT);
  assert.equal(argv.length, 6);
  const sandboxIndex = argv.indexOf("--sandbox");
  const approvalIndex = argv.indexOf("--ask-for-approval");
  const execIndex = argv.indexOf("exec");
  assert.ok(sandboxIndex < execIndex, "--sandbox must come before exec");
  assert.ok(approvalIndex < execIndex, "--ask-for-approval must come before exec");
  assert.equal(execIndex, argv.length - 2, "exec must be the penultimate token followed only by the prompt");
  assert.equal(READONLY_SMOKE_FLAGS.subcommand, "exec");
  assert.equal(READONLY_SMOKE_FLAGS.sandbox, "read-only");
  assert.equal(READONLY_SMOKE_FLAGS.sandboxScope, "top-level");
  assert.equal(READONLY_SMOKE_FLAGS.askForApproval, "never");
  assert.equal(READONLY_SMOKE_FLAGS.askForApprovalScope, "top-level");
  assert.equal(READONLY_SMOKE_FLAGS.shell, false);
});

test("regression: readonly smoke argv does NOT use the old invalid `exec --sandbox … --ask-for-approval …` shape", () => {
  const argv = [...READONLY_SMOKE_ARGV];
  assert.notEqual(argv[0], "exec", "exec must not be the first token (it would consume top-level flags as exec args)");
  const execIndex = argv.indexOf("exec");
  const sandboxIndex = argv.indexOf("--sandbox");
  const approvalIndex = argv.indexOf("--ask-for-approval");
  assert.notEqual(execIndex, -1);
  assert.notEqual(sandboxIndex, -1);
  assert.notEqual(approvalIndex, -1);
  assert.equal(sandboxIndex > execIndex, false, "--sandbox must NOT appear after exec (was the source of the Codex parser error)");
  assert.equal(approvalIndex > execIndex, false, "--ask-for-approval must NOT appear after exec (was the source of the Codex parser error)");
});

test("readonly smoke argv contains no dangerous bypass / workspace-write / danger-full-access flags", () => {
  const forbidden = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--add-dir",
    "--search",
    "-c",
    "workspace-write",
    "danger-full-access"
  ];
  const flat = [...READONLY_SMOKE_ARGV];
  for (const token of forbidden) assert.equal(flat.includes(token), false, `argv must not contain ${token}`);
});

test("readonly smoke prompt forbids edits, commands, network access, and demands exact marker line", () => {
  assert.match(READONLY_SMOKE_PROMPT, /Do not modify any files/u);
  assert.match(READONLY_SMOKE_PROMPT, /Do not run any shell commands/u);
  assert.match(READONLY_SMOKE_PROMPT, /Do not access the network/u);
  assert.match(READONLY_SMOKE_PROMPT, /Do not request approvals/u);
  assert.ok(READONLY_SMOKE_PROMPT.includes(READONLY_SMOKE_MARKER));
});

test("readonly smoke uses shell:false, hardcoded executable, hardcoded argv, closed stdin, and reduced env", () => {
  const context = makeContext();
  try {
    let observedOptions;
    const spawn = (executable, args, options) => {
      observedOptions = options;
      return { status: 0, stdout: `${READONLY_SMOKE_MARKER}\n`, stderr: "" };
    };
    spawn.calls = [];
    const wrapped = (executable, args, options) => {
      spawn.calls.push({ executable, args: [...args], shell: options?.shell, env: { ...options?.env }, cwd: options?.cwd, input: options?.input });
      return spawn(executable, args, options);
    };
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn: wrapped }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0];
    assert.equal(call.executable, "codex");
    assert.equal(call.shell, false);
    assert.deepEqual(call.args, [...READONLY_SMOKE_ARGV]);
    assert.deepEqual(Object.keys(call.env).sort(), ["LANG", "PATH"]);
    assert.equal(call.env.LANG, "C.UTF-8");
    assert.equal(call.input, "", "stdin must be explicitly closed/empty so codex does not block reading from stdin");
    assert.equal(observedOptions.shell, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke rejects user-supplied executable, argv, shell, command, or prompt fields", () => {
  const context = makeContext();
  try {
    for (const evilKey of ["executable", "argv", "shell", "shellCommand", "command", "prompt", "autoApproval", "cwd"]) {
      assert.throws(
        () => runCodexReadonlySmoke({ ...baseRequest(context), [evilKey]: "/bin/sh -c rm" }),
        (error) => code(error, "INVALID_READONLY_SMOKE_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke rejects non-codex adapters", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["claude-code", "opencode", "fixture-agent", "made-up-agent"]) {
      assert.throws(
        () => runCodexReadonlySmoke(baseRequest(context, { adapterId })),
        (error) => code(error, "READONLY_SMOKE_ADAPTER_NOT_ALLOWED")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke requires explicitReadonlySmokePermit=true", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => runCodexReadonlySmoke(baseRequest(context, { explicitReadonlySmokePermit: false })),
      (error) => code(error, "READONLY_SMOKE_PERMIT_REQUIRED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke missing codex on PATH classifies as STEP_6F_BLOCKED_CODEX_NOT_INSTALLED", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("not found"), { code: "ENOENT" }) }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.NOT_INSTALLED);
    assert.equal(report.markerCaptured, false);
    assert.equal(report.step6gSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke non-zero exit classifies as STEP_6F_BLOCKED_CODEX_EXIT_NONZERO", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 9, stdout: "", stderr: "codex error\n" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.EXIT_NONZERO);
    assert.equal(report.exitCode, 9);
    assert.equal(report.markerCaptured, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke timeout classifies as STEP_6F_BLOCKED_CODEX_TIMEOUT", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({
      status: null, signal: "SIGTERM", stdout: "", stderr: "",
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.TIMEOUT);
    assert.equal(report.timedOut, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke zero-exit but missing marker classifies as STEP_6F_BLOCKED_MARKER_MISSING", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "hello world\n", stderr: "" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MISSING);
    assert.equal(report.exitCode, 0);
    assert.equal(report.markerCaptured, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke unauthenticated text classifies as STEP_6F_BLOCKED_CODEX_NOT_AUTHENTICATED", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 1, stdout: "", stderr: "Not authenticated. Please sign in by running `codex login`.\n" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.NOT_AUTHENTICATED);
    assert.equal(report.usageLimitDetected, false);
    assert.equal(report.retryAfter, null);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke usage-limit text classifies as STEP_6F_BLOCKED_CODEX_USAGE_LIMIT and does NOT count as auth failure or generic nonzero", () => {
  const context = makeContext();
  try {
    const usageStderr = "ERROR: You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/explore/pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 30th, 2026 2:12 PM.\n";
    const spawn = fakeSpawn(() => ({ status: 1, stdout: "", stderr: usageStderr }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.USAGE_LIMIT);
    assert.notEqual(report.classification, CLASSIFICATIONS.NOT_AUTHENTICATED);
    assert.notEqual(report.classification, CLASSIFICATIONS.EXIT_NONZERO);
    assert.equal(report.usageLimitDetected, true);
    assert.equal(report.retryAfter, "Jun 30th, 2026 2:12 PM");
    assert.match(report.manualAction, /Codex usage limit reached\./u);
    assert.match(report.manualAction, /Wait until the reported reset time/u);
    assert.equal(report.step6gSafeToDesign, false);
    assert.equal(report.projectMutated, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("usage-limit detection matches multiple phrasings without retry-time text", () => {
  const context = makeContext();
  try {
    for (const stderr of [
      "ERROR: You've hit your usage limit. Upgrade to Pro.\n",
      "ERROR: Visit https://chatgpt.com/codex/settings/usage to purchase more credits.\n",
      "ERROR: rate limit exceeded\n",
      "ERROR: 429 too many requests\n",
      "ERROR: quota exceeded for this project\n"
    ]) {
      const spawn = fakeSpawn(() => ({ status: 1, stdout: "", stderr }));
      const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
      assert.equal(report.classification, CLASSIFICATIONS.USAGE_LIMIT, `expected USAGE_LIMIT for stderr: ${stderr}`);
      assert.equal(report.usageLimitDetected, true);
      assert.equal(report.retryAfter, null, `no retry time expected for stderr: ${stderr}`);
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("authentication text still wins over usage-limit text when both are present", () => {
  const context = makeContext();
  try {
    const combinedStderr = "ERROR: 401 Unauthorized. Please sign in by running `codex login`.\nNote: account also has usage limit reached.\n";
    const spawn = fakeSpawn(() => ({ status: 1, stdout: "", stderr: combinedStderr }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.NOT_AUTHENTICATED);
    assert.equal(report.usageLimitDetected, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("mutation detection still outranks usage-limit text", () => {
  const context = makeContext();
  try {
    const usageStderr = "ERROR: You've hit your usage limit. try again at Jun 30th, 2026 2:12 PM.\n";
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "PLAN.md"), "# Mutated\n");
      return { status: 1, stdout: "", stderr: usageStderr };
    });
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MUTATION_DETECTED);
    assert.equal(report.projectMutated, true);
    assert.equal(report.usageLimitDetected, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("timeout still outranks usage-limit text", () => {
  const context = makeContext();
  try {
    const usageStderr = "ERROR: You've hit your usage limit. try again at later.\n";
    const spawn = fakeSpawn(() => ({
      status: null, signal: "SIGTERM", stdout: "", stderr: usageStderr,
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.TIMEOUT);
    assert.equal(report.timedOut, true);
    assert.equal(report.usageLimitDetected, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("generic nonzero exit without usage-limit / auth / interactive text still classifies as EXIT_NONZERO", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 7, stdout: "", stderr: "some unrelated codex error happened\n" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.EXIT_NONZERO);
    assert.equal(report.usageLimitDetected, false);
    assert.equal(report.retryAfter, null);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("classification priority order is timeout > mutation > auth > usage-limit > interaction > nonzero > marker-missing > pass (NOT_INSTALLED guards everything)", () => {
  assert.deepEqual([...CLASSIFICATION_PRIORITY], [
    CLASSIFICATIONS.NOT_INSTALLED,
    CLASSIFICATIONS.TIMEOUT,
    CLASSIFICATIONS.MUTATION_DETECTED,
    CLASSIFICATIONS.NOT_AUTHENTICATED,
    CLASSIFICATIONS.USAGE_LIMIT,
    CLASSIFICATIONS.INTERACTIVE,
    CLASSIFICATIONS.EXIT_NONZERO,
    CLASSIFICATIONS.MARKER_MISSING,
    CLASSIFICATIONS.PASS
  ]);
});

test("usage-limit classification exits non-zero through the CLI runner", { concurrency: false }, () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = withEmptyPath(emptyPathDir, () => runCli(["agent-codex-readonly-smoke", "--config", configPath, "--project", "demo-project"]));
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.notEqual(exitCode, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke interactive/approval text classifies as STEP_6F_BLOCKED_INTERACTIVE", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "Waiting for approval...\n", stderr: "" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.INTERACTIVE);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke detects mutations to protected files even when codex exits 0 and emits the marker", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "PLAN.md"), "# Mutated\n");
      return { status: 0, stdout: `${READONLY_SMOKE_MARKER}\n`, stderr: "" };
    });
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MUTATION_DETECTED);
    assert.equal(report.projectMutated, true);
    assert.ok(report.mutatedFiles.includes("PLAN.md"));
    assert.equal(report.markerCaptured, false);
    assert.equal(report.step6gSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke detects unexpected new files under tracked dirs", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "src", "evil.js"), "// evil\n");
      return { status: 0, stdout: `${READONLY_SMOKE_MARKER}\n`, stderr: "" };
    });
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MUTATION_DETECTED);
    assert.equal(report.projectMutated, true);
    assert.ok(report.mutatedFiles.includes("src/evil.js"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke passes only when exit 0 AND marker present AND no mutation", () => {
  const context = makeContext();
  try {
    const before = snapshot(context.projectPath);
    const spawn = fakeSpawn(() => ({ status: 0, stdout: `${READONLY_SMOKE_MARKER}\n`, stderr: "" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.exitCode, 0);
    assert.equal(report.markerCaptured, true);
    assert.equal(report.projectMutated, false);
    assert.equal(report.step6gSafeToDesign, true);
    assert.equal(report.manualAction, null);
    assert.deepEqual(snapshot(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke captures stdout, stderr, exit code, argv, executable, timestamps, timeout, and error code", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: `${READONLY_SMOKE_MARKER} ok\n`, stderr: "warn\n" }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn, timeoutMs: 12345 }));
    assert.equal(report.executable, "codex");
    assert.deepEqual([...report.argv], [...READONLY_SMOKE_ARGV]);
    assert.equal(report.invocation.shell, false);
    assert.equal(report.invocation.sandbox, "read-only");
    assert.equal(report.invocation.sandboxScope, "top-level");
    assert.equal(report.invocation.askForApproval, "never");
    assert.equal(report.invocation.askForApprovalScope, "top-level");
    assert.equal(report.invocation.subcommand, "exec");
    assert.equal(report.invocation.dangerousBypass, false);
    assert.equal(report.invocation.stdinPolicy, "closed-empty");
    assert.ok(typeof report.startedAt === "string" && report.startedAt.length > 0);
    assert.ok(typeof report.finishedAt === "string" && report.finishedAt.length > 0);
    assert.equal(report.timeoutMs, 12345);
    assert.equal(typeof report.exitCode, "number");
    assert.ok(report.stdout.includes(READONLY_SMOKE_MARKER));
    assert.equal(report.stderr.trim(), "warn");
    assert.equal(report.errorCode, null);
    assert.equal(report.timedOut, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke redacts api-key / token / github-shaped secrets and never includes them in the JSON report", () => {
  const context = makeContext();
  try {
    const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
    const ghSecret = "ghp_ABCDEFGHIJ1234567890zzzz";
    const spawn = fakeSpawn(() => ({
      status: 0,
      stdout: `${READONLY_SMOKE_MARKER}\ntoken=${secret}\n`,
      stderr: `auth=${ghSecret}\n`
    }));
    const report = runCodexReadonlySmoke(baseRequest(context, { spawn }));
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(ghSecret), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke rejects project paths outside the allowed root before spawning", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => { throw new Error("must not spawn"); });
    assert.throws(
      () => runCodexReadonlySmoke(baseRequest(context, { spawn, projectPath: context.directory })),
      (error) => code(error, "OUTSIDE_ALLOWED_ROOT")
    );
    assert.equal(spawn.calls.length, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("readonly smoke applies a bounded timeout to the spawn options", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: `${READONLY_SMOKE_MARKER}\n`, stderr: "" }));
    runCodexReadonlySmoke(baseRequest(context, { spawn }));
    assert.equal(typeof spawn.calls[0].timeout, "number");
    assert.ok(spawn.calls[0].timeout > 0 && spawn.calls[0].timeout <= 5 * 60_000);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-codex-readonly-smoke returns nonzero exit when codex is unavailable on PATH", { concurrency: false }, () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = withEmptyPath(emptyPathDir, () => runCli(["agent-codex-readonly-smoke", "--config", configPath, "--project", "demo-project"]));
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapterId, "codex");
    assert.equal(parsed.mode, "readonly-exec-smoke");
    assert.equal(parsed.invocation.shell, false);
    assert.equal(parsed.invocation.sandbox, "read-only");
    assert.equal(parsed.invocation.askForApproval, "never");
    assert.equal(parsed.invocation.dangerousBypass, false);
    assert.equal(parsed.executable, "codex");
    assert.deepEqual(parsed.argv, [...READONLY_SMOKE_ARGV]);
    assert.notEqual(exitCode, 0);
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-codex-readonly-smoke rejects non-codex adapter selections", { concurrency: false }, () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      assert.throws(
        () => runCli(["agent-codex-readonly-smoke", "--config", configPath, "--project", "demo-project", "--adapter", "claude-code"]),
        (error) => code(error, "INVALID_ARGUMENT")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI agent-codex-readonly-smoke process exits non-zero when codex is missing", { concurrency: false }, () => {
  const context = makeContext();
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "demo-project", path: "demo-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    const env = { ...process.env, PATH: emptyPathDir, Path: emptyPathDir, path: emptyPathDir };
    const result = spawnCliSync(process.execPath, [CLI_PATH, "agent-codex-readonly-smoke", "--config", configPath, "--project", "demo-project"], {
      encoding: "utf8",
      shell: false,
      env,
      timeout: 60_000
    });
    assert.equal(result.error, undefined, `spawn failed: ${result.error?.message ?? ""}`);
    assert.equal(typeof result.status, "number");
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.NOT_INSTALLED);
    assert.equal(parsed.invocation.sandbox, "read-only");
    assert.equal(parsed.invocation.askForApproval, "never");
    assert.equal(parsed.invocation.shell, false);
    assert.equal(parsed.invocation.dangerousBypass, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
