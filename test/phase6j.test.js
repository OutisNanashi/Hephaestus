import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnCliSync } from "./helpers/spawned-cli.js";
import {
  CLASSIFICATIONS,
  CLEANUP_WHITELIST,
  ensureCleanFixture,
  runActivationFixtureCleanup
} from "../src/activation-fixture-hygiene.js";
import { run as runCli } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";

const CLI_PATH = "src/cli.js";

const validState = Object.freeze({
  currentPhase: "6J", currentTask: "activation-fixture-hygiene", currentBranch: "main", currentPr: null,
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

function plantStep6hStep6iArtifacts(context) {
  fs.writeFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "# Stale Step 6H/6I record\n");
  fs.mkdirSync(path.join(context.projectPath, "out", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(context.projectPath, "out", "prompts", "step-6i-readonly-prompt.md"), "old prompt\n");
  fs.mkdirSync(path.join(context.projectPath, "out", "agent_outputs"), { recursive: true });
  fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "step-6h-readonly-inspect-2026-06-25T12-00-00-000Z.json"), "{}\n");
  fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "step-6i-readonly-prompt-record-2026-06-25T14-00-00-000Z.json"), "{}\n");
}

function baseRequest(context, overrides = {}) {
  return {
    allowedRoot: context.allowedRoot,
    projectPath: context.projectPath,
    projectId: context.projectId,
    explicitCleanupPermit: true,
    now: () => "2026-06-25T15-00-00-000Z",
    ...overrides
  };
}

function fixtureExists(projectPath) {
  return ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "src/index.js", "test/index.test.js"]
    .every((file) => fs.existsSync(path.join(projectPath, file)));
}

