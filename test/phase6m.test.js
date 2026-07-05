import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnCliSync, withEmptyPath } from "./helpers/spawned-cli.js";
import {
  REQUIRED_REPORT_KEYS,
  STEP_6M_MARKER,
  STEP_6M_PROMPT_RELATIVE,
  STEP_6M_PROVIDER,
  buildStep6mDecision,
  createBrainDecisionProvider,
  validateStep6mDecision
} from "../src/brain-decision-provider.js";
import {
  CLASSIFICATIONS,
  STEP_6M_AGENT_OUTPUT_RELATIVE,
  STEP_6M_DECISION_RELATIVE,
  STEP_6M_FLAGS,
  STEP_6M_REPORT_DIRECTORY_RELATIVE,
  buildStep6mArgv,
  buildStep6mPrompt,
  parseStep6mReport,
  runActivationProviderBrainReadonlyHandoff
} from "../src/brain-provider-readonly-handoff.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = "src/cli.js";

const validState = Object.freeze({
  currentPhase: "6M", currentTask: "provider-brain-readonly-handoff", currentBranch: "main", currentPr: null,
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
    "PLAN.md": "# Plan\n", "BUILDING_REFERENCE.md": "# Reference\n",
    "BUILD_LOG.md": "# Build log\n", "CURRENT_TASK.md": "# Task\n",
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
    STEP_6M_MARKER,
    `project=${projectId}`, "readonly=true",
    "decision_type=READONLY_AGENT_PROMPT",
    `provider=${STEP_6M_PROVIDER}`,
    `prompt_source=${STEP_6M_PROMPT_RELATIVE}`,
    `files_inspected=${files.join(",")}`,
    `summary=${summary}`, ""
  ].join("\n");
}

function baseRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    projectId: context.projectId,
    explicitProviderHandoffPermit: true,
    env: { PATH: "/usr/bin" },
    now: () => "2026-06-25T20-00-00-000Z",
    reportName: "step-6m-provider-brain-readonly-handoff-test.json",
    spawn: fakeSpawn(() => ({ status: 0, stdout: validReportOutput(context.projectId), stderr: "" })),
    ...overrides
  };
}

