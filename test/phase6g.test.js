import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnCliSync, withEmptyPath } from "./helpers/spawned-cli.js";
import {
  CLASSIFICATIONS,
  CLASSIFICATION_PRIORITY,
  INSPECT_FLAGS,
  READONLY_INSPECT_MARKER,
  buildInspectArgv,
  parseInspectReport,
  runCodexReadonlyInspect
} from "../src/agent-readonly-inspect.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = "src/cli.js";

const validState = Object.freeze({
  currentPhase: "6G", currentTask: "codex-readonly-inspect", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-run"
});

function temporaryDirectory() { return fs.mkdtempSync(path.join(path.resolve("test"), "tmp-")); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

function makeContext(projectId = "demo-project") {
  const directory = temporaryDirectory();
  const allowedRoot = path.join(directory, "projects");
  const projectPath = path.join(allowedRoot, projectId);
  fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "test"), { recursive: true });
  for (const [name, content] of Object.entries({
    "PLAN.md": "# Agent project\n",
    "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n",
    "CURRENT_TASK.md": "# Task\n",
    "package.json": `${JSON.stringify({ name: projectId, version: "0.0.0" }, null, 2)}\n`,
    "src/index.js": "export const greeting = 'hi';\n",
    "test/index.test.js": "import test from 'node:test'; test('noop', () => {});\n"
  })) fs.writeFileSync(path.join(projectPath, name), content);
  writeJson(path.join(projectPath, "STATE.json"), validState);
  return { directory, allowedRoot, projectPath, projectId };
}

