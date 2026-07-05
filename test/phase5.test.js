import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { runAsync, run as runCli } from "../src/cli.js";
import { runLiveBrainCycle } from "../src/live-brain.js";
import { requestOpenAIDecision } from "../src/openai-provider.js";
import { loadTestDeclaration, projectFingerprint, saveTestEvidence, verifyTestEvidence } from "../src/test-gate.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const decision = Object.freeze({ nextAction: "plan-farewell", rationale: "Keep the dummy change bounded.", allowedFiles: ["src/greeting.js", "test/greeting.test.js"], requiredTests: ["npm test"], stopConditions: ["Stop if required files are missing."] });
// Validation adds the loop signal (defaulting to "continue") to accepted decisions.
const validated = Object.freeze({ ...decision, loopSignal: "continue" });
const openaiBrain = Object.freeze({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5.4-mini" });

function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }
function openaiResponse(value) { return async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify(value) }) }); }
function nestedOpenaiResponse(value) { return async () => ({ ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }) }); }
function project() {
  const directory = writableTemporaryDirectory("hephaestus-phase5-"); const root = path.join(directory, "projects"); const target = path.join(root, "demo"); fs.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries({ "PLAN.md": "# Demo\n", "BUILDING_REFERENCE.md": "# Reference\n", "BUILD_LOG.md": "# Build log\n", "CURRENT_TASK.md": "# Task\n", "src/greeting.js": "export function greeting() { return 'hello'; }\n", "test/greeting.test.js": "// greeting test\n" })) { fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true }); fs.writeFileSync(path.join(target, name), content); }
  fs.writeFileSync(path.join(target, "STATE.json"), `${JSON.stringify({ currentPhase: "5", currentTask: "plan farewell", currentBranch: "main", currentPr: null, assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null, mergeStatus: "not-started", containerStatus: "not-started", lastGptDecision: null, nextAction: "brain" })}\n`);
  return { directory, root, target };
}

test("valid OpenAI output is accepted without project mutation", async () => {
  const context = project(); const before = fs.readdirSync(context.target).sort();
  try { assert.deepEqual(await requestOpenAIDecision({ apiKey: "test-key", model: openaiBrain.model, input: "plan", fetchImpl: openaiResponse(decision) }), validated); assert.deepEqual(fs.readdirSync(context.target).sort(), before); } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("nested OpenAI response output is accepted", async () => {
  assert.deepEqual(await requestOpenAIDecision({ apiKey: "test-key", model: openaiBrain.model, input: "plan", fetchImpl: nestedOpenaiResponse(decision) }), validated);
});

test("malformed OpenAI output and missing keys are rejected safely", async () => {
  await assert.rejects(() => requestOpenAIDecision({ apiKey: "test-key", model: openaiBrain.model, input: "plan", fetchImpl: openaiResponse({ nextAction: "missing-fields" }) }), (error) => code(error, "INVALID_OPENAI_DECISION"));
  let called = false;
  await assert.rejects(() => requestOpenAIDecision({ apiKey: "", model: openaiBrain.model, input: "plan", fetchImpl: async () => { called = true; } }), (error) => code(error, "OPENAI_API_KEY_MISSING"));
  assert.equal(called, false);
});

test("a valid decision is accepted on the first attempt without a retry", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ output_text: JSON.stringify(decision) }) }; };
  assert.deepEqual(await requestOpenAIDecision({ apiKey: "k", model: openaiBrain.model, input: "plan", fetchImpl }), validated);
  assert.equal(calls, 1);
});

test("fenced JSON decision output is tolerated without weakening validation", async () => {
  const fenced = async () => ({ ok: true, json: async () => ({ output_text: `\`\`\`json\n${JSON.stringify(decision)}\n\`\`\`` }) });
  assert.deepEqual(await requestOpenAIDecision({ apiKey: "k", model: openaiBrain.model, input: "plan", fetchImpl: fenced }), validated);
});

test("one narrow retry recovers a valid decision after a first non-JSON reply", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ output_text: calls === 1 ? "Sure! Here is the plan (no JSON)." : JSON.stringify(decision) }) }; };
  assert.deepEqual(await requestOpenAIDecision({ apiKey: "k", model: openaiBrain.model, input: "plan", fetchImpl }), validated);
  assert.equal(calls, 2);
});

test("malformed model output on both attempts is rejected, never accepted", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ output_text: "not json at all" }) }; };
  await assert.rejects(() => requestOpenAIDecision({ apiKey: "k", model: openaiBrain.model, input: "plan", fetchImpl }), (error) => code(error, "INVALID_OPENAI_DECISION"));
  assert.equal(calls, 2);
});

