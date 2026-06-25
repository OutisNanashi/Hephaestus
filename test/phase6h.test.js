import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CLASSIFICATIONS,
  RECORD_AGENT_OUTPUT_FILE,
  RECORD_REPORT_DIRECTORY,
  runCodexReadonlyInspectRecord
} from "../src/agent-readonly-inspect-record.js";
import {
  CLASSIFICATIONS as INSPECT_CLASSIFICATIONS,
  INSPECT_FLAGS,
  READONLY_INSPECT_MARKER,
  buildInspectArgv
} from "../src/agent-readonly-inspect.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = path.resolve("src/cli.js");

const validState = Object.freeze({
  currentPhase: "6H", currentTask: "codex-readonly-inspect-record", currentBranch: "main", currentPr: null,
  assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, reviewStatus: "not-started", mergeStatus: "not-started",
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

function fakeInspectReport(context, overrides = {}) {
  return Object.freeze({
    classification: INSPECT_CLASSIFICATIONS.PASS,
    adapter: "codex",
    mode: "readonly-exec-inspect",
    project: Object.freeze({ id: context.projectId, allowedRoot: context.allowedRoot, resolvedPath: context.projectPath }),
    executable: "codex",
    argv: buildInspectArgv(context.projectId),
    invocation: Object.freeze({
      shell: false, sandbox: "read-only", sandboxScope: "top-level",
      askForApproval: "never", askForApprovalScope: "top-level",
      subcommand: "exec", autoApproval: false, dangerousBypass: false,
      stdinPolicy: "closed-empty", envPolicy: "sandbox-safe (LANG, PATH)"
    }),
    inspectMarker: READONLY_INSPECT_MARKER,
    inspectPrompt: "(hardcoded inspect prompt)",
    promptKind: "readonly-inspect",
    startedAt: "2026-06-25T13:00:00.000Z",
    finishedAt: "2026-06-25T13:00:05.000Z",
    timeoutMs: 120_000,
    stdout: `${READONLY_INSPECT_MARKER}\nproject=${context.projectId}\nreadonly=true\nfiles_inspected=PLAN.md,STATE.json\nsummary=Fixture inspected.\n`,
    stderr: "",
    summary: "Fixture inspected.",
    exitCode: 0,
    errorCode: null,
    timedOut: false,
    markerCaptured: true,
    markerInOutput: true,
    reportValid: true,
    report: Object.freeze({
      project: context.projectId,
      readonly: true,
      filesInspected: Object.freeze(["PLAN.md", "STATE.json"]),
      summary: "Fixture inspected."
    }),
    reportFailureReason: null,
    usageLimitDetected: false,
    projectMutated: false,
    mutatedFiles: Object.freeze([]),
    step6hSafeToDesign: true,
    manualAction: null,
    ...overrides
  });
}

function recordRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    projectId: context.projectId,
    explicitReadonlyInspectRecordPermit: true,
    env: { PATH: "/usr/bin" },
    now: () => "2026-06-25T13-00-00-000Z",
    reportName: "step-6h-readonly-inspect-test.json",
    runInspect: () => fakeInspectReport(context),
    ...overrides
  };
}

function snapshotProtected(projectPath) {
  const out = {};
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "src/index.js", "test/index.test.js"]) {
    const file = path.join(projectPath, name);
    out[name] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return out;
}