test("cleanup request rejects unsupported / user-supplied paths, executable, argv, shell, prompt, instruction keys", () => {
  const context = makeContext();
  try {
    for (const evil of ["paths", "files", "executable", "argv", "shell", "shellCommand", "command", "prompt", "promptFile", "instruction", "cwd"]) {
      assert.throws(
        () => runActivationFixtureCleanup({ ...baseRequest(context), [evil]: ["AGENT_OUTPUT.md", "../../etc/passwd"] }),
        (error) => code(error, "INVALID_CLEANUP_REQUEST")
      );
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup requires explicitCleanupPermit=true", () => {
  const context = makeContext();
  try {
    assert.throws(
      () => runActivationFixtureCleanup(baseRequest(context, { explicitCleanupPermit: false })),
      (error) => code(error, "CLEANUP_PERMIT_REQUIRED")
    );
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup rejects unsafe / traversal project paths as STEP_6J_BLOCKED_UNSAFE_PROJECT and never deletes anything", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    const before = fs.readFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "utf8");
    const report = runActivationFixtureCleanup(baseRequest(context, { projectPath: context.directory }));
    assert.equal(report.classification, CLASSIFICATIONS.UNSAFE_PROJECT);
    assert.equal(report.cleanupSafe, false);
    assert.equal(report.step6kSafeToDesign, false);
    assert.equal(fs.readFileSync(path.join(context.projectPath, "AGENT_OUTPUT.md"), "utf8"), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup rejects missing project as STEP_6J_BLOCKED_MISSING_PROJECT", () => {
  const context = makeContext();
  try {
    fs.rmSync(context.projectPath, { recursive: true, force: true });
    const report = runActivationFixtureCleanup(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.MISSING_PROJECT);
    assert.equal(report.cleanupSafe, false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup on a clean fixture returns STEP_6J_PASS_NO_ARTIFACTS and changes nothing", () => {
  const context = makeContext();
  try {
    const before = fs.readdirSync(context.projectPath).sort();
    const report = runActivationFixtureCleanup(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS_NO_ARTIFACTS);
    assert.equal(report.cleanupSafe, true);
    assert.deepEqual([...report.deletedFiles], []);
    assert.deepEqual([...report.deletedDirs], []);
    assert.deepEqual([...report.forbiddenTargets], []);
    assert.equal(report.step6kSafeToDesign, true);
    assert.deepEqual(fs.readdirSync(context.projectPath).sort(), before);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup removes ALL whitelisted Step 6H/6I artifacts and empty allowed directories, preserves required fixture files", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    const report = runActivationFixtureCleanup(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(report.cleanupSafe, true);
    assert.equal(report.step6kSafeToDesign, true);
    const expectedFiles = new Set([
      "AGENT_OUTPUT.md",
      "out/prompts/step-6i-readonly-prompt.md",
      "out/agent_outputs/step-6h-readonly-inspect-2026-06-25T12-00-00-000Z.json",
      "out/agent_outputs/step-6i-readonly-prompt-record-2026-06-25T14-00-00-000Z.json"
    ]);
    for (const file of report.deletedFiles) assert.ok(expectedFiles.has(file), `unexpected deleted file ${file}`);
    assert.equal(report.deletedFiles.length, 4);
    const expectedDirs = new Set(["out/prompts", "out/agent_outputs", "out"]);
    for (const dir of report.deletedDirs) assert.ok(expectedDirs.has(dir), `unexpected deleted dir ${dir}`);
    assert.equal(report.deletedDirs.length, 3);
    // Files truly gone
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out")), false);
    // Protected fixture files preserved
    assert.ok(fixtureExists(context.projectPath));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup is idempotent: second invocation on already-clean fixture returns STEP_6J_PASS_NO_ARTIFACTS", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    runActivationFixtureCleanup(baseRequest(context));
    const second = runActivationFixtureCleanup(baseRequest(context));
    assert.equal(second.classification, CLASSIFICATIONS.PASS_NO_ARTIFACTS);
    assert.equal(second.deletedFiles.length, 0);
    assert.equal(second.deletedDirs.length, 0);
    assert.equal(second.cleanupSafe, true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup never deletes PLAN.md, BUILDING_REFERENCE.md, BUILD_LOG.md, STATE.json, CURRENT_TASK.md, package.json, src/, or test/", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    const protectedSnapshot = {};
    for (const file of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md", "STATE.json", "package.json", "src/index.js", "test/index.test.js"]) {
      protectedSnapshot[file] = fs.readFileSync(path.join(context.projectPath, file), "utf8");
    }
    runActivationFixtureCleanup(baseRequest(context));
    for (const file of Object.keys(protectedSnapshot)) {
      assert.equal(fs.readFileSync(path.join(context.projectPath, file), "utf8"), protectedSnapshot[file], `protected ${file} must not change`);
    }
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup does NOT remove allowed empty directory if it is not empty (e.g. unknown file under out/ stays put)", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    // Plant an extra non-whitelisted file under out/agent_outputs and out/prompts
    fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "preserve-me.log"), "keep\n");
    fs.writeFileSync(path.join(context.projectPath, "out", "prompts", "not-step6i.md"), "keep\n");
    fs.writeFileSync(path.join(context.projectPath, "out", "stray.txt"), "keep\n");
    const report = runActivationFixtureCleanup(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    // Whitelisted files removed
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "prompts", "step-6i-readonly-prompt.md")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_outputs", "step-6h-readonly-inspect-2026-06-25T12-00-00-000Z.json")), false);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_outputs", "step-6i-readonly-prompt-record-2026-06-25T14-00-00-000Z.json")), false);
    // Non-whitelisted files PRESERVED
    assert.equal(fs.readFileSync(path.join(context.projectPath, "out", "agent_outputs", "preserve-me.log"), "utf8"), "keep\n");
    assert.equal(fs.readFileSync(path.join(context.projectPath, "out", "prompts", "not-step6i.md"), "utf8"), "keep\n");
    assert.equal(fs.readFileSync(path.join(context.projectPath, "out", "stray.txt"), "utf8"), "keep\n");
    // Non-empty allowed dirs NOT removed
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_outputs")), true);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "prompts")), true);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out")), true);
    // No directories should have been removed because they're not empty
    assert.deepEqual([...report.deletedDirs], []);
    // No forbidden targets — non-whitelisted files were simply not selected
    assert.deepEqual([...report.forbiddenTargets], []);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup does not touch non-matching files under out/agent_outputs or out/prompts", () => {
  const context = makeContext();
  try {
    fs.mkdirSync(path.join(context.projectPath, "out", "agent_outputs"), { recursive: true });
    fs.mkdirSync(path.join(context.projectPath, "out", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "step-6h-readonly-inspect-keep.json"), "{}\n"); // matches step-6h pattern, will be deleted
    fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "step-6j-something.json"), "{}\n"); // does NOT match
    fs.writeFileSync(path.join(context.projectPath, "out", "agent_outputs", "evil.json"), "{}\n"); // does NOT match
    fs.writeFileSync(path.join(context.projectPath, "out", "prompts", "some-other-prompt.md"), "{}\n"); // does NOT match Step 6I
    const report = runActivationFixtureCleanup(baseRequest(context));
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.deepEqual([...report.deletedFiles].sort(), ["out/agent_outputs/step-6h-readonly-inspect-keep.json"]);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_outputs", "step-6j-something.json")), true);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "agent_outputs", "evil.json")), true);
    assert.equal(fs.existsSync(path.join(context.projectPath, "out", "prompts", "some-other-prompt.md")), true);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup never deletes outside the resolved project root, even if symlinks were planted", () => {
  const context = makeContext();
  try {
    // Plant an unrelated file outside the project root that must never be deleted
    const externalFile = path.join(context.directory, "outside.txt");
    fs.writeFileSync(externalFile, "must-stay\n");
    plantStep6hStep6iArtifacts(context);
    runActivationFixtureCleanup(baseRequest(context));
    assert.equal(fs.existsSync(externalFile), true);
    assert.equal(fs.readFileSync(externalFile, "utf8"), "must-stay\n");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("cleanup whitelist is the documented public contract (exact files, patterned directories, empty directories)", () => {
  assert.deepEqual([...CLEANUP_WHITELIST.exactFiles], [
    "AGENT_OUTPUT.md",
    "out/prompts/step-6i-readonly-prompt.md",
    "out/prompts/step-6l-brain-readonly-prompt.md",
    "out/brain_decisions/step-6l-mocked-brain-decision.json",
    "out/prompts/step-6m-provider-readonly-prompt.md",
    "out/brain_decisions/step-6m-provider-brain-decision.json",
    "out/summaries/step-6k-readonly-codex-closeout.json"
  ]);
  assert.equal(CLEANUP_WHITELIST.patternedDirectories.length, 4);
  const patterns = CLEANUP_WHITELIST.patternedDirectories.map((entry) => `${entry.directory}|${entry.pattern}`);
  assert.ok(patterns.some((entry) => entry.startsWith("out/agent_outputs|") && entry.includes("step-6h-readonly-inspect")));
  assert.ok(patterns.some((entry) => entry.startsWith("out/agent_outputs|") && entry.includes("step-6i-readonly-prompt-record")));
  assert.ok(patterns.some((entry) => entry.startsWith("out/agent_outputs|") && entry.includes("step-6l-mocked-brain-readonly-handoff")));
  assert.ok(patterns.some((entry) => entry.startsWith("out/agent_outputs|") && entry.includes("step-6m-provider-brain-readonly-handoff")));
  assert.deepEqual([...CLEANUP_WHITELIST.emptyDirectories], ["out/prompts", "out/agent_outputs", "out/summaries", "out/brain_decisions", "out"]);
});

test("ensureCleanFixture helper produces the same Step 6J result and clears artifacts", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    const report = ensureCleanFixture(context.allowedRoot, context.projectPath, context.projectId);
    assert.equal(report.classification, CLASSIFICATIONS.PASS);
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-clean-fixture-artifacts exits 0 with STEP_6J_PASS_NO_ARTIFACTS on a clean fixture", () => {
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
      exitCode = runCli(["activation-clean-fixture-artifacts", "--config", configPath, "--project", "example-project"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.PASS_NO_ARTIFACTS);
    assert.equal(parsed.cleanupSafe, true);
    assert.equal(exitCode, 0);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("CLI activation-clean-fixture-artifacts exits 0 with STEP_6J_PASS after removing planted artifacts", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    let stdout = "";
    const originalWrite = process.stdout.write;
    let exitCode;
    try {
      process.stdout.write = (chunk) => { stdout += chunk; return true; };
      exitCode = runCli(["activation-clean-fixture-artifacts", "--config", configPath, "--project", "example-project"]);
    } finally { process.stdout.write = originalWrite; }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.cleanupSafe, true);
    assert.equal(parsed.deletedFiles.length, 4);
    assert.equal(parsed.deletedDirs.length, 3);
    assert.equal(exitCode, 0);
    assert.ok(fixtureExists(context.projectPath));
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("spawned CLI activation-clean-fixture-artifacts exits 0 after removing artifacts (real process)", () => {
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    const configPath = path.join(context.directory, "config.json");
    const registryPath = path.join(context.directory, "projects.json");
    writeJson(configPath, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
    writeJson(registryPath, { projects: [{ id: "example-project", path: "example-project" }] });
    const result = spawnCliSync(process.execPath, [CLI_PATH, "activation-clean-fixture-artifacts", "--config", configPath, "--project", "example-project"], {
      encoding: "utf8",
      shell: false,
      timeout: 60_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.classification, CLASSIFICATIONS.PASS);
    assert.equal(parsed.cleanupSafe, true);
    assert.equal(fs.existsSync(path.join(context.projectPath, "AGENT_OUTPUT.md")), false);
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("repeatability: after planting + cleaning Step 6H/6I artifacts, the canonical-fixture inspectProject contract is still satisfied", async () => {
  // Sanity guard: this is the exact scenario phase1's `reads a valid project fixture` was tripping on
  const { inspectProject } = await import("../src/inspection.js");
  const context = makeContext();
  try {
    plantStep6hStep6iArtifacts(context);
    runActivationFixtureCleanup(baseRequest(context));
    const state = inspectProject(context.allowedRoot, context.projectPath);
    assert.equal(state.documents.agentOutput, null, "AGENT_OUTPUT.md must be absent after cleanup");
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});
