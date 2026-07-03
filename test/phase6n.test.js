import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as pipeline from "../src/readonly-handoff-pipeline.js";
import * as step6L from "../src/brain-readonly-handoff.js";
import * as step6M from "../src/brain-provider-readonly-handoff.js";
import { HephaestusError } from "../src/errors.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_PATH = path.join(REPO_ROOT, "src/readonly-handoff-pipeline.js");
const HELPER_SOURCE = fs.readFileSync(HELPER_PATH, "utf8");

function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }
function temporaryDirectory() { return fs.mkdtempSync(path.join(REPO_ROOT, "test", "tmp-")); }

// === helper surface — only narrow safety utilities ===

test("shared helper exports only narrow safety/pipeline utilities", () => {
  assert.deepEqual(Object.keys(pipeline).sort(), [
    "AUTH_REQUIRED_PATTERNS",
    "CODEX_OUTCOMES",
    "FORBIDDEN_ARGV_TOKENS",
    "FORBIDDEN_SANDBOX_VALUES",
    "INTERACTIVE_PATTERNS",
    "OUTPUT_SUMMARY_LIMIT",
    "SAFE_ENVIRONMENT",
    "USAGE_LIMIT_PATTERNS",
    "classifyCodexOutcome",
    "diffSnapshots",
    "disallowedChanges",
    "runReadonlyCodex",
    "sha256Hex",
    "snapshotProjectFiles",
    "summarizeOutput",
    "writeAndReadBack"
  ]);
});

test("shared helper does NOT export prompt/decision/provider/argv-builder/CLASSIFICATIONS", () => {
  for (const name of [
    "buildPrompt", "buildDecision", "buildArgv", "assertArgvSafety",
    "CLASSIFICATIONS", "createProvider", "chooseProvider",
    "runRealGpt", "callOpenAi", "workspaceWrite"
  ]) assert.equal(name in pipeline, false, `helper must not export ${name}`);
});

test("shared helper source does NOT reference fetch, http, openai, network, or workspace-write", () => {
  // Callers of the helper are responsible for the workspace-write refusal list;
  // the helper only exports the constant *of forbidden* values, it never enables them.
  for (const forbidden of [
    "fetch(", "require(\"openai\"", "from \"openai\"", "require(\"http\"",
    "from \"node:http\"", "from \"node:https\"", "openai.com",
    "OPENAI_API_KEY", "process.env["
  ]) assert.equal(HELPER_SOURCE.includes(forbidden), false, `helper source must not contain: ${forbidden}`);
  // workspace-write appears only as a rejected token in the FORBIDDEN_SANDBOX_VALUES list
  // and (harmlessly) in the top-of-file comment that documents what the helper refuses.
  assert.ok(HELPER_SOURCE.includes(`FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write"`),
    "workspace-write must appear as a forbidden-sandbox token");
  const workspaceHits = HELPER_SOURCE.split("workspace-write").length - 1;
  assert.ok(workspaceHits <= 2, `workspace-write may only appear in FORBIDDEN_SANDBOX_VALUES (+optional header comment); got ${workspaceHits}`);
});

test("shared helper imports only fs/path/child_process/crypto/errors/agent-adapters — no network, no OpenAI SDK", () => {
  const importLines = HELPER_SOURCE.split("\n").filter((line) => line.startsWith("import "));
  for (const line of importLines) {
    assert.match(line, /"(node:child_process|node:crypto|node:fs|node:path|\.\/errors\.js|\.\/agent-adapters\.js)"/u,
      `unexpected import in shared helper: ${line}`);
  }
});

// === snapshotProjectFiles / diffSnapshots / disallowedChanges ===