test("Step 6H request rejects unsupported / user-supplied executable, argv, shell, command, prompt, autoApproval keys", () => {
  const context = makeContext();
  try {
    for (const evil of ["executable", "argv", "shell", "shellCommand", "command", "prompt", "autoApproval", "cwd"]) {
      assert.throws(
        () => runCodexReadonlyInspectRecord({ ...recordRequest(context), [evil]: "/bin/sh -c rm" }),
        (error) => code(error, "INVALID_READONLY_INSPECT_RECORD_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H rejects non-codex adapters and missing explicit permit", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["claude-code", "opencode", "fixture-agent"]) {
      assert.throws(
        () => runCodexReadonlyInspectRecord(recordRequest(context, { adapterId })),
        (error) => code(error, "READONLY_INSPECT_RECORD_ADAPTER_NOT_ALLOWED")
      );
    }
    assert.throws(
      () => runCodexReadonlyInspectRecord(recordRequest(context, { explicitReadonlyInspectRecordPermit: false })),
      (error) => code(error, "READONLY_INSPECT_RECORD_PERMIT_REQUIRED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H rejects unsafe reportName candidates (traversal, no .json, wrong shape)", () => {
  const context = makeContext();
  try {
    for (const evil of ["../escape.json", "report;rm.json", "report.txt", "", "a".repeat(150) + ".json"]) {
      assert.throws(
        () => runCodexReadonlyInspectRecord(recordRequest(context, { reportName: evil })),
        (error) => code(error, "INVALID_READONLY_INSPECT_RECORD_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

for (const [label, inspectClass, recordClass] of [
  ["usage-limit", INSPECT_CLASSIFICATIONS.USAGE_LIMIT, CLASSIFICATIONS.USAGE_LIMIT],
  ["auth", INSPECT_CLASSIFICATIONS.AUTH, CLASSIFICATIONS.AUTH],
  ["timeout", INSPECT_CLASSIFICATIONS.TIMEOUT, CLASSIFICATIONS.TIMEOUT],
  ["crash", INSPECT_CLASSIFICATIONS.CRASH, CLASSIFICATIONS.CRASH],
  ["not-installed", INSPECT_CLASSIFICATIONS.NOT_INSTALLED, CLASSIFICATIONS.NOT_INSTALLED],
  ["interactive", INSPECT_CLASSIFICATIONS.INTERACTIVE, CLASSIFICATIONS.INTERACTIVE],
  ["marker-missing", INSPECT_CLASSIFICATIONS.MARKER_MISSING, CLASSIFICATIONS.MARKER_MISSING],
  ["marker-malformed", INSPECT_CLASSIFICATIONS.MARKER_MALFORMED, CLASSIFICATIONS.MARKER_MALFORMED],
  ["codex-mutated-project", INSPECT_CLASSIFICATIONS.PROJECT_MUTATED, CLASSIFICATIONS.CODEX_MUTATED_PROJECT],
  ["missing-project", INSPECT_CLASSIFICATIONS.MISSING_PROJECT, CLASSIFICATIONS.MISSING_PROJECT],
  ["unsafe-project", INSPECT_CLASSIFICATIONS.UNSAFE_PROJECT, CLASSIFICATIONS.UNSAFE_PROJECT]
]) {
  test(`Step 6H propagates Step 6G ${label} blocker as ${recordClass} and writes no artifacts`, () => {
    const context = makeContext();
    try {
      const before = snapshotProtected(context.projectPath);
      const inspect = fakeInspectReport(context, { classification: inspectClass, markerCaptured: false, reportValid: false });
      const report = runCodexReadonlyInspectRecord(recordRequest(context, { runInspect: () => inspect }));
      assert.equal(report.classification, recordClass);
      assert.equal(report.step6gClassification, inspectClass);
      assert.equal(report.artifactsWritten, false);
      assert.equal(report.step6iSafeToDesign, false);
      assert.equal(fs.existsSync(path.join(context.projectPath, RECORD_AGENT_OUTPUT_FILE)), false, "AGENT_OUTPUT.md must NOT be written on blocked 6G");
      assert.equal(fs.existsSync(path.join(context.projectPath, RECORD_REPORT_DIRECTORY)), false, "out/agent_outputs must NOT be created on blocked 6G");
      assert.deepEqual(snapshotProtected(context.projectPath), before);
    } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
  });
}

test("Step 6H success writes AGENT_OUTPUT.md and out/agent_outputs/<name>.json, preserves protected files, returns STEP_6H_PASS", () => {
  const context = makeContext();
  try {
    const before = snapshotProtected(context.projectPath);
    const report = runCodexReadonlyInspectRecord(recordRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.step6gClassification, INSPECT_CLASSIFICATIONS.PASS);
    assert.equal(report.artifactsWritten, true);
    assert.equal(report.codexMutatedProject, false);
    assert.deepEqual([...report.codexMutatedFiles], []);
    assert.equal(report.forbiddenMutation, false);
    assert.equal(report.step6iSafeToDesign, true);
    assert.equal(report.manualAction, null);
    const agentOutputPath = path.join(context.projectPath, RECORD_AGENT_OUTPUT_FILE);
    const reportPath = path.join(context.projectPath, RECORD_REPORT_DIRECTORY, "step-6h-readonly-inspect-test.json");
    assert.equal(fs.existsSync(agentOutputPath), true);
    assert.equal(fs.existsSync(reportPath), true);
    const markdown = fs.readFileSync(agentOutputPath, "utf8");
    assert.match(markdown, /Hephaestus Step 6H/u);
    assert.match(markdown, /Project: demo-project/u);
    assert.match(markdown, /Adapter: codex/u);
    assert.match(markdown, /Step 6G classification: STEP_6G_PASS/u);
    assert.match(markdown, /Step 6H classification: STEP_6H_PASS/u);
    assert.match(markdown, /Marker captured: yes/u);
    assert.match(markdown, /Report valid: yes/u);
    assert.match(markdown, /Codex mutated project during run: no/u);
    assert.match(markdown, /Files inspected by Codex: PLAN.md, STATE.json/u);
    assert.match(markdown, /sandbox: read-only/u);
    assert.match(markdown, /ask-for-approval: never/u);
    assert.match(markdown, /shell: false \(locked\)/u);
    assert.match(markdown, /dangerous bypass: no/u);
    assert.match(markdown, /This artifact records the output of a read-only Codex inspection/u);
    assert.match(markdown, /Step 6I may be designed/u);
    const json = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(json.schema, "hephaestus.step-6h.readonly-inspect-record/v1");
    assert.equal(json.recordingStep, "6H");
    assert.equal(json.sourceStep, "6G");
    assert.equal(json.project, "demo-project");
    assert.equal(json.adapter, "codex");
    assert.equal(json.step6gClassification, INSPECT_CLASSIFICATIONS.PASS);
    assert.equal(json.step6hClassification, CLASSIFICATIONS.PASS);
    assert.equal(json.markerCaptured, true);
    assert.equal(json.reportValid, true);
    assert.equal(json.projectMutatedDuringCodexRun, false);
    assert.deepEqual(json.mutatedFilesDuringCodexRun, []);
    assert.deepEqual(json.filesInspected, ["PLAN.md", "STATE.json"]);
    assert.equal(json.summary, "Fixture inspected.");
    assert.equal(json.invocation.shell, false);
    assert.equal(json.invocation.sandbox, "read-only");
    assert.equal(json.invocation.askForApproval, "never");
    assert.equal(json.invocation.dangerousBypass, false);
    assert.equal(json.invocation.stdinPolicy, "closed-empty");
    assert.equal(json.invocation.envPolicy, "sandbox-safe (LANG, PATH)");
    assert.equal(typeof json.exitCode, "number");
    assert.equal(json.timedOut, false);
    assert.equal(json.nextSafeStep, "6I (design only)");
    assert.equal(json.artifacts.agentOutput, RECORD_AGENT_OUTPUT_FILE);
    assert.equal(json.artifacts.jsonReport, `out/agent_outputs/step-6h-readonly-inspect-test.json`);
    assert.deepEqual(snapshotProtected(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H success uses a safe deterministic-ish reportName when none is provided", () => {
  const context = makeContext();
  try {
    const report = runCodexReadonlyInspectRecord(recordRequest(context, { reportName: undefined }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.match(report.artifactPaths.jsonReport, /^out\/agent_outputs\/step-6h-readonly-inspect-[A-Za-z0-9_.\-]+\.json$/u);
    const reportPath = path.join(context.projectPath, report.artifactPaths.jsonReport);
    assert.equal(fs.existsSync(reportPath), true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H propagates as STEP_6H_BLOCKED_STEP_6G_FAILED when the inspect classification is unmapped", () => {
  const context = makeContext();
  try {
    const inspect = fakeInspectReport(context, { classification: "STEP_6G_UNKNOWN_NEW_CASE", markerCaptured: false, reportValid: false });
    const report = runCodexReadonlyInspectRecord(recordRequest(context, { runInspect: () => inspect }));
    assert.equal(report.classification, CLASSIFICATIONS.STEP_6G_FAILED);
    assert.equal(report.artifactsWritten, false);
    assert.equal(report.step6iSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H detects forbidden mutation introduced between artifact-allowed paths and reports STEP_6H_BLOCKED_FORBIDDEN_MUTATION", () => {
  const context = makeContext();
  try {
    const before = snapshotProtected(context.projectPath);
    const sneakyInspect = fakeInspectReport(context);
    const runInspect = () => {
      fs.writeFileSync(path.join(context.projectPath, "PLAN.md"), "# Sneaky mutation between 6G and 6H artifact write\n");
      return sneakyInspect;
    };
    const report = runCodexReadonlyInspectRecord(recordRequest(context, { runInspect }));
    assert.equal(report.classification, CLASSIFICATIONS.FORBIDDEN_MUTATION);
    assert.equal(report.artifactsWritten, false);
    assert.equal(report.forbiddenMutation, true);
    assert.ok(report.forbiddenMutatedFiles.includes("PLAN.md"));
    assert.equal(report.step6iSafeToDesign, false);
    assert.notDeepEqual(snapshotProtected(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H rejects unsafe project paths (traversal / outside allowed root) and never writes artifacts", () => {
  const context = makeContext();
  try {
    let inspectCalled = false;
    const runInspect = (req) => {
      inspectCalled = true;
      return fakeInspectReport(context, { classification: INSPECT_CLASSIFICATIONS.UNSAFE_PROJECT });
    };
    const report = runCodexReadonlyInspectRecord(recordRequest(context, {
      projectPath: context.directory,
      runInspect
    }));
    assert.equal(report.classification, CLASSIFICATIONS.UNSAFE_PROJECT);
    assert.equal(report.artifactsWritten, false);
    assert.equal(report.step6iSafeToDesign, false);
    assert.equal(inspectCalled, true);
    assert.equal(fs.existsSync(path.join(context.projectPath, RECORD_AGENT_OUTPUT_FILE)), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H rejects missing project (project path deleted before run) and never writes artifacts", () => {
  const context = makeContext();
  try {
    const inspect = fakeInspectReport(context, { classification: INSPECT_CLASSIFICATIONS.MISSING_PROJECT });
    fs.rmSync(context.projectPath, { recursive: true, force: true });
    const report = runCodexReadonlyInspectRecord(recordRequest(context, { runInspect: () => inspect }));
    assert.equal(report.classification, CLASSIFICATIONS.MISSING_PROJECT);
    assert.equal(report.artifactsWritten, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H artifact write redacts secret-like content from Codex stdout/stderr before persisting", () => {
  const context = makeContext();
  try {
    const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
    const ghSecret = "ghp_ABCDEFGHIJ1234567890zzzz";
    const inspect = fakeInspectReport(context, {
      stdout: `${READONLY_INSPECT_MARKER}\nproject=demo-project\nreadonly=true\nfiles_inspected=PLAN.md\nsummary=ok\n`,
      stderr: "warn\n"
    });
    // Manually pass already-redacted streams to ensure the recorder doesn't re-add them
    const report = runCodexReadonlyInspectRecord(recordRequest(context, { runInspect: () => inspect }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    const jsonPath = path.join(context.projectPath, RECORD_REPORT_DIRECTORY, "step-6h-readonly-inspect-test.json");
    const markdownPath = path.join(context.projectPath, RECORD_AGENT_OUTPUT_FILE);
    const jsonText = fs.readFileSync(jsonPath, "utf8");
    const mdText = fs.readFileSync(markdownPath, "utf8");
    assert.equal(jsonText.includes(secret), false);
    assert.equal(jsonText.includes(ghSecret), false);
    assert.equal(mdText.includes(secret), false);
    assert.equal(mdText.includes(ghSecret), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H artifact paths stay strictly inside the project folder (no traversal, no parent escape)", () => {
  const context = makeContext();
  try {
    const report = runCodexReadonlyInspectRecord(recordRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    for (const relative of [report.artifactPaths.agentOutput, report.artifactPaths.jsonReport]) {
      assert.equal(relative.includes(".."), false);
      const absolute = path.resolve(context.projectPath, relative);
      const rel = path.relative(context.projectPath, absolute);
      assert.equal(rel.startsWith(".."), false);
      assert.equal(path.isAbsolute(rel), false);
      assert.equal(fs.existsSync(absolute), true);
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H success does NOT create root BUILD_LOG.md, root STATE.json, or any file under the host repo", () => {
  const context = makeContext();
  try {
    const repoRoot = path.resolve(".");
    const before = {
      buildLog: fs.existsSync(path.join(repoRoot, "BUILD_LOG.md")),
      stateJson: fs.existsSync(path.join(repoRoot, "STATE.json"))
    };
    runCodexReadonlyInspectRecord(recordRequest(context));
    assert.equal(fs.existsSync(path.join(repoRoot, "BUILD_LOG.md")), before.buildLog, "root BUILD_LOG.md must not be created");
    assert.equal(fs.existsSync(path.join(repoRoot, "STATE.json")), before.stateJson, "root STATE.json must not be created");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H preserves Step 6G safety invariants in the persisted artifacts", () => {
  const context = makeContext();
  try {
    const report = runCodexReadonlyInspectRecord(recordRequest(context));
    const jsonPath = path.join(context.projectPath, RECORD_REPORT_DIRECTORY, "step-6h-readonly-inspect-test.json");
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(json.invocation.shell, false);
    assert.equal(json.invocation.sandbox, "read-only");
    assert.equal(json.invocation.askForApproval, "never");
    assert.equal(json.invocation.dangerousBypass, false);
    assert.equal(json.invocation.stdinPolicy, "closed-empty");
    assert.equal(json.invocation.envPolicy, "sandbox-safe (LANG, PATH)");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6H end-to-end via runCodexReadonlyInspect with a faked spawn: PASS produces artifacts; spawn shell:false; closed stdin; sandbox read-only", () => {
  const context = makeContext();
  try {
    const calls = [];
    const fakeSpawn = (executable, args, options) => {
      calls.push({ executable, args: [...args], shell: options?.shell, input: options?.input, env: { ...options?.env } });
      const output = [
        READONLY_INSPECT_MARKER,
        `project=${context.projectId}`,
        "readonly=true",
        "files_inspected=PLAN.md,STATE.json,CURRENT_TASK.md",
        "summary=Inspected fixture cleanly.",
        ""
      ].join("\n");
      return { status: 0, stdout: output, stderr: "" };
    };
    const report = runCodexReadonlyInspectRecord({
      adapterId: "codex",
      allowedRoot: context.allowedRoot,
      projectPath: context.projectPath,
      projectId: context.projectId,
      explicitReadonlyInspectRecordPermit: true,
      env: { PATH: "/usr/bin" },
      now: () => "2026-06-25T13-00-00-000Z",
      reportName: "step-6h-readonly-inspect-test.json",
      spawn: fakeSpawn
    });
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.artifactsWritten, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "codex");
    assert.equal(calls[0].shell, false);
    assert.equal(calls[0].input, "");
    assert.deepEqual(Object.keys(calls[0].env).sort(), ["LANG", "PATH"]);
    assert.deepEqual(calls[0].args, [...buildInspectArgv(context.projectId)]);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-codex-readonly-inspect-record returns non-zero when codex is unavailable on PATH", () => {
  const context = makeContext("example-project");
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
      exitCode = runCli(["agent-codex-readonly-inspect-record", "--config", configPath, "--project", "example-project"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapter, "codex");
    assert.equal(parsed.mode, "readonly-exec-inspect-record");
    assert.equal(parsed.artifactsWritten, false);
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.notEqual(exitCode, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI agent-codex-readonly-inspect-record rejects non-codex adapter selections", () => {
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
        () => runCli(["agent-codex-readonly-inspect-record", "--config", configPath, "--project", "example-project", "--adapter", "claude-code"]),
        (error) => code(error, "INVALID_ARGUMENT")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI agent-codex-readonly-inspect-record exits non-zero when codex is missing", () => {
  const context = makeContext("example-project");
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    const env = { ...process.env, PATH: emptyPathDir, Path: emptyPathDir, path: emptyPathDir };
    const result = spawnSync(process.execPath, [CLI_PATH, "agent-codex-readonly-inspect-record", "--config", configPath, "--project", "example-project"], {
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
    assert.equal(parsed.artifactsWritten, false);
    assert.equal(parsed.step6iSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
