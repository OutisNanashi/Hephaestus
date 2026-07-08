import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import { describeProviderReadiness, projectProviderStatus, projectProviderStatuses } from "../src/provider-status.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }
function capture(action) {
  let output = ""; const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try { action(); } finally { process.stdout.write = original; }
  return output;
}

const baseState = Object.freeze({
  currentPhase: "9", currentTask: "providers", currentBranch: "main", currentPr: null, assignedAgent: null,
  attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null,
  mergeStatus: "not-started", containerStatus: "healthy", lastGptDecision: null, nextAction: "project-idle"
});

function makeProject(root, id) {
  const project = path.join(root, id);
  fs.mkdirSync(project, { recursive: true });
  for (const file of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, file), `${id}\n`);
  writeJson(path.join(project, "STATE.json"), baseState);
  return project;
}

// A registry context with a codex-default project, an explicit codex project, and a factory-droid project.
function context(projectsOverride) {
  const directory = writableTemporaryDirectory("hephaestus-providers-");
  const root = path.join(directory, "projects");
  for (const id of ["defaulted", "codexy", "factoryish"]) makeProject(root, id);
  const registry = path.join(directory, "projects.json");
  writeJson(registry, { projects: projectsOverride ?? [
    { id: "defaulted", path: "defaulted" },
    { id: "codexy", path: "codexy", provider: "codex" },
    { id: "factoryish", path: "factoryish", provider: "factory-droid" }
  ] });
  const config = path.join(directory, "config.json");
  writeJson(config, { allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" });
  return { directory, root, registry, config };
}

test("describeProviderReadiness distinguishes known, preflight-supported, and live-executable", () => {
  const codex = describeProviderReadiness("codex");
  assert.deepEqual(codex, { known: true, preflightSupported: true, liveExecutable: true, reason: null });

  const factory = describeProviderReadiness("factory-droid");
  assert.equal(factory.known, true);
  assert.equal(factory.preflightSupported, true);
  assert.equal(factory.liveExecutable, false);
  assert.equal(factory.reason, "not-live-executable-capability");

  const unknown = describeProviderReadiness("devin");
  assert.deepEqual(unknown, { known: false, preflightSupported: false, liveExecutable: false, reason: "unknown-provider" });

  // Config that disables Codex live execution reports disabled-by-config, not a capability gap.
  const codexOff = describeProviderReadiness("codex", { config: { providers: { codex: { executionEnabled: false } } } });
  assert.equal(codexOff.liveExecutable, false);
  assert.equal(codexOff.reason, "disabled-by-config");
});

test("projectProviderStatus reports declared vs defaulted providers without spawning", () => {
  const defaulted = projectProviderStatus({ id: "d", path: "/p/d", provider: "codex", providerDeclared: false });
  assert.equal(defaulted.provider, "codex");
  assert.equal(defaulted.declaredProvider, null);
  assert.equal(defaulted.defaulted, true);
  assert.equal(defaulted.liveExecutable, true);
  assert.equal(defaulted.preflight, undefined, "ordinary status must not include a preflight probe");

  const explicit = projectProviderStatus({ id: "c", path: "/p/c", provider: "codex", providerDeclared: true });
  assert.equal(explicit.declaredProvider, "codex");
  assert.equal(explicit.defaulted, false);

  const factory = projectProviderStatus({ id: "f", path: "/p/f", provider: "factory-droid", providerDeclared: true });
  assert.equal(factory.known, true);
  assert.equal(factory.preflightSupported, true);
  assert.equal(factory.liveExecutable, false);
  assert.equal(factory.reason, "not-live-executable-capability");
});

test("projectProviderStatus preflight uses injected spawn and redacts secrets; never runs real droid", () => {
  let realBinaryInvoked = false;
  const spawn = (executable, args) => {
    if (executable === "droid" && args.includes("--version")) {
      return { status: 0, stdout: "droid 2.4.1\nFACTORY_TOKEN=sk-abcdefghijklmnop123456\n", stderr: "" };
    }
    realBinaryInvoked = true; // any other call would mean a real probe
    return { status: 127, stdout: "", stderr: "" };
  };
  const factory = projectProviderStatus(
    { id: "f", path: "/p/f", provider: "factory-droid", providerDeclared: true },
    { preflight: true, env: { PATH: "/usr/bin" }, spawn }
  );
  assert.equal(realBinaryInvoked, false);
  assert.ok(factory.preflight);
  assert.equal(factory.preflight.available, true);
  assert.equal(factory.preflight.reason, "version-detected");
  assert.equal(factory.preflight.promptSent, false);
  // No secret-like token survives into the status output.
  assert.equal(/sk-[A-Za-z0-9]/u.test(JSON.stringify(factory)), false);
});

test("projectProviderStatuses is deterministic and sorted by id", () => {
  const rows = projectProviderStatuses([
    { id: "zeta", path: "/z", provider: "codex", providerDeclared: false },
    { id: "alpha", path: "/a", provider: "factory-droid", providerDeclared: true }
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["alpha", "zeta"]);
});

test("status --providers reports each project's provider readiness read-only and spawns nothing", () => {
  const c = context();
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("status must not contact external services"); };
  try {
    const before = fs.readdirSync(c.root, { recursive: true }).sort();
    const output = capture(() => assert.equal(run(["status", "--providers", "--config", c.config]), 0));
    const result = JSON.parse(output);
    assert.equal(result.mode, "read-only-providers");
    const byId = Object.fromEntries(result.providers.map((row) => [row.id, row]));

    assert.equal(byId.defaulted.provider, "codex");
    assert.equal(byId.defaulted.defaulted, true);
    assert.equal(byId.defaulted.declaredProvider, null);
    assert.equal(byId.defaulted.liveExecutable, true);

    assert.equal(byId.codexy.declaredProvider, "codex");
    assert.equal(byId.codexy.liveExecutable, true);

    assert.equal(byId.factoryish.provider, "factory-droid");
    assert.equal(byId.factoryish.known, true);
    assert.equal(byId.factoryish.preflightSupported, true);
    assert.equal(byId.factoryish.liveExecutable, false);
    assert.equal(byId.factoryish.reason, "not-live-executable-capability");

    // No preflight key, no file writes, no network.
    assert.ok(result.providers.every((row) => row.preflight === undefined));
    assert.deepEqual(fs.readdirSync(c.root, { recursive: true }).sort(), before);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(c.directory, { recursive: true, force: true });
  }
});

test("status --providers rejects a registry declaring an unknown provider", () => {
  const c = context([{ id: "defaulted", path: "defaulted", provider: "devin" }]);
  try {
    assert.throws(() => run(["status", "--providers", "--config", c.config]), (error) => code(error, "INVALID_MULTI_PROJECT_REGISTRY"));
  } finally { fs.rmSync(c.directory, { recursive: true, force: true }); }
});

test("--providers and --preflight flags are scoped to status", () => {
  assert.throws(() => run(["run-live", "--providers", "--project", "x"]), (error) => code(error, "INVALID_ARGUMENT"));
  assert.throws(() => run(["status", "--preflight"]), (error) => code(error, "INVALID_ARGUMENT"));
});