test("snapshotProjectFiles walks recursively, skips .git and node_modules, and returns stable sha256 hashes", () => {
  const dir = temporaryDirectory();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "b.txt"), "bravo");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "MUST_BE_SKIPPED"), "x");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "MUST_BE_SKIPPED"), "y");
    const snap = pipeline.snapshotProjectFiles(dir);
    assert.deepEqual(Object.keys(snap).sort(), ["a.txt", "nested/b.txt"]);
    assert.equal(snap["a.txt"], pipeline.sha256Hex("alpha"));
    assert.equal(snap["nested/b.txt"], pipeline.sha256Hex("bravo"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("snapshotProjectFiles rejects empty/non-string root", () => {
  assert.throws(() => pipeline.snapshotProjectFiles(""), (err) => code(err, "INVALID_SNAPSHOT_ROOT"));
  assert.throws(() => pipeline.snapshotProjectFiles(null), (err) => code(err, "INVALID_SNAPSHOT_ROOT"));
});

test("diffSnapshots reports created / modified / removed relative paths, sorted", () => {
  const before = { "a": "1", "b": "2", "c": "3" };
  const after = { "a": "1", "b": "2b", "d": "4" };
  assert.deepEqual(pipeline.diffSnapshots(before, after), ["b", "c", "d"]);
});

test("disallowedChanges filters out allowed paths; empty result means only allowed paths changed", () => {
  const delta = ["AGENT_OUTPUT.md", "out/agent_outputs/x.json", "PLAN.md"];
  assert.deepEqual(
    pipeline.disallowedChanges(delta, ["AGENT_OUTPUT.md", "out/agent_outputs/x.json"]),
    ["PLAN.md"]
  );
  assert.deepEqual(pipeline.disallowedChanges(delta, new Set(delta)), []);
});

// === writeAndReadBack ===

test("writeAndReadBack writes utf8, reads back, hashes matching content", () => {
  const dir = temporaryDirectory();
  try {
    const target = path.join(dir, "sub", "file.txt");
    const result = pipeline.writeAndReadBack({ absolutePath: target, content: "hello\nworld\n" });
    assert.equal(result.ok, true);
    assert.equal(result.matches, true);
    assert.equal(result.hash, pipeline.sha256Hex("hello\nworld\n"));
    assert.equal(fs.readFileSync(target, "utf8"), "hello\nworld\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("writeAndReadBack rejects invalid inputs", () => {
  assert.throws(() => pipeline.writeAndReadBack({ absolutePath: "", content: "x" }), (err) => code(err, "INVALID_WRITE_PATH"));
  assert.throws(() => pipeline.writeAndReadBack({ absolutePath: "/tmp/x", content: 123 }), (err) => code(err, "INVALID_WRITE_CONTENT"));
});

// === runReadonlyCodex ===

test("runReadonlyCodex locks shell:false, closed stdin, reduced env {LANG,PATH}, killSignal:SIGTERM, timeoutMs", () => {
  let captured;
  const spawn = (exe, args, options) => {
    captured = { exe, args: [...args], shell: options.shell, cwd: options.cwd, timeout: options.timeout, killSignal: options.killSignal, input: options.input, env: options.env };
    return { status: 0, stdout: "MARKER-OK", stderr: "" };
  };
  const result = pipeline.runReadonlyCodex({
    argv: ["--sandbox", "read-only", "exec", "prompt"],
    projectPath: "/tmp/some-project",
    env: { PATH: "/usr/bin", OPENAI_API_KEY: "should-not-be-passed" },
    timeoutMs: 30_000,
    spawn,
    marker: "MARKER-OK"
  });
  assert.equal(captured.exe, "codex");
  assert.equal(captured.shell, false);
  assert.equal(captured.input, "");
  assert.equal(captured.killSignal, "SIGTERM");
  assert.equal(captured.timeout, 30_000);
  assert.equal(captured.cwd, "/tmp/some-project");
  assert.deepEqual(Object.keys(captured.env).sort(), ["LANG", "PATH"]);
  assert.equal(captured.env.LANG, "C.UTF-8");
  assert.equal(captured.env.PATH, "/usr/bin");
  assert.equal(result.markerInOutput, true);
  assert.equal(result.exitCode, 0);
});

test("runReadonlyCodex rejects malformed calls", () => {
  assert.throws(() => pipeline.runReadonlyCodex({ argv: [], projectPath: "/x", timeoutMs: 1, marker: "M" }), (err) => code(err, "INVALID_CODEX_ARGV"));
  assert.throws(() => pipeline.runReadonlyCodex({ argv: ["a"], projectPath: "", timeoutMs: 1, marker: "M" }), (err) => code(err, "INVALID_CODEX_CWD"));
  assert.throws(() => pipeline.runReadonlyCodex({ argv: ["a"], projectPath: "/x", timeoutMs: 0, marker: "M" }), (err) => code(err, "INVALID_CODEX_TIMEOUT"));
  assert.throws(() => pipeline.runReadonlyCodex({ argv: ["a"], projectPath: "/x", timeoutMs: 1, marker: "" }), (err) => code(err, "INVALID_CODEX_MARKER"));
});

// === classifyCodexOutcome ===

test("classifyCodexOutcome maps each observable outcome to a stable abstract code, null on clean exit=0", () => {
  const M = "MARKER";
  const mk = (over = {}) => ({ spawnError: null, errorCode: null, timedOut: false, exitCode: 0, stdout: "", stderr: "", combined: "", markerInOutput: false, ...over });
  assert.equal(pipeline.classifyCodexOutcome(mk({ errorCode: "ENOENT" })), pipeline.CODEX_OUTCOMES.NOT_INSTALLED);
  assert.equal(pipeline.classifyCodexOutcome(mk({ errorCode: "EACCES" })), pipeline.CODEX_OUTCOMES.NOT_INSTALLED);
  assert.equal(pipeline.classifyCodexOutcome(mk({ spawnError: new Error("x") })), pipeline.CODEX_OUTCOMES.NOT_INSTALLED);
  assert.equal(pipeline.classifyCodexOutcome(mk({ timedOut: true })), pipeline.CODEX_OUTCOMES.TIMEOUT);
  assert.equal(pipeline.classifyCodexOutcome(mk({ exitCode: 1, combined: "please sign in" })), pipeline.CODEX_OUTCOMES.AUTH);
  assert.equal(pipeline.classifyCodexOutcome(mk({ exitCode: 1, combined: "usage limit reached" })), pipeline.CODEX_OUTCOMES.USAGE_LIMIT);
  assert.equal(pipeline.classifyCodexOutcome(mk({ exitCode: 0, combined: "waiting for approval" })), pipeline.CODEX_OUTCOMES.INTERACTIVE);
  assert.equal(pipeline.classifyCodexOutcome(mk({ exitCode: 7, combined: "boom" })), pipeline.CODEX_OUTCOMES.CRASH);
  assert.equal(pipeline.classifyCodexOutcome(mk({ exitCode: 0, combined: `${M} ok` })), null);
});

// === Preserved behaviour — surface, markers, flags, classifications ===

test("Step 6L public surface unchanged after refactor", () => {
  assert.equal(step6L.STEP_6L_MARKER, "HEPHAESTUS_STEP_6L_MOCKED_BRAIN_HANDOFF_OK");
  assert.equal(step6L.CLASSIFICATIONS.PASS, "STEP_6L_PASS");
  assert.equal(step6L.STEP_6L_FLAGS.shell, false);
  assert.equal(step6L.STEP_6L_FLAGS.sandbox, "read-only");
  assert.equal(step6L.STEP_6L_FLAGS.askForApproval, "never");
  assert.equal(typeof step6L.runActivationMockedBrainReadonlyHandoff, "function");
  assert.equal(typeof step6L.buildMockedBrainDecision, "function");
  assert.equal(typeof step6L.buildStep6lPrompt, "function");
  assert.equal(typeof step6L.buildStep6lArgv, "function");
  assert.equal(typeof step6L.parseStep6lReport, "function");
});

test("Step 6M public surface unchanged after refactor", () => {
  assert.equal(step6M.STEP_6M_MARKER, "HEPHAESTUS_STEP_6M_PROVIDER_BRAIN_HANDOFF_OK");
  assert.equal(step6M.CLASSIFICATIONS.PASS, "STEP_6M_PASS");
  assert.equal(step6M.STEP_6M_FLAGS.shell, false);
  assert.equal(step6M.STEP_6M_FLAGS.sandbox, "read-only");
  assert.equal(step6M.STEP_6M_FLAGS.askForApproval, "never");
  assert.equal(step6M.STEP_6M_PROVIDER, "mocked-readonly");
  assert.equal(typeof step6M.runActivationProviderBrainReadonlyHandoff, "function");
  assert.equal(typeof step6M.buildStep6mPrompt, "function");
  assert.equal(typeof step6M.buildStep6mArgv, "function");
  assert.equal(typeof step6M.parseStep6mReport, "function");
});

test("Step 6L and Step 6M each use the shared helper (import shows up in the source)", () => {
  for (const relative of ["src/brain-readonly-handoff.js", "src/brain-provider-readonly-handoff.js"]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    assert.match(src, /from "\.\/readonly-handoff-pipeline\.js"/u, `${relative} must import from readonly-handoff-pipeline`);
  }
});
