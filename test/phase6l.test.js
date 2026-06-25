import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CLASSIFICATIONS,
  STEP_6L_AGENT_OUTPUT_RELATIVE,
  STEP_6L_DECISION_RELATIVE,
  STEP_6L_FLAGS,
  STEP_6L_MARKER,
  STEP_6L_PROMPT_RELATIVE,
  STEP_6L_REPORT_DIRECTORY_RELATIVE,
  buildMockedBrainDecision,
  buildStep6lArgv,
  buildStep6lPrompt,
  parseStep6lReport,
  runActivationMockedBrainReadonlyHandoff,
  serializeMockedBrainDecision,
  validateMockedBrainDecision
} from "../src/brain-readonly-handoff.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = path.resolve("src/cli.js");

const validState = Object.freeze({
  currentPhase: "6L", currentTask: "mocked-brain-readonly-handoff", currentBranch: "main", currentPr: null,
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
    "PLAN.md": "# Plan\n",
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
      executable, args: [...args], shell: options?.shell, env: { ...options?.env },
      cwd: options?.cwd, timeout: options?.timeout, input: options?.input
    }));
    return behavior(executable, args, options, calls);
  };
  fn.calls = calls;
  return fn;
}

function validReportOutput(projectId, files = ["PLAN.md", "STATE.json"], summary = "Fixture inspected.") {
  return [
    "Some Codex preamble first.",
    STEP_6L_MARKER,
    `project=${projectId}`,
    "readonly=true",
    "decision_type=READONLY_AGENT_PROMPT",
    `prompt_source=${STEP_6L_PROMPT_RELATIVE}`,
    `files_inspected=${files.join(",")}`,
    `summary=${summary}`,
    ""
  ].join("\n");
}

function baseRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    projectId: context.projectId,
    explicitMockedBrainHandoffPermit: true,
    env: { PATH: "/usr/bin" },
    now: () => "2026-06-25T19-00-00-000Z",
    reportName: "step-6l-mocked-brain-readonly-handoff-test.json",
    spawn: fakeSpawn(() => ({ status: 0, stdout: validReportOutput(context.projectId), stderr: "" })),
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

test("mocked brain decision template contains all required fields and forbidden actions", () => {
  const decision = buildMockedBrainDecision("demo-project");
  assert.equal(decision.schema, "hephaestus.step-6l.mocked-brain-decision/v1");
  assert.equal(decision.project, "demo-project");
  assert.equal(decision.phase, "Activation Step 6L");
  assert.equal(decision.decisionType, "READONLY_AGENT_PROMPT");
  assert.equal(decision.adapter, "codex");
  assert.equal(decision.mode, "read-only");
  assert.equal(decision.allowedAction, "INSPECT_FIXTURE_ONLY");
  assert.equal(decision.requiredMarker, STEP_6L_MARKER);
  assert.equal(decision.promptSource, STEP_6L_PROMPT_RELATIVE);
  for (const required of ["write_files","delete_files","rename_files","move_files","run_mutating_commands","network_access","request_approval","workspace_write","autonomous_execution","merge","deploy"]) {
    assert.ok(decision.forbiddenActions.includes(required), `forbiddenActions must include ${required}`);
  }
  for (const required of ["project","readonly","decision_type","prompt_source","files_inspected","summary"]) {
    assert.ok(decision.expectedReportKeys.includes(required), `expectedReportKeys must include ${required}`);
  }
  assert.equal(decision.nextSafeStep, "6M (design only)");
});