function fakeSpawn(behavior) {
  const calls = [];
  const fn = (executable, args, options) => {
    calls.push(Object.freeze({
      executable, args: [...args], shell: options?.shell,
      env: { ...options?.env }, cwd: options?.cwd, timeout: options?.timeout, input: options?.input
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
    projectId: context.projectId,
    explicitReadonlyInspectPermit: true,
    env: { PATH: "/usr/bin" },
    ...overrides
  };
}

function validReportOutput(projectId, files = ["PLAN.md", "STATE.json"], summary = "Fixture has plan and state.") {
  return [
    `Some Codex preamble can appear first.`,
    READONLY_INSPECT_MARKER,
    `project=${projectId}`,
    "readonly=true",
    `files_inspected=${files.join(",")}`,
    `summary=${summary}`,
    ""
  ].join("\n");
}

function snapshot(projectPath) {
  const out = {};
  for (const name of ["PLAN.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "src/index.js", "test/index.test.js"]) {
    const file = path.join(projectPath, name);
    out[name] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return out;
}

test("buildInspectArgv produces fixed top-level --sandbox read-only / --ask-for-approval never before exec and a templated prompt", () => {
  const argv = buildInspectArgv("demo-project");
  assert.deepEqual(argv.slice(0, 2), ["--sandbox", "read-only"]);
  assert.deepEqual(argv.slice(2, 4), ["--ask-for-approval", "never"]);
  assert.equal(argv[4], "exec");
  assert.equal(argv.length, 6);
  const prompt = argv[5];
  assert.ok(prompt.includes(READONLY_INSPECT_MARKER));
  assert.ok(prompt.includes("project=demo-project"));
  assert.match(prompt, /Do not modify, create, delete, rename, or move any file/u);
  assert.match(prompt, /Do not access the network/u);
  assert.match(prompt, /Do not run any shell commands/u);
});

test("buildInspectArgv rejects unsafe project ids (traversal / control chars / wrong shape)", () => {
  for (const evil of ["../escape", "demo project", "a/b", "", "a".repeat(70), "demo;rm", "demo$(rm)"]) {
    assert.throws(() => buildInspectArgv(evil), (error) => code(error, "INVALID_INSPECT_PROJECT_ID"));
  }
});

test("argv contains no dangerous bypass / workspace-write / danger-full-access tokens", () => {
  const argv = buildInspectArgv("demo-project");
  for (const forbidden of [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--add-dir",
    "--search",
    "-c",
    "workspace-write",
    "danger-full-access"
  ]) assert.equal(argv.includes(forbidden), false);
});

test("INSPECT_FLAGS expose shell:false, sandbox:read-only top-level, ask-for-approval:never top-level, exec subcommand", () => {
  assert.equal(INSPECT_FLAGS.shell, false);
  assert.equal(INSPECT_FLAGS.sandbox, "read-only");
  assert.equal(INSPECT_FLAGS.sandboxScope, "top-level");
  assert.equal(INSPECT_FLAGS.askForApproval, "never");
  assert.equal(INSPECT_FLAGS.askForApprovalScope, "top-level");
  assert.equal(INSPECT_FLAGS.subcommand, "exec");
});

test("classification priority order locks the Step 6G classifier", () => {
  assert.deepEqual([...CLASSIFICATION_PRIORITY], [
    CLASSIFICATIONS.MISSING_PROJECT,
    CLASSIFICATIONS.UNSAFE_PROJECT,
    CLASSIFICATIONS.NOT_INSTALLED,
    CLASSIFICATIONS.TIMEOUT,
    CLASSIFICATIONS.PROJECT_MUTATED,
    CLASSIFICATIONS.AUTH,
    CLASSIFICATIONS.USAGE_LIMIT,
    CLASSIFICATIONS.INTERACTIVE,
    CLASSIFICATIONS.CRASH,
    CLASSIFICATIONS.MARKER_MISSING,
    CLASSIFICATIONS.MARKER_MALFORMED,
    CLASSIFICATIONS.PASS
  ]);
});

test("parseInspectReport accepts a well-formed structured report and rejects malformed ones", () => {
  const ok = parseInspectReport(validReportOutput("demo-project"), "demo-project");
  assert.equal(ok.ok, true);
  assert.equal(ok.report.project, "demo-project");
  assert.equal(ok.report.readonly, true);
  assert.deepEqual([...ok.report.filesInspected], ["PLAN.md", "STATE.json"]);
  assert.ok(ok.report.summary.length > 0);

  for (const [label, output, expectedReason] of [
    ["missing marker", "no marker here", "marker-missing"],
    ["missing project key", `${READONLY_INSPECT_MARKER}\nreadonly=true\nfiles_inspected=PLAN.md\nsummary=ok\n`, "missing-project"],
    ["missing readonly key", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nfiles_inspected=PLAN.md\nsummary=ok\n`, "missing-readonly"],
    ["missing files_inspected", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nsummary=ok\n`, "missing-files_inspected"],
    ["missing summary", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nfiles_inspected=PLAN.md\n`, "missing-summary"],
    ["readonly not true", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=false\nfiles_inspected=PLAN.md\nsummary=ok\n`, "readonly-not-true"],
    ["project mismatch", `${READONLY_INSPECT_MARKER}\nproject=other\nreadonly=true\nfiles_inspected=PLAN.md\nsummary=ok\n`, "project-mismatch"],
    ["empty files_inspected", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nfiles_inspected=,,\nsummary=ok\n`, "files-inspected-empty"],
    ["unsafe file name", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nfiles_inspected=PLAN.md,$(rm)\nsummary=ok\n`, "files-inspected-unsafe"],
    ["traversal file name", `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nfiles_inspected=PLAN.md,../escape\nsummary=ok\n`, "files-inspected-traversal"]
  ]) {
    const parsed = parseInspectReport(output, "demo-project");
    assert.equal(parsed.ok, false, `expected failure for ${label}`);
    assert.equal(parsed.reason, expectedReason, `expected reason ${expectedReason} for ${label}, got ${parsed.reason}`);
  }
});

test("Step 6G request rejects unsupported / user-supplied executable, argv, shell, command, prompt, autoApproval keys", () => {
  const context = makeContext();
  try {
    for (const evil of ["executable", "argv", "shell", "shellCommand", "command", "prompt", "autoApproval", "cwd"]) {
      assert.throws(
        () => runCodexReadonlyInspect({ ...baseRequest(context), [evil]: "/bin/sh -c rm" }),
        (error) => code(error, "INVALID_READONLY_INSPECT_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G request rejects non-codex adapters and missing explicit permit", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["claude-code", "opencode", "fixture-agent", "made-up"]) {
      assert.throws(
        () => runCodexReadonlyInspect(baseRequest(context, { adapterId })),
        (error) => code(error, "READONLY_INSPECT_ADAPTER_NOT_ALLOWED")
      );
    }
    assert.throws(
      () => runCodexReadonlyInspect(baseRequest(context, { explicitReadonlyInspectPermit: false })),
      (error) => code(error, "READONLY_INSPECT_PERMIT_REQUIRED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G uses shell:false, hardcoded executable, fixed argv built from project id, closed stdin, and reduced env", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: validReportOutput(context.projectId), stderr: "" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0];
    assert.equal(call.executable, "codex");
    assert.equal(call.shell, false);
    assert.equal(call.input, "");
    assert.deepEqual(call.args, [...buildInspectArgv(context.projectId)]);
    assert.deepEqual(Object.keys(call.env).sort(), ["LANG", "PATH"]);
    assert.equal(call.env.LANG, "C.UTF-8");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G missing project (registry path that does not exist) classifies as STEP_6G_BLOCKED_MISSING_PROJECT", () => {
  const context = makeContext();
  try {
    fs.rmSync(context.projectPath, { recursive: true, force: true });
    const spawn = fakeSpawn(() => { throw new Error("must not spawn missing project"); });
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MISSING_PROJECT);
    assert.equal(report.step6hSafeToDesign, false);
    assert.equal(spawn.calls.length, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G unsafe / traversal project path classifies as STEP_6G_BLOCKED_UNSAFE_PROJECT and never spawns", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => { throw new Error("must not spawn unsafe project"); });
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn, projectPath: context.directory }));
    assert.equal(report.classification, CLASSIFICATIONS.UNSAFE_PROJECT);
    assert.equal(report.step6hSafeToDesign, false);
    assert.equal(spawn.calls.length, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G missing codex on PATH classifies as STEP_6G_BLOCKED_CODEX_NOT_INSTALLED", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("not found"), { code: "ENOENT" }) }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.NOT_INSTALLED);
    assert.equal(report.step6hSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G timeout classifies as STEP_6G_BLOCKED_CODEX_TIMEOUT", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({
      status: null, signal: "SIGTERM", stdout: "", stderr: "",
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.TIMEOUT);
    assert.equal(report.timedOut, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G non-zero exit without other signal classifies as STEP_6G_BLOCKED_CODEX_CRASH", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 7, stdout: "", stderr: "codex crashed\n" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.CRASH);
    assert.equal(report.exitCode, 7);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G auth-required text classifies as STEP_6G_BLOCKED_CODEX_AUTH", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 1, stdout: "", stderr: "Not authenticated. Please sign in by running `codex login`.\n" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.AUTH);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G usage-limit text classifies as STEP_6G_BLOCKED_CODEX_USAGE_LIMIT", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 1, stdout: "", stderr: "ERROR: You've hit your usage limit. try again at Jun 30th, 2026 2:12 PM.\n" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.USAGE_LIMIT);
    assert.equal(report.usageLimitDetected, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G zero-exit but no marker classifies as STEP_6G_BLOCKED_MARKER_MISSING", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "the fixture looks fine\n", stderr: "" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MISSING);
    assert.equal(report.markerInOutput, false);
    assert.equal(report.reportValid, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G zero-exit + marker but malformed report (e.g. wrong project, readonly=false) classifies as STEP_6G_BLOCKED_MARKER_MALFORMED", () => {
  const context = makeContext();
  try {
    const malformed = [
      `${READONLY_INSPECT_MARKER}`,
      `project=wrong-project`,
      `readonly=true`,
      `files_inspected=PLAN.md`,
      `summary=mismatched project id`
    ].join("\n");
    const spawn = fakeSpawn(() => ({ status: 0, stdout: malformed, stderr: "" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MALFORMED);
    assert.equal(report.markerInOutput, true);
    assert.equal(report.reportValid, false);
    assert.equal(report.reportFailureReason, "project-mismatch");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G mutation outranks usage-limit, auth, marker validation, and exit-nonzero", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "PLAN.md"), "# Mutated by codex\n");
      return { status: 0, stdout: validReportOutput(context.projectId), stderr: "" };
    });
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.PROJECT_MUTATED);
    assert.equal(report.projectMutated, true);
    assert.ok(report.mutatedFiles.includes("PLAN.md"));
    assert.equal(report.step6hSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G timeout still wins over present-but-malformed marker text", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({
      status: null, signal: "SIGTERM",
      stdout: `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nfiles_inspected=PLAN.md\nsummary=incomplete\n`,
      stderr: "",
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.TIMEOUT);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G PASS path: zero exit + marker + valid structured report + no mutation", () => {
  const context = makeContext();
  try {
    const before = snapshot(context.projectPath);
    const spawn = fakeSpawn(() => ({
      status: 0,
      stdout: validReportOutput(context.projectId, ["PLAN.md", "STATE.json", "BUILDING_REFERENCE.md"], "Fixture has plan, state, and reference docs."),
      stderr: ""
    }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.exitCode, 0);
    assert.equal(report.markerCaptured, true);
    assert.equal(report.markerInOutput, true);
    assert.equal(report.reportValid, true);
    assert.equal(report.report.project, context.projectId);
    assert.equal(report.report.readonly, true);
    assert.deepEqual([...report.report.filesInspected], ["PLAN.md", "STATE.json", "BUILDING_REFERENCE.md"]);
    assert.match(report.report.summary, /plan, state, and reference docs/u);
    assert.equal(report.projectMutated, false);
    assert.deepEqual([...report.mutatedFiles], []);
    assert.equal(report.step6hSafeToDesign, true);
    assert.equal(report.manualAction, null);
    assert.deepEqual(snapshot(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G captures stdout, stderr, exit code, argv, executable, timestamps, timeout, error code, and invocation metadata", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: validReportOutput(context.projectId), stderr: "info\n" }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn, timeoutMs: 30_000 }));
    assert.equal(report.adapter, "codex");
    assert.equal(report.executable, "codex");
    assert.deepEqual([...report.argv], [...buildInspectArgv(context.projectId)]);
    assert.equal(report.invocation.shell, false);
    assert.equal(report.invocation.sandbox, "read-only");
    assert.equal(report.invocation.sandboxScope, "top-level");
    assert.equal(report.invocation.askForApproval, "never");
    assert.equal(report.invocation.askForApprovalScope, "top-level");
    assert.equal(report.invocation.subcommand, "exec");
    assert.equal(report.invocation.dangerousBypass, false);
    assert.equal(report.invocation.stdinPolicy, "closed-empty");
    assert.equal(report.invocation.envPolicy, "sandbox-safe (LANG, PATH)");
    assert.equal(report.invocation.autoApproval, false);
    assert.ok(typeof report.startedAt === "string");
    assert.ok(typeof report.finishedAt === "string");
    assert.equal(report.timeoutMs, 30_000);
    assert.equal(typeof report.exitCode, "number");
    assert.equal(report.timedOut, false);
    assert.equal(report.project.id, context.projectId);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6G redacts api-key / token / github-shaped secrets from captured stdout/stderr/summary", () => {
  const context = makeContext();
  try {
    const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
    const ghSecret = "ghp_ABCDEFGHIJ1234567890zzzz";
    const spawn = fakeSpawn(() => ({
      status: 0,
      stdout: `${validReportOutput(context.projectId)}\ntoken=${secret}\n`,
      stderr: `auth=${ghSecret}\n`
    }));
    const report = runCodexReadonlyInspect(baseRequest(context, { spawn }));
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(ghSecret), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-codex-readonly-inspect returns non-zero when codex is unavailable (no PATH)", () => {
  const context = makeContext("example-project");
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = withEmptyPath(emptyPathDir, () => runCli(["agent-codex-readonly-inspect", "--config", configPath, "--project", "example-project"]));
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapter, "codex");
    assert.equal(parsed.mode, "readonly-exec-inspect");
    assert.equal(parsed.invocation.shell, false);
    assert.equal(parsed.invocation.sandbox, "read-only");
    assert.equal(parsed.invocation.askForApproval, "never");
    assert.equal(parsed.invocation.dangerousBypass, false);
    assert.equal(parsed.project.id, "example-project");
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.notEqual(exitCode, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-codex-readonly-inspect rejects non-codex adapter selections", () => {
  const context = makeContext("example-project");
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      assert.throws(
        () => runCli(["agent-codex-readonly-inspect", "--config", configPath, "--project", "example-project", "--adapter", "claude-code"]),
        (error) => code(error, "INVALID_ARGUMENT")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI agent-codex-readonly-inspect process exits non-zero when codex is missing", () => {
  const context = makeContext("example-project");
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    const env = { ...process.env, PATH: emptyPathDir, Path: emptyPathDir, path: emptyPathDir };
    const result = spawnCliSync(process.execPath, [CLI_PATH, "agent-codex-readonly-inspect", "--config", configPath, "--project", "example-project"], {
      encoding: "utf8",
      shell: false,
      env,
      timeout: 60_000
    });
    assert.equal(result.error, undefined);
    assert.equal(typeof result.status, "number");
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.invocation.sandbox, "read-only");
    assert.equal(parsed.invocation.askForApproval, "never");
    assert.equal(parsed.invocation.shell, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