function snapshotProtected(projectPath) {
  const out = {};
  for (const name of ["PLAN.md","BUILDING_REFERENCE.md","BUILD_LOG.md","CURRENT_TASK.md","STATE.json","package.json","src/index.js","test/index.test.js"]) {
    const file = path.join(projectPath, name);
    out[name] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return out;
}

// === Provider tests ===

test("createBrainDecisionProvider only accepts mocked-readonly", () => {
  const provider = createBrainDecisionProvider({ provider: "mocked-readonly" });
  assert.equal(provider.provider, "mocked-readonly");
  assert.equal(typeof provider.getDecision, "function");
  for (const bad of ["real-openai", "gpt-4", "gpt", "openai-api", "", undefined, null, "chatgpt"]) {
    assert.throws(
      () => createBrainDecisionProvider({ provider: bad }),
      (error) => code(error, "STEP_6M_PROVIDER_UNSUPPORTED")
    );
  }
});

test("mocked provider does not touch network, fetch, env credentials, or fs", () => {
  // Poison globals + env to prove the provider ignores them
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("provider must not call fetch"); };
  const originalOpenAi = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-be-read";
  try {
    const provider = createBrainDecisionProvider({ provider: "mocked-readonly" });
    const decision = provider.getDecision({ projectId: "demo-project" });
    assert.equal(decision.provider, "mocked-readonly");
    assert.equal(decision.project, "demo-project");
    assert.equal(decision.realGptAllowed, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAi;
  }
});

test("buildStep6mDecision template is complete and rejects unsafe projectIds", () => {
  const d = buildStep6mDecision("demo-project");
  assert.equal(d.schema, "hephaestus.step-6m.provider-brain-decision/v1");
  assert.equal(d.provider, "mocked-readonly");
  assert.equal(d.project, "demo-project");
  assert.equal(d.phase, "Activation Step 6M");
  assert.equal(d.decisionType, "READONLY_AGENT_PROMPT");
  assert.equal(d.adapter, "codex");
  assert.equal(d.mode, "read-only");
  assert.equal(d.allowedAction, "INSPECT_FIXTURE_ONLY");
  assert.equal(d.requiredMarker, STEP_6M_MARKER);
  assert.equal(d.promptSource, STEP_6M_PROMPT_RELATIVE);
  assert.equal(d.realGptAllowed, false);
  assert.equal(d.workspaceWriteAllowed, false);
  assert.equal(d.arbitraryPromptAllowed, false);
  assert.equal(d.autonomousExecutionAllowed, false);
  for (const required of ["write_files","delete_files","rename_files","move_files","run_mutating_commands","network_access","request_approval","workspace_write","arbitrary_prompt_execution","autonomous_execution","merge","deploy","real_gpt_call"]) {
    assert.ok(d.forbiddenActions.includes(required));
  }
  assert.deepEqual(d.expectedReportKeys, [...REQUIRED_REPORT_KEYS]);
  for (const evil of ["../escape", "demo project", "a/b", "", "a".repeat(70), "demo;rm"]) {
    assert.throws(() => buildStep6mDecision(evil), (error) => code(error, "INVALID_STEP_6M_PROJECT_ID"));
  }
});

test("validateStep6mDecision rejects every malformed variant", () => {
  const good = buildStep6mDecision("demo-project");
  assert.equal(validateStep6mDecision(good, "demo-project").ok, true);

  const mutators = [
    ["null", null, "not-an-object"],
    ["array", [], "not-an-object"],
    ["wrong schema", { ...good, schema: "other" }, "schema-mismatch"],
    ["wrong provider", { ...good, provider: "real-gpt" }, "provider-mismatch"],
    ["wrong project", { ...good, project: "other" }, "project-mismatch"],
    ["wrong phase", { ...good, phase: "Other" }, "phase-mismatch"],
    ["wrong decisionType", { ...good, decisionType: "WRITE" }, "decision-type-mismatch"],
    ["wrong adapter", { ...good, adapter: "claude-code" }, "adapter-mismatch"],
    ["wrong mode", { ...good, mode: "write" }, "mode-mismatch"],
    ["wrong allowedAction", { ...good, allowedAction: "BUILD" }, "allowed-action-mismatch"],
    ["forbiddenActions not array", { ...good, forbiddenActions: "no" }, "forbidden-actions-not-array"],
    ["missing forbidden write_files", { ...good, forbiddenActions: good.forbiddenActions.filter((a) => a !== "write_files") }, "missing-forbidden-write_files"],
    ["missing forbidden real_gpt_call", { ...good, forbiddenActions: good.forbiddenActions.filter((a) => a !== "real_gpt_call") }, "missing-forbidden-real_gpt_call"],
    ["unknown forbidden", { ...good, forbiddenActions: [...good.forbiddenActions, "frobnicate"] }, "unknown-forbidden-frobnicate"],
    ["wrong requiredMarker", { ...good, requiredMarker: "wrong" }, "required-marker-mismatch"],
    ["wrong promptSource", { ...good, promptSource: "out/prompts/other.md" }, "prompt-source-mismatch"],
    ["realGptAllowed true", { ...good, realGptAllowed: true }, "real-gpt-allowed-not-false"],
    ["workspaceWriteAllowed true", { ...good, workspaceWriteAllowed: true }, "workspace-write-allowed-not-false"],
    ["arbitraryPromptAllowed true", { ...good, arbitraryPromptAllowed: true }, "arbitrary-prompt-allowed-not-false"],
    ["autonomousExecutionAllowed true", { ...good, autonomousExecutionAllowed: true }, "autonomous-execution-allowed-not-false"],
    ["missing expected key", { ...good, expectedReportKeys: good.expectedReportKeys.filter((k) => k !== "summary") }, "missing-expected-key-summary"],
    ["missing provider key", { ...good, expectedReportKeys: good.expectedReportKeys.filter((k) => k !== "provider") }, "missing-expected-key-provider"],
    ["wrong nextSafeStep", { ...good, nextSafeStep: "7A" }, "next-safe-step-mismatch"]
  ];
  for (const [label, candidate, expectedReason] of mutators) {
    const result = validateStep6mDecision(candidate, "demo-project");
    assert.equal(result.ok, false, `expected failure for ${label}`);
    assert.equal(result.reason, expectedReason, `expected reason ${expectedReason} for ${label}`);
  }
  for (const forbidden of ["command","shell","executable","argv","cwd","prompt","promptFile","autoApproval","workspaceWrite","merge","deploy","secrets","env","apiKey","openaiApiKey","model","endpoint","url","fetch","network"]) {
    const result = validateStep6mDecision({ ...good, [forbidden]: "danger" }, "demo-project");
    assert.equal(result.ok, false, `forbidden ${forbidden} must be rejected`);
    assert.equal(result.reason, `forbidden-field-${forbidden}`);
  }
});

// === Prompt / argv / parser ===

test("buildStep6mPrompt contains marker, provider, forbids mutation, mentions offline mocked provider", () => {
  const prompt = buildStep6mPrompt("demo-project");
  assert.ok(prompt.includes(STEP_6M_MARKER));
  assert.match(prompt, /Project: demo-project/u);
  assert.match(prompt, /Decision type: READONLY_AGENT_PROMPT/u);
  assert.match(prompt, /Provider: mocked-readonly/u);
  assert.match(prompt, /Do not modify, create, delete, rename, or move any file/u);
  assert.match(prompt, /Do not access the network/u);
  assert.match(prompt, /offline mocked brain-decision provider/u);
  assert.match(prompt, /NOT a real GPT decision/u);
  assert.ok(prompt.includes(`prompt_source=${STEP_6M_PROMPT_RELATIVE}`));
});

test("buildStep6mArgv places top-level flags before exec and forbids dangerous tokens", () => {
  const prompt = buildStep6mPrompt("demo-project");
  const argv = buildStep6mArgv(prompt);
  assert.deepEqual(argv.slice(0, 5), ["--sandbox","read-only","--ask-for-approval","never","exec"]);
  assert.equal(argv[5], prompt);
  for (const forbidden of ["--dangerously-bypass-approvals-and-sandbox","--dangerously-bypass-hook-trust","--add-dir","--search","-c","workspace-write","danger-full-access"]) {
    assert.equal(argv.includes(forbidden), false);
  }
});

test("STEP_6M_FLAGS exposes shell:false, sandbox:read-only, ask-for-approval:never", () => {
  assert.equal(STEP_6M_FLAGS.shell, false);
  assert.equal(STEP_6M_FLAGS.sandbox, "read-only");
  assert.equal(STEP_6M_FLAGS.askForApproval, "never");
  assert.equal(STEP_6M_FLAGS.subcommand, "exec");
});

test("parseStep6mReport accepts a well-formed Step 6M report and rejects malformed variants", () => {
  const ok = parseStep6mReport(validReportOutput("demo-project"), {
    expectedProjectId: "demo-project", expectedPromptSource: STEP_6M_PROMPT_RELATIVE
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.provider, "mocked-readonly");

  for (const [label, output, expectedReason] of [
    ["missing marker", "nothing", "marker-missing"],
    ["wrong project", `${STEP_6M_MARKER}\nproject=other\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "project-mismatch"],
    ["wrong decision_type", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=WRITE\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "decision-type-mismatch"],
    ["wrong provider", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=real-gpt\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "provider-mismatch"],
    ["wrong prompt_source", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=out/wrong.md\nfiles_inspected=PLAN.md\nsummary=ok\n`, "prompt-source-mismatch"],
    ["readonly not true", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=false\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "readonly-not-true"],
    ["missing provider key", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "missing-provider"],
    ["empty files", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=,,\nsummary=ok\n`, "files-inspected-empty"],
    ["unsafe file", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md,$(rm)\nsummary=ok\n`, "files-inspected-unsafe"]
  ]) {
    const parsed = parseStep6mReport(output, { expectedProjectId: "demo-project", expectedPromptSource: STEP_6M_PROMPT_RELATIVE });
    assert.equal(parsed.ok, false, `expected failure for ${label}`);
    assert.equal(parsed.reason, expectedReason);
  }
});

// === Request-shape gates ===

test("Step 6M request shape rejects every user-supplied dangerous key", () => {
  const context = makeContext();
  try {
    for (const evil of ["executable","argv","shell","shellCommand","command","prompt","promptFile","instruction","autoApproval","cwd","secrets","merge","deploy","workspaceWrite","apiKey","openaiApiKey","model","endpoint","url","fetch","network"]) {
      assert.throws(
        () => runActivationProviderBrainReadonlyHandoff({ ...baseRequest(context), [evil]: "danger" }),
        (error) => code(error, "INVALID_STEP_6M_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6M rejects non-codex adapters and missing permit; PROVIDER_UNSUPPORTED for other providers", () => {
  const context = makeContext();
  try {
    for (const adapterId of ["claude-code","opencode","fixture-agent"]) {
      assert.throws(
        () => runActivationProviderBrainReadonlyHandoff(baseRequest(context, { adapterId })),
        (error) => code(error, "STEP_6M_ADAPTER_NOT_ALLOWED")
      );
    }
    assert.throws(
      () => runActivationProviderBrainReadonlyHandoff(baseRequest(context, { explicitProviderHandoffPermit: false })),
      (error) => code(error, "STEP_6M_PERMIT_REQUIRED")
    );
    const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { provider: "real-gpt" }));
    assert.equal(report.classification, CLASSIFICATIONS.PROVIDER_UNSUPPORTED);
    assert.equal(report.step6nSafeToDesign, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

// === Happy path ===

test("Step 6M PASS: provider decision + prompt + Codex handoff + output artifacts, no mutation", () => {
  const context = makeContext();
  try {
    const before = snapshotProtected(context.projectPath);
    const spawn = fakeSpawn(() => ({ status: 0, stdout: validReportOutput(context.projectId, ["PLAN.md","STATE.json","BUILDING_REFERENCE.md"], "Fixture inspected cleanly."), stderr: "" }));
    const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { spawn }));

    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.provider, STEP_6M_PROVIDER);
    assert.equal(report.providerDecisionWritten, true);
    assert.equal(report.providerBrainDecisionValid, true);
    assert.equal(report.promptArtifactWritten, true);
    assert.equal(report.promptSourceConfirmed, true);
    assert.equal(report.artifactsWritten, true);
    assert.equal(report.codexMutatedProject, false);
    assert.equal(report.forbiddenMutation, false);
    assert.equal(report.realGptUsed, false);
    assert.equal(report.openAiApiUsed, false);
    assert.equal(report.workspaceWriteEnabled, false);
    assert.equal(report.arbitraryPromptExecutionEnabled, false);
    assert.equal(report.autonomousExecutionEnabled, false);
    assert.equal(report.step6nSafeToDesign, true);

    // On disk
    const decisionPath = path.join(context.projectPath, STEP_6M_DECISION_RELATIVE);
    const promptPath = path.join(context.projectPath, STEP_6M_PROMPT_RELATIVE);
    const agentOut = path.join(context.projectPath, STEP_6M_AGENT_OUTPUT_RELATIVE);
    const jsonPath = path.join(context.projectPath, STEP_6M_REPORT_DIRECTORY_RELATIVE, "step-6m-provider-brain-readonly-handoff-test.json");
    for (const p of [decisionPath, promptPath, agentOut, jsonPath]) assert.equal(fs.existsSync(p), true);

    // Decision content matches template
    const decisionText = fs.readFileSync(decisionPath, "utf8");
    const expectedDecisionText = `${JSON.stringify(buildStep6mDecision(context.projectId), null, 2)}\n`;
    assert.equal(decisionText, expectedDecisionText);
    const decisionHash = createHash("sha256").update(decisionText).digest("hex");
    assert.equal(report.providerBrainDecisionHash, decisionHash);

    // Prompt content matches
    const promptText = fs.readFileSync(promptPath, "utf8");
    assert.equal(promptText, buildStep6mPrompt(context.projectId));
    const promptHash = createHash("sha256").update(promptText).digest("hex");
    assert.equal(report.promptArtifactHash, promptHash);

    // Spawn used the read-back prompt
    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0];
    assert.equal(call.executable, "codex");
    assert.equal(call.shell, false);
    assert.equal(call.input, "");
    assert.deepEqual(Object.keys(call.env).sort(), ["LANG","PATH"]);
    assert.deepEqual(call.args.slice(0, 5), ["--sandbox","read-only","--ask-for-approval","never","exec"]);
    assert.equal(call.args[5], promptText);

    // Markdown
    const md = fs.readFileSync(agentOut, "utf8");
    assert.match(md, /Step 6M classification: STEP_6M_PASS/u);
    assert.match(md, /Provider: mocked-readonly/u);
    assert.match(md, /Adapter: codex/u);
    assert.match(md, /Provider decision path: out\/brain_decisions\/step-6m-provider-brain-decision\.json/u);
    assert.match(md, new RegExp(`Provider decision SHA-256: ${decisionHash}`, "u"));
    assert.match(md, /Provider decision valid: yes/u);
    assert.match(md, /Prompt artifact path: out\/prompts\/step-6m-provider-readonly-prompt\.md/u);
    assert.match(md, new RegExp(`Prompt artifact SHA-256: ${promptHash}`, "u"));
    assert.match(md, /Prompt source confirmed: yes/u);
    assert.match(md, /Marker captured: yes/u);
    assert.match(md, /Report valid: yes/u);
    assert.match(md, /Codex mutated project during run: no/u);
    assert.match(md, /Files inspected by Codex: PLAN.md, STATE.json, BUILDING_REFERENCE.md/u);
    assert.match(md, /real GPT used: no/u);
    assert.match(md, /OpenAI API used: no/u);
    assert.match(md, /workspace-write enabled: no/u);
    assert.match(md, /offline mocked-provider brain read-only Codex handoff/u);
    assert.match(md, /Step 6N may be designed/u);

    // JSON
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(json.schema, "hephaestus.step-6m.provider-brain-readonly-handoff/v1");
    assert.equal(json.provider, "mocked-readonly");
    assert.equal(json.adapter, "codex");
    assert.equal(json.classification, CLASSIFICATIONS.PASS);
    assert.equal(json.providerBrainDecisionPath, STEP_6M_DECISION_RELATIVE);
    assert.equal(json.providerBrainDecisionHash, decisionHash);
    assert.equal(json.providerBrainDecisionValid, true);
    assert.equal(json.promptArtifactPath, STEP_6M_PROMPT_RELATIVE);
    assert.equal(json.promptArtifactHash, promptHash);
    assert.equal(json.promptSourceConfirmed, true);
    assert.equal(json.markerCaptured, true);
    assert.equal(json.reportValid, true);
    assert.equal(json.projectMutatedDuringCodexRun, false);
    assert.equal(json.forbiddenMutation, false);
    assert.deepEqual(json.filesInspected, ["PLAN.md","STATE.json","BUILDING_REFERENCE.md"]);
    assert.equal(json.invocation.shell, false);
    assert.equal(json.invocation.sandbox, "read-only");
    assert.equal(json.invocation.askForApproval, "never");
    assert.equal(json.invocation.dangerousBypass, false);
    assert.equal(json.invocation.stdinPolicy, "closed-empty");
    assert.equal(json.realGptUsed, false);
    assert.equal(json.openAiApiUsed, false);
    assert.equal(json.workspaceWriteEnabled, false);
    assert.equal(json.arbitraryPromptExecutionEnabled, false);
    assert.equal(json.autonomousExecutionEnabled, false);
    assert.equal(json.nextSafeStep, "6N (design only)");
    assert.equal(json.artifacts.providerBrainDecision, STEP_6M_DECISION_RELATIVE);
    assert.equal(json.artifacts.promptArtifact, STEP_6M_PROMPT_RELATIVE);

    assert.deepEqual(snapshotProtected(context.projectPath), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

// === Path / project failure modes ===

test("Step 6M blocks unsafe project / missing project before any artifact write", () => {
  const context = makeContext();
  try {
    const unsafe = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { projectPath: context.directory }));
    assert.equal(unsafe.classification, CLASSIFICATIONS.UNSAFE_PROJECT);
    fs.rmSync(context.projectPath, { recursive: true, force: true });
    const missing = runActivationProviderBrainReadonlyHandoff(baseRequest(context));
    assert.equal(missing.classification, CLASSIFICATIONS.MISSING_PROJECT);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

// === Codex outcome classifications ===

for (const [label, spawnReturn, expectedClass] of [
  ["timeout", () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }), CLASSIFICATIONS.TIMEOUT],
  ["not-installed", () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("nf"), { code: "ENOENT" }) }), CLASSIFICATIONS.NOT_INSTALLED],
  ["auth", () => ({ status: 1, stdout: "", stderr: "Not authenticated. Please sign in by running `codex login`.\n" }), CLASSIFICATIONS.AUTH],
  ["usage-limit", () => ({ status: 1, stdout: "", stderr: "ERROR: You've hit your usage limit. try again at later.\n" }), CLASSIFICATIONS.USAGE_LIMIT],
  ["interactive", () => ({ status: 0, stdout: "Waiting for approval...\n", stderr: "" }), CLASSIFICATIONS.INTERACTIVE],
  ["crash", () => ({ status: 7, stdout: "", stderr: "codex crashed\n" }), CLASSIFICATIONS.CRASH]
]) {
  test(`Step 6M classifies Codex ${label} as ${expectedClass}; no output artifacts, decision + prompt remain on disk`, () => {
    const context = makeContext();
    try {
      const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { spawn: fakeSpawn(spawnReturn) }));
      assert.equal(report.classification, expectedClass);
      assert.equal(report.providerDecisionWritten, true);
      assert.equal(report.promptArtifactWritten, true);
      assert.equal(report.artifactsWritten, false);
      assert.equal(report.step6nSafeToDesign, false);
    } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
  });
}

test("Step 6M MARKER_MALFORMED for wrong project / decision_type / provider / prompt_source", () => {
  const context = makeContext();
  try {
    for (const [label, output, reason] of [
      ["wrong project", `${STEP_6M_MARKER}\nproject=other\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "project-mismatch"],
      ["wrong decision_type", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=WRITE\nprovider=${STEP_6M_PROVIDER}\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "decision-type-mismatch"],
      ["wrong provider", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=real-gpt\nprompt_source=${STEP_6M_PROMPT_RELATIVE}\nfiles_inspected=PLAN.md\nsummary=ok\n`, "provider-mismatch"],
      ["wrong prompt_source", `${STEP_6M_MARKER}\nproject=demo-project\nreadonly=true\ndecision_type=READONLY_AGENT_PROMPT\nprovider=${STEP_6M_PROVIDER}\nprompt_source=out/wrong.md\nfiles_inspected=PLAN.md\nsummary=ok\n`, "prompt-source-mismatch"]
    ]) {
      const spawn = fakeSpawn(() => ({ status: 0, stdout: output, stderr: "" }));
      const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { spawn }));
      assert.equal(report.classification, CLASSIFICATIONS.MARKER_MALFORMED, `expected MARKER_MALFORMED for ${label}`);
      assert.equal(report.reportFailureReason, reason);
      assert.equal(report.artifactsWritten, false);
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6M MARKER_MISSING when output has no marker", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn(() => ({ status: 0, stdout: "ok\n", stderr: "" }));
    const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.MARKER_MISSING);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6M CODEX_MUTATED_PROJECT when Codex changes files between snapshots", () => {
  const context = makeContext();
  try {
    const spawn = fakeSpawn((exe, args, options) => {
      fs.writeFileSync(path.join(options.cwd, "PLAN.md"), "# Codex mutated\n");
      return { status: 0, stdout: validReportOutput(context.projectId), stderr: "" };
    });
    const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { spawn }));
    assert.equal(report.classification, CLASSIFICATIONS.CODEX_MUTATED_PROJECT);
    assert.equal(report.codexMutatedProject, true);
    assert.ok(report.codexMutatedFiles.includes("PLAN.md"));
    assert.equal(report.artifactsWritten, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6M redacts api-key / token / github secrets in persisted artifacts", () => {
  const context = makeContext();
  try {
    const secret = "sk-abcdefghijklmnop1234567890ZZZZ";
    const ghSecret = "ghp_ABCDEFGHIJ1234567890zzzz";
    const spawn = fakeSpawn(() => ({
      status: 0,
      stdout: `${validReportOutput(context.projectId)}\ntoken=${secret}\n`,
      stderr: `auth=${ghSecret}\n`
    }));
    runActivationProviderBrainReadonlyHandoff(baseRequest(context, { spawn }));
    const jsonPath = path.join(context.projectPath, STEP_6M_REPORT_DIRECTORY_RELATIVE, "step-6m-provider-brain-readonly-handoff-test.json");
    const mdPath = path.join(context.projectPath, STEP_6M_AGENT_OUTPUT_RELATIVE);
    const jsonText = fs.readFileSync(jsonPath, "utf8");
    const mdText = fs.readFileSync(mdPath, "utf8");
    assert.equal(jsonText.includes(secret), false);
    assert.equal(jsonText.includes(ghSecret), false);
    assert.equal(mdText.includes(secret), false);
    assert.equal(mdText.includes(ghSecret), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6M artifact paths stay strictly inside the project folder", () => {
  const context = makeContext();
  try {
    const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context));
    for (const relative of [
      report.artifactPaths.providerBrainDecision,
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

test("Step 6M never creates root BUILD_LOG.md, root STATE.json, or any host file", () => {
  const context = makeContext();
  try {
    const repoRoot = path.resolve(".");
    const before = {
      buildLog: fs.existsSync(path.join(repoRoot, "BUILD_LOG.md")),
      stateJson: fs.existsSync(path.join(repoRoot, "STATE.json"))
    };
    runActivationProviderBrainReadonlyHandoff(baseRequest(context));
    assert.equal(fs.existsSync(path.join(repoRoot, "BUILD_LOG.md")), before.buildLog);
    assert.equal(fs.existsSync(path.join(repoRoot, "STATE.json")), before.stateJson);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("Step 6M uses a deterministic-ish default report name when none is provided", () => {
  const context = makeContext();
  try {
    const report = runActivationProviderBrainReadonlyHandoff(baseRequest(context, { reportName: undefined }));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.match(report.artifactPaths.jsonReport, /^out\/agent_outputs\/step-6m-provider-brain-readonly-handoff-[A-Za-z0-9_.\-]+\.json$/u);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

// === CLI ===

test("CLI activation-provider-brain-readonly-handoff returns non-zero when codex is unavailable", () => {
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
      exitCode = withEmptyPath(emptyPathDir, () => runCli(["activation-provider-brain-readonly-handoff", "--config", configPath, "--project", "example-project"]));
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.adapter, "codex");
    assert.equal(parsed.provider, "mocked-readonly");
    assert.equal(parsed.mode, "provider-brain-readonly-exec");
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.notEqual(exitCode, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-provider-brain-readonly-handoff rejects non-codex adapter selections", () => {
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
        () => runCli(["activation-provider-brain-readonly-handoff", "--config", configPath, "--project", "example-project", "--adapter", "claude-code"]),
        (error) => code(error, "INVALID_ARGUMENT")
      );
    } finally { process.stdout.write = originalWrite; }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI activation-provider-brain-readonly-handoff exits non-zero when codex is missing; safety invariants intact", () => {
  const context = makeContext("example-project");
  try {
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const emptyPathDir = path.join(context.directory, "empty-path");
    fs.mkdirSync(emptyPathDir);
    const env = { ...process.env, PATH: emptyPathDir, Path: emptyPathDir, path: emptyPathDir };
    const result = spawnCliSync(process.execPath, [CLI_PATH, "activation-provider-brain-readonly-handoff", "--config", configPath, "--project", "example-project"], {
      encoding: "utf8", shell: false, env, timeout: 60_000
    });
    assert.equal(result.error, undefined);
    assert.equal(typeof result.status, "number");
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.notEqual(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.provider, "mocked-readonly");
    assert.equal(parsed.invocation.sandbox, "read-only");
    assert.equal(parsed.invocation.askForApproval, "never");
    assert.equal(parsed.invocation.shell, false);
    assert.equal(parsed.invocation.dangerousBypass, false);
    assert.equal(parsed.realGptUsed, false);
    assert.equal(parsed.openAiApiUsed, false);
    assert.equal(parsed.workspaceWriteEnabled, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