test("validateMockedBrainDecision rejects every malformed variant", () => {
  const good = buildMockedBrainDecision("demo-project");
  assert.equal(validateMockedBrainDecision(good, "demo-project").ok, true);

  const mutators = [
    ["null", null, "not-an-object"],
    ["array", [], "not-an-object"],
    ["wrong schema", { ...good, schema: "other" }, "schema-mismatch"],
    ["wrong project", { ...good, project: "other" }, "project-mismatch"],
    ["wrong phase", { ...good, phase: "Other Phase" }, "phase-mismatch"],
    ["wrong decisionType", { ...good, decisionType: "WRITE" }, "decision-type-mismatch"],
    ["wrong adapter", { ...good, adapter: "claude-code" }, "adapter-mismatch"],
    ["wrong mode", { ...good, mode: "write" }, "mode-mismatch"],
    ["wrong allowedAction", { ...good, allowedAction: "BUILD_PROJECT" }, "allowed-action-mismatch"],
    ["forbiddenActions not array", { ...good, forbiddenActions: "no" }, "forbidden-actions-not-array"],
    ["missing forbidden write_files", { ...good, forbiddenActions: good.forbiddenActions.filter((a) => a !== "write_files") }, "missing-forbidden-write_files"],
    ["unknown forbidden action", { ...good, forbiddenActions: [...good.forbiddenActions, "frobnicate"] }, "unknown-forbidden-frobnicate"],
    ["wrong requiredMarker", { ...good, requiredMarker: "other-marker" }, "required-marker-mismatch"],
    ["wrong promptSource", { ...good, promptSource: "out/prompts/other.md" }, "prompt-source-mismatch"],
    ["expectedReportKeys not array", { ...good, expectedReportKeys: "no" }, "expected-report-keys-not-array"],
    ["missing expected key", { ...good, expectedReportKeys: good.expectedReportKeys.filter((k) => k !== "summary") }, "missing-expected-key-summary"],
    ["wrong nextSafeStep", { ...good, nextSafeStep: "7A" }, "next-safe-step-mismatch"]
  ];
  for (const [label, candidate, expectedReason] of mutators) {
    const result = validateMockedBrainDecision(candidate, "demo-project");
    assert.equal(result.ok, false, `expected failure for ${label}`);
    assert.equal(result.reason, expectedReason, `expected reason ${expectedReason} for ${label}`);
  }

  for (const forbidden of ["command","shell","executable","argv","cwd","prompt","promptFile","autoApproval","workspaceWrite","merge","deploy","secrets","env"]) {
    const result = validateMockedBrainDecision({ ...good, [forbidden]: "danger" }, "demo-project");
    assert.equal(result.ok, false, `forbidden field ${forbidden} must be rejected`);
    assert.equal(result.reason, `forbidden-field-${forbidden}`);
  }
});

test("Step 6L prompt template contains marker, forbids mutation, identifies decision_type and prompt_source", () => {
  const prompt = buildStep6lPrompt("demo-project");
  assert.ok(prompt.includes(STEP_6L_MARKER));
  assert.match(prompt, /Project: demo-project/u);
  assert.match(prompt, /Decision type: READONLY_AGENT_PROMPT/u);
  assert.match(prompt, /Do not modify, create, delete, rename, or move any file/u);
  assert.match(prompt, /Do not access the network/u);
  assert.match(prompt, /Do not request approvals/u);
  assert.match(prompt, /This prompt was generated by a controlled mocked brain decision/u);
  assert.match(prompt, /NOT a real GPT decision/u);
  assert.ok(prompt.includes(`prompt_source=${STEP_6L_PROMPT_RELATIVE}`));
});

test("buildStep6lArgv places top-level flags before exec and ends with the prompt; no forbidden tokens", () => {
  const prompt = buildStep6lPrompt("demo-project");
  const argv = buildStep6lArgv(prompt);
  assert.deepEqual(argv.slice(0, 2), ["--sandbox", "read-only"]);
  assert.deepEqual(argv.slice(2, 4), ["--ask-for-approval", "never"]);
  assert.equal(argv[4], "exec");
  assert.equal(argv[5], prompt);
  for (const forbidden of ["--dangerously-bypass-approvals-and-sandbox","--dangerously-bypass-hook-trust","--add-dir","--search","-c","workspace-write","danger-full-access"]) {
    assert.equal(argv.includes(forbidden), false);
  }
});

test("STEP_6L_FLAGS exposes shell:false, sandbox:read-only top-level, ask-for-approval:never top-level", () => {
  assert.equal(STEP_6L_FLAGS.shell, false);
  assert.equal(STEP_6L_FLAGS.sandbox, "read-only");
  assert.equal(STEP_6L_FLAGS.sandboxScope, "top-level");
  assert.equal(STEP_6L_FLAGS.askForApproval, "never");
  assert.equal(STEP_6L_FLAGS.askForApprovalScope, "top-level");
  assert.equal(STEP_6L_FLAGS.subcommand, "exec");
});