test("OpenAI provider failures redact secrets and rate limits stay bounded", async () => {
  const secret = `local-secret-${"x".repeat(48)}`;
  await assert.rejects(() => requestOpenAIDecision({ apiKey: "test-key", model: openaiBrain.model, input: "plan", fetchImpl: async () => { throw new Error(`token=${secret}`); } }), (error) => { assert.equal(error.message.includes(secret), false); return code(error, "OPENAI_PROVIDER_FAILED"); });
  let calls = 0; const delays = [];
  await assert.rejects(() => requestOpenAIDecision({ apiKey: "test-key", model: openaiBrain.model, input: "plan", fetchImpl: async () => { calls += 1; return { ok: false, status: 429, headers: { get: () => null } }; }, sleepImpl: async (delay) => { delays.push(delay); } }), (error) => code(error, "OPENAI_RATE_LIMITED"));
  assert.equal(calls, 3); assert.deepEqual(delays, [250, 500]);
});

test("brain configuration is OpenAI-only and defaults to the OpenAI API key", () => {
  const directory = writableTemporaryDirectory("hephaestus-phase5-config-");
  try {
    fs.mkdirSync(path.join(directory, "projects"));
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ allowedRoot: "./projects", registryPath: "./registry.json", logDirectory: "./logs", brain: { provider: "gpt", model: openaiBrain.model } }));
    assert.deepEqual(loadConfig(path.join(directory, "config.json")).brain, openaiBrain);
    fs.writeFileSync(path.join(directory, "invalid.json"), JSON.stringify({ allowedRoot: "./projects", registryPath: "./registry.json", logDirectory: "./logs", brain: { provider: "unsupported", apiKeyEnv: "OTHER_API_KEY", model: openaiBrain.model } }));
    assert.throws(() => loadConfig(path.join(directory, "invalid.json")), (error) => code(error, "INVALID_CONFIG"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("provider selection defaults to OpenAI and rejects unsupported values", async () => {
  const context = project();
  try {
    const result = await runLiveBrainCycle({ allowedRoot: context.root, projectPath: context.target, brain: openaiBrain, env: { OPENAI_API_KEY: "test-key" }, fetchImpl: openaiResponse(decision) });
    assert.ok(fs.statSync(result.promptPath).isFile());
    await assert.rejects(() => runLiveBrainCycle({ allowedRoot: context.root, projectPath: context.target, brain: openaiBrain, env: { HEPHAESTUS_BRAIN_PROVIDER: "unsupported", OPENAI_API_KEY: "test-key" } }), (error) => code(error, "INVALID_BRAIN_PROVIDER"));
    await assert.rejects(() => runLiveBrainCycle({ allowedRoot: context.root, projectPath: context.target, brain: openaiBrain, env: {} }), (error) => code(error, "OPENAI_API_KEY_MISSING"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("validated OpenAI output saves only a bounded prompt and cannot directly mutate project files", async () => {
  const context = project(); const state = fs.readFileSync(path.join(context.target, "STATE.json"), "utf8"); const source = fs.readFileSync(path.join(context.target, "src/greeting.js"), "utf8"); const testSource = fs.readFileSync(path.join(context.target, "test/greeting.test.js"), "utf8");
  try {
    const result = await runLiveBrainCycle({ allowedRoot: context.root, projectPath: context.target, brain: openaiBrain, task: "Plan a farewell function and one test.", projectName: "demo", env: { OPENAI_API_KEY: "test-key" }, fetchImpl: openaiResponse(decision) });
    const prompt = fs.readFileSync(result.promptPath, "utf8");
    for (const section of ["Project name: demo", "Current phase:", "Current task:", "## Objective", "## Context Files To Read", "## Allowed Changes and Files", "## What To Build", "## What Not To Build Yet", "## Forbidden Changes", "## Required Tests", "## Required Evidence", "## Stop Conditions", "## Completion Criteria", "## Final Report Format"]) assert.match(prompt, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(prompt, /Do not read, reveal, modify, commit, or stage secrets/u); assert.match(prompt, /the conductor owns them/u);
    assert.match(prompt, /Do not bypass GPT approval/u);
    assert.equal(fs.readFileSync(path.join(context.target, "STATE.json"), "utf8"), state); assert.equal(fs.readFileSync(path.join(context.target, "src/greeting.js"), "utf8"), source); assert.equal(fs.readFileSync(path.join(context.target, "test/greeting.test.js"), "utf8"), testSource); assert.equal(fs.existsSync(path.join(context.target, "AGENT_OUTPUT.md")), false);
    await assert.rejects(() => runLiveBrainCycle({ allowedRoot: context.root, projectPath: context.target, brain: openaiBrain, env: { OPENAI_API_KEY: "test-key" }, fetchImpl: openaiResponse({ ...decision, allowedFiles: [".env"] }) }), (error) => code(error, "INVALID_PROVIDER_DECISION"));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("live-brain CLI saves a prompt to the configured runtime directory without running an agent", async () => {
  const context = project();
  const config = path.join(context.directory, "config.json");
  const registry = path.join(context.directory, "projects.json");
  fs.writeFileSync(config, JSON.stringify({ allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs", brain: openaiBrain }));
  fs.writeFileSync(registry, JSON.stringify({ projects: [{ id: "demo", path: "demo" }] }));
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.HEPHAESTUS_BRAIN_PROVIDER;
  const originalKey = process.env.OPENAI_API_KEY;
  let stdout = "";
  const originalWrite = process.stdout.write;
  try {
    globalThis.fetch = openaiResponse(decision);
    delete process.env.HEPHAESTUS_BRAIN_PROVIDER;
    process.env.OPENAI_API_KEY = "test-key";
    process.stdout.write = (chunk) => { stdout += chunk; return true; };
    assert.throws(() => runCli(["live-brain", "--config", config, "--project", "demo"]), (error) => code(error, "INVALID_ARGUMENT"));
    assert.equal(await runAsync(["live-brain", "--config", config, "--project", "demo"]), 0);
    const output = JSON.parse(stdout);
    assert.equal(output.provider, "openai");
    assert.equal(output.promptPath, path.join(context.directory, "out", "prompts", "next-task.md"));
    assert.equal(fs.existsSync(path.join(context.target, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(output.promptPath), true);
    assert.equal(fs.existsSync(path.join(context.target, "out", "prompts", "next-task.md")), false);
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.HEPHAESTUS_BRAIN_PROVIDER; else process.env.HEPHAESTUS_BRAIN_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

function makeContext() {
  const directory = fs.mkdtempSync(path.join(path.resolve("test"), "tmp-"));
  fs.writeFileSync(path.join(directory, "source.txt"), "original\n");
  fs.writeFileSync(path.join(directory, "TESTS.json"), JSON.stringify({ requiredCommands: [{ id: "unit", outputRequired: true }], watchedFiles: ["source.txt"] }));
  return directory;
}
function evidence(projectPath, commands = [{ id: "unit", exitCode: 0, stdout: "ok\n", stderr: "" }]) { return { projectFingerprint: projectFingerprint(projectPath, loadTestDeclaration(projectPath)), commands }; }

test("passing structured test report is accepted and saved", () => { const p = makeContext(); try { const report = saveTestEvidence(p, evidence(p)); assert.ok(fs.existsSync(report)); assert.equal(verifyTestEvidence(p).status, "passed"); } finally { fs.rmSync(p, { recursive: true, force: true }); } });
test("failing command blocks the gate", () => { const p = makeContext(); try { saveTestEvidence(p, evidence(p, [{ id: "unit", exitCode: 1, stdout: "", stderr: "failed" }])); assert.deepEqual(verifyTestEvidence(p).status, "blocked"); } finally { fs.rmSync(p, { recursive: true, force: true }); } });
test("missing report and malformed report are rejected", () => { const p = makeContext(); try { assert.throws(() => verifyTestEvidence(p), (error) => code(error, "MISSING_TEST_EVIDENCE")); fs.mkdirSync(path.join(p, "out", "test_reports"), { recursive: true }); fs.writeFileSync(path.join(p, "out", "test_reports", "evidence.json"), "tests passed"); assert.throws(() => verifyTestEvidence(p), (error) => code(error, "MALFORMED_TEST_EVIDENCE")); } finally { fs.rmSync(p, { recursive: true, force: true }); } });
test("missing command, exit code, and required output block safely", () => { const p = makeContext(); try { saveTestEvidence(p, evidence(p, [])); assert.equal(verifyTestEvidence(p).reason, "required-command-missing"); saveTestEvidence(p, { projectFingerprint: projectFingerprint(p, loadTestDeclaration(p)), commands: [{ id: "unit", stdout: "x", stderr: "" }] }); assert.throws(() => verifyTestEvidence(p), (error) => code(error, "MALFORMED_TEST_EVIDENCE")); saveTestEvidence(p, evidence(p, [{ id: "unit", exitCode: 0, stdout: "", stderr: "" }])); assert.equal(verifyTestEvidence(p).reason, "required-output-missing"); } finally { fs.rmSync(p, { recursive: true, force: true }); } });
test("post-fix changes require retest", () => { const p = makeContext(); try { saveTestEvidence(p, evidence(p)); fs.writeFileSync(path.join(p, "source.txt"), "changed\n"); assert.equal(verifyTestEvidence(p).reason, "post-fix-retest-required"); } finally { fs.rmSync(p, { recursive: true, force: true }); } });