test("parseStep6lReport accepts a well-formed Step 6L report and rejects malformed variants", () => {
  const ok = parseStep6lReport(validReportOutput("demo-project"), { expectedProjectId: "demo-project", expectedPromptSource: STEP_6L_PROMPT_RELATIVE });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.project, "demo-project");
  assert.equal(ok.report.readonly, true);
  assert.equal(ok.report.decisionType, "READONLY_AGENT_PROMPT");
  assert.equal(ok.report.promptSource, STEP_6L_PROMPT_RELATIVE);

  for (const [label, output, expectedReason] of [
    ["missing marker", "no marker here", "marker-missing"],
    ["wrong project", `${STEP_6L_MARKER}\nproject=other\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "project-mismatch"],
    ["wrong decision_type", `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=WRITE\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "decision-type-mismatch"],
    ["wrong prompt_source", `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=out/other.md\nfiles_inspected=PLAN.md\nsummary=ok\n`, "prompt-source-mismatch"],
    ["readonly not true", `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=false\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "readonly-not-true"],
    ["missing decision_type", `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "missing-decision_type"],
    ["empty files", `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=,,,\nsummary=ok\n`, "files-inspected-empty"],
    ["unsafe file", `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md,$(rm)\nsummary=ok\n`, "files-inspected-unsafe"]
  ]) {
    const parsed = parseStep6lReport(output, { expectedProjectId: "demo-project", expectedPromptSource: STEP_6L_PROMPT_RELATIVE });
    assert.equal(parsed.ok, false, `expected failure for ${label}`);
    assert.equal(parsed.reason, expectedReason);
  }
});

test("Step 6L request shape rejects every user-supplied dangerous key", () => {
  const context = makeContext();
  try {
    for (const evil of ["executable","argv","shell","shellCommand","command","prompt","promptFile","instruction","autoApproval","cwd","secrets","merge","deploy","workspaceWrite"]) {
      assert.throws(
        () => runActivationMockedBrainReadonlyHandoff({ ...baseRequest(context), [evil]: "danger" }),
        (error) => code(error, "INVALID_STEP_6L_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L rejects non-codex adapters and missing explicit permit", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["claude-code", "opencode", "fixture-agent"]) {
      assert.throws(
        () => runActivationMockedBrainReadonlyHandoff(baseRequest(context, { adapterId })),
        (error) => code(error, "STEP_6L_ADAPTER_NOT_ALLOWED")
      );
    }
    assert.throws(
      () => runActivationMockedBrainReadonlyHandoff(baseRequest(context, { explicitMockedBrainHandoffPermit: false })),
      (error) => code(error, "STEP_6L_PERMIT_REQUIRED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L PASS: writes brain decision, prompt, hands off to Codex, persists output artifacts, no mutation", () => {
  const context = makeContext();
  try {
    const before = snapshotProtected(context.projectPath);
    const spawn = fakeSpawn(() => ({ status: 0, stdout: validReportOutput(context.projectId, ["PLAN.md", "STATE.json", "BUILDING_REFERENCE.md"], "Fixture inspected cleanly."), stderr: "" }));
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.mockedBrainDecisionWritten, true);
    assert.equal(report.mockedBrainDecisionValid, true);
    assert.equal(report.promptArtifactWritten, true);
    assert.equal(report.promptSourceConfirmed, true);
    assert.equal(report.artifactsWritten, true);
    assert.equal(report.codexMutatedProject, false);
    assert.equal(report.forbiddenMutation, false);
    assert.equal(report.realGptUsed, false);
    assert.equal(report.workspaceWriteEnabled, false);
    assert.equal(report.arbitraryPromptExecutionEnabled, false);
    assert.equal(report.autonomousExecutionEnabled, false);
    assert.equal(report.step6mSafeToDesign, true);

    // Files on disk
    const decisionPath = path.join(context.projectPath, STEP_6L_DECISION_RELATIVE);
    const promptPath = path.join(context.projectPath, STEP_6L_PROMPT_RELATIVE);
    const agentOutPath = path.join(context.projectPath, STEP_6L_AGENT_OUTPUT_RELATIVE);
    const jsonPath = path.join(context.projectPath, STEP_6L_REPORT_DIRECTORY_RELATIVE, "step-6l-mocked-brain-readonly-handoff-test.json");
    for (const p of [decisionPath, promptPath, agentOutPath, jsonPath]) assert.equal(fs.existsSync(p), true);

    // Decision content
    const decisionText = fs.readFileSync(decisionPath, "utf8");
    assert.equal(decisionText, serializeMockedBrainDecision(buildMockedBrainDecision(context.projectId)));
    const decisionHash = createHash("sha256").update(decisionText).digest("hex");
    assert.equal(report.mockedBrainDecisionHash, decisionHash);
    assert.equal(report.mockedBrainDecisionPath, STEP_6L_DECISION_RELATIVE);

    // Prompt content
    const promptText = fs.readFileSync(promptPath, "utf8");
    assert.equal(promptText, buildStep6lPrompt(context.projectId));
    const promptHash = createHash("sha256").update(promptText).digest("hex");
    assert.equal(report.promptArtifactHash, promptHash);

    // Spawn observed the prompt
    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0];
    assert.equal(call.executable, "codex");
    assert.equal(call.shell, false);
    assert.equal(call.input, "");
    assert.deepEqual(Object.keys(call.env).sort(), ["LANG", "PATH"]);
    assert.deepEqual(call.args.slice(0, 5), ["--sandbox","read-only","--ask-for-approval","never","exec"]);
    assert.equal(call.args[5], promptText);

    // Markdown content
    const markdown = fs.readFileSync(agentOutPath, "utf8");
    assert.match(markdown, /Step 6L classification: STEP_6L_PASS/u);
    assert.match(markdown, /Project: demo-project/u);
    assert.match(markdown, /Adapter: codex/u);
    assert.match(markdown, /Mocked brain decision path: out\/brain_decisions\/step-6l-mocked-brain-decision\.json/u);
    assert.match(markdown, new RegExp(`Mocked brain decision SHA-256: ${decisionHash}`, "u"));
    assert.match(markdown, /Mocked brain decision valid: yes/u);
    assert.match(markdown, /Prompt artifact path: out\/prompts\/step-6l-brain-readonly-prompt\.md/u);
    assert.match(markdown, new RegExp(`Prompt artifact SHA-256: ${promptHash}`, "u"));
    assert.match(markdown, /Prompt source confirmed: yes/u);
    assert.match(markdown, /Marker captured: yes/u);
    assert.match(markdown, /Report valid: yes/u);
    assert.match(markdown, /Codex mutated project during run: no/u);
    assert.match(markdown, /Files inspected by Codex: PLAN.md, STATE.json, BUILDING_REFERENCE.md/u);
    assert.match(markdown, /real GPT used: no/u);
    assert.match(markdown, /workspace-write enabled: no/u);
    assert.match(markdown, /Step 6M may be designed/u);
    assert.match(markdown, /mocked-brain read-only Codex handoff/u);

    // JSON content
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(json.schema, "hephaestus.step-6l.mocked-brain-readonly-handoff/v1");
    assert.equal(json.project, "demo-project");
    assert.equal(json.adapter, "codex");
    assert.equal(json.classification, CLASSIFICATIONS.PASS);
    assert.equal(json.mockedBrainDecisionPath, STEP_6L_DECISION_RELATIVE);
    assert.equal(json.mockedBrainDecisionHash, decisionHash);
    assert.equal(json.mockedBrainDecisionValid, true);
    assert.equal(json.promptArtifactPath, STEP_6L_PROMPT_RELATIVE);
    assert.equal(json.promptArtifactHash, promptHash);
    assert.equal(json.promptSourceConfirmed, true);
    assert.equal(json.markerCaptured, true);
    assert.equal(json.reportValid, true);
    assert.equal(json.projectMutatedDuringCodexRun, false);
    assert.deepEqual(json.mutatedFilesDuringCodexRun, []);
    assert.equal(json.forbiddenMutation, false);
    assert.deepEqual(json.filesInspected, ["PLAN.md", "STATE.json", "BUILDING_REFERENCE.md"]);
    assert.equal(json.summary, "Fixture inspected cleanly.");
    assert.equal(json.invocation.shell, false);
    assert.equal(json.invocation.sandbox, "read-only");
    assert.equal(json.invocation.askForApproval, "never");
    assert.equal(json.invocation.dangerousBypass, false);
    assert.equal(json.invocation.stdinPolicy, "closed-empty");
    assert.equal(json.invocation.envPolicy, "sandbox-safe (LANG, PATH)");
    assert.equal(json.realGptUsed, false);
    assert.equal(json.workspaceWriteEnabled, false);
    assert.equal(json.arbitraryPromptExecutionEnabled, false);
    assert.equal(json.autonomousExecutionEnabled, false);
    assert.equal(json.nextSafeStep, "6M (design only)");
    assert.equal(json.artifacts.mockedBrainDecision, STEP_6L_DECISION_RELATIVE);
    assert.equal(json.artifacts.promptArtifact, STEP_6L_PROMPT_RELATIVE);
    assert.equal(json.artifacts.agentOutput, STEP_6L_AGENT_OUTPUT_RELATIVE);
    assert.equal(json.artifacts.jsonReport, `${STEP_6L_REPORT_DIRECTORY_RELATIVE}/step-6l-mocked-brain-readonly-handoff-test.json`);

    // Protected fixture files unchanged
    assert.deepEqual(snapshotProtected(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L blocks unsafe project path / missing project before any artifact write", () => {
  const context = makeContext();
  try {
    const unsafe = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { projectPath: context.directory }));
    assert.equal(unsafe.classification, CLASSIFICATIONS.UNSAFE_PROJECT);
    assert.equal(unsafe.mockedBrainDecisionWritten, false);
    assert.equal(unsafe.promptArtifactWritten, false);
    fs.rmSync(context.projectPath, { recursive: true, force: true });
    const missing = runActivationMockedBrainReadonlyHandoff(baseRequest(context));
    assert.equal(missing.classification, CLASSIFICATIONS.MISSING_PROJECT);
    assert.equal(missing.mockedBrainDecisionWritten, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L MARKER_MALFORMED when Codex returns wrong project id", () => {
  const context = makeContext();
  try {
    const stdout = `${STEP_6L_MARKER}\nproject=other\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`;
    const spawn = fakeSpawn(() => ({ status: 0, stdout, stderr: "" }));
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MALFORMED);
    assert.equal(report.reportFailureReason, "project-mismatch");
    assert.equal(report.artifactsWritten, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L MARKER_MALFORMED when Codex returns wrong decision_type", () => {
  const context = makeContext();
  try {
    const stdout = `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=WRITE\nprompt_source=${STEP_6L_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`;
    const spawn = fakeSpawn(() => ({ status: 0, stdout, stderr: "" }));
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MALFORMED);
    assert.equal(report.reportFailureReason, "decision-type-mismatch");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L MARKER_MALFORMED when Codex returns wrong prompt_source", () => {
  const context = makeContext();
  try {
    const stdout = `${STEP_6L_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=out/prompts/wrong.md\nfiles_inspected=PLAN.md\nsummary=ok\n`;
    const spawn = fakeSpawn(() => ({ status: 0, stdout, stderr: "" }));
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MALFORMED);
    assert.equal(report.reportFailureReason, "prompt-source-mismatch");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L MARKER_MISSING when output has no marker", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "ok no marker\n", stderr: "" }));
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MISSING);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

for (const [label, spawnReturn, expectedClass] of [
  ["timeout", () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }), CLASSIFICATIONS.TIMEOUT],
  ["not-installed", () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("nf"), { code: "ENOENT" }) }), CLASSIFICATIONS.NOT_INSTALLED],
  ["auth", () => ({ status: 1, stdout: "", stderr: "Not authenticated. Please sign in by running `codex login`.\n" }), CLASSIFICATIONS.AUTH],
  ["usage-limit", () => ({ status: 1, stdout: "", stderr: "ERROR: You've hit your usage limit. try again at later.\n" }), CLASSIFICATIONS.USAGE_LIMIT],
  ["interactive", () => ({ status: 0, stdout: "Waiting for approval...\n", stderr: "" }), CLASSIFICATIONS.INTERACTIVE],
  ["crash", () => ({ status: 7, stdout: "", stderr: "codex crashed\n" }), CLASSIFICATIONS.CRASH]
]) {
  test(`Step 6L classifies Codex ${label} as ${expectedClass}; no output artifacts written but decision and prompt artifacts remain on disk`, () => {
    const context = makeContext();
    try {
      const spawn = fakeSpawn(spawnReturn);
      const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
      assert.equal(report.classification, expectedClass);
      assert.equal(report.mockedBrainDecisionWritten, true);
      assert.equal(report.promptArtifactWritten, true);
      assert.equal(report.artifactsWritten, false);
      assert.equal(report.step6mSafeToDesign, false);
    } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
  });
}

test("Step 6L detects Codex mutation between prompt write and output artifact write", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "PLAN.md"), "# Codex mutated\n");
      return { status: 0, stdout: validReportOutput(context.projectId), stderr: "" };
    });
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.CODEX_MUTATED_PROJECT);
    assert.equal(report.codexMutatedProject, true);
    assert.ok(report.codexMutatedFiles.includes("PLAN.md"));
    assert.equal(report.artifactsWritten, false);
    assert.equal(report.step6mSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L artifact paths stay strictly inside the project folder", () => {
  const context = makeContext();
  try {
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    for (const relative of [
      report.artifactPaths.mockedBrainDecision,
      report.artifactPaths.promptArtifact,
      report.artifactPaths.agentOutput,
      report.artifactPaths.jsonReport
    ]) {
      assert.equal(typeof relative, "string");
      assert.equal(relative.includes(".."), false);
      const absolute = path.resolve(context.projectPath, relative);
      const rel = path.relative(context.projectPath, absolute);
      assert.equal(rel.startsWith(".."), false);
      assert.equal(path.isAbsolute(rel), false);
      assert.equal(fs.existsSync(absolute), true);
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L redacts api-key / token / github-shaped secrets from captured stdout/stderr before writing artifacts", () => {
  const context = makeContext();
  try {
    const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
    const ghSecret = "ghp_ABCDEFGHIJ1234567890zzzz";
    const stdout = `${validReportOutput(context.projectId)}\ntoken=${secret}\n`;
    const stderr = `auth=${ghSecret}\n`;
    const spawn = fakeSpawn(() => ({ status: 0, stdout, stderr }));
    runActivationMockedBrainReadonlyHandoff(baseRequest(context, { spawn }));
    const jsonPath = path.join(context.projectPath, STEP_6L_REPORT_DIRECTORY_RELATIVE, "step-6l-mocked-brain-readonly-handoff-test.json");
    const mdPath = path.join(context.projectPath, STEP_6L_AGENT_OUTPUT_RELATIVE);
    const jsonText = fs.readFileSync(jsonPath, "utf8");
    const mdText = fs.readFileSync(mdPath, "utf8");
    assert.equal(jsonText.includes(secret), false);
    assert.equal(jsonText.includes(ghSecret), false);
    assert.equal(mdText.includes(secret), false);
    assert.equal(mdText.includes(ghSecret), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L never creates root BUILD_LOG.md, root STATE.json, or any host file", () => {
  const context = makeContext();
  try {
    const repoRoot = path.resolve(".");
    const before = {
      buildLog: fs.existsSync(path.join(repoRoot, "BUILD_LOG.md")),
      stateJson: fs.existsSync(path.join(repoRoot, "STATE.json"))
    };
    runActivationMockedBrainReadonlyHandoff(baseRequest(context));
    assert.equal(fs.existsSync(path.join(repoRoot, "BUILD_LOG.md")), before.buildLog);
    assert.equal(fs.existsSync(path.join(repoRoot, "STATE.json")), before.stateJson);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6L uses a safe deterministic-ish report name when none is provided", () => {
  const context = makeContext();
  try {
    const report = runActivationMockedBrainReadonlyHandoff(baseRequest(context, { reportName: undefined }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.match(report.artifactPaths.jsonReport, /^out\/agent_outputs\/step-6l-mocked-brain-readonly-handoff-[A-Za-z0-9_.\-]+\.json$/u);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-mocked-brain-readonly-handoff returns non-zero when codex is unavailable", () => {
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
      exitCode = runCli(["activation-mocked-brain-readonly-handoff", "--config", configPath, "--project", "example-project"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapter, "codex");
    assert.equal(parsed.mode, "mocked-brain-readonly-exec");
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.notEqual(exitCode, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-mocked-brain-readonly-handoff rejects non-codex adapter selections", () => {
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
        () => runCli(["activation-mocked-brain-readonly-handoff", "--config", configPath, "--project", "example-project", "--adapter", "claude-code"]),
        (error) => code(error, "INVALID_ARGUMENT")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI activation-mocked-brain-readonly-handoff exits non-zero when codex is missing", () => {
  const context = makeContext("example-project");
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    const env = { ...process.env, PATH: emptyPathDir, Path: emptyPathDir, path: emptyPathDir };
    const result = spawnSync(process.execPath, [CLI_PATH, "activation-mocked-brain-readonly-handoff", "--config", configPath, "--project", "example-project"], {
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
    assert.equal(parsed.invocation.dangerousBypass, false);
    assert.equal(parsed.realGptUsed, false);
    assert.equal(parsed.workspaceWriteEnabled, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
