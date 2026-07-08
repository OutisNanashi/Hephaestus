import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import {
  assertFactoryArgvSafety,
  buildFactoryDroidExecArgv,
  DEFAULT_ARTIFACT_PATH,
  FACTORY_DROID_CLASSIFICATIONS,
  runFactoryDroidWorkspaceExec
} from "../src/agent-factory-droid-workspace-exec.js";
import { getProviderAdapter, isProviderLiveExecutable } from "../src/provider-adapters.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const PROMPT_TEXT = "# Task\nDo the Factory demo mission.\n";

function makeProject() {
  const directory = writableTemporaryDirectory("hephaestus-factory-exec-");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(path.join(project, "out", "prompts"), { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) {
    fs.writeFileSync(path.join(project, name), `${name} fixture\n`);
  }
  fs.writeFileSync(path.join(project, "out", "prompts", "next-task.md"), PROMPT_TEXT);
  return { directory, root, project };
}

function cleanup(context) { fs.rmSync(context.directory, { recursive: true, force: true }); }

// Records every call so tests can prove no real binary is ever invoked.
function fakeSpawn(result, capture = {}) {
  return (executable, args, options) => {
    capture.executable = executable;
    capture.args = [...args];
    capture.options = options;
    capture.calls = (capture.calls ?? 0) + 1;
    if (typeof result === "function") return result(executable, args, options);
    return { status: 0, stdout: "", stderr: "", ...result };
  };
}

function execRequest(context, overrides = {}) {
  return {
    adapterId: "factory-droid",
    allowedRoot: context.root,
    projectPath: context.project,
    projectId: "demo",
    promptPath: "out/prompts/next-task.md",
    explicitFactoryExecutionPermit: true,
    now: () => "2026-07-09T12:00:00.000Z",
    ...overrides
  };
}

function code(error, expected) {
  assert.ok(error instanceof HephaestusError, `expected HephaestusError, got ${error}`);
  assert.equal(error.code, expected);
  return true;
}

test("planned argv is a safe headless non-interactive command delivering the prompt by file", () => {
  const argv = buildFactoryDroidExecArgv({ promptFilePath: "/p/demo/out/prompts/next-task.md", artifactPath: DEFAULT_ARTIFACT_PATH });
  assert.deepEqual([...argv], [
    "exec", "--headless", "--non-interactive", "--output-format", "json",
    "--prompt-file", "/p/demo/out/prompts/next-task.md", "--artifact-out", DEFAULT_ARTIFACT_PATH
  ]);
  assert.doesNotThrow(() => assertFactoryArgvSafety(argv));
});

test("argv safety rejects dangerous auto/push/merge flags", () => {
  for (const bad of ["--auto", "--yes", "--push", "--merge", "--commit", "--force", "--no-sandbox", "--dangerously-bypass-approvals"]) {
    assert.throws(() => assertFactoryArgvSafety(["exec", bad, "--prompt-file", "p"]), (error) => code(error, "INVALID_FACTORY_EXEC_ARGV"));
  }
  assert.throws(() => assertFactoryArgvSafety(["--headless", "exec"]), (error) => code(error, "INVALID_FACTORY_EXEC_ARGV"));
});

test("mock execution builds the intended safe command and uses only the injected spawn", () => {
  const context = makeProject();
  const capture = {};
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: '{"status":"completed","session_id":"mission-abc123"}\n', stderr: "" }, capture)
    }));
    // (1) injected spawn used, for the planned safe command only, shell:false, cwd = project.
    assert.equal(capture.calls, 1);
    assert.equal(capture.executable, "droid");
    assert.deepEqual(capture.args.slice(0, 5), ["exec", "--headless", "--non-interactive", "--output-format", "json"]);
    assert.ok(capture.args.includes("--prompt-file"));
    assert.equal(capture.options.shell, false);
    assert.equal(capture.options.cwd, fs.realpathSync(context.project));
    assert.equal(capture.options.input, "");
    // Safe env only: no API keys/tokens forwarded.
    assert.deepEqual(Object.keys(capture.options.env).sort().filter((k) => !["LANG", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "FACTORY_HOME", "DROID_HOME"].includes(k)), []);
    assert.equal(result.executed, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.mode, "mock-dry-run");
    assert.deepEqual([...result.plannedArgv].slice(0, 3), ["exec", "--headless", "--non-interactive"]);
  } finally { cleanup(context); }
});

test("mock execution captures stdout, stderr, exit code, session id, and artifacts", () => {
  const context = makeProject();
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: 'mission complete\nsession_id: sess-42\nartifact: out/factory/mission.json\n', stderr: "warning: slow\n" })
    }));
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /mission complete/u);
    assert.match(result.stderr, /warning: slow/u);
    assert.equal(result.sessionId, "sess-42");
    assert.deepEqual(result.artifacts, ["out/factory/mission.json"]);
  } finally { cleanup(context); }
});

test("mock execution classifies completed / blocked / failed / usage-limit / malformed", () => {
  const context = makeProject();
  try {
    const completed = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 0, stdout: '{"status":"completed","mission_id":"m1"}' }) }));
    assert.equal(completed.classification, FACTORY_DROID_CLASSIFICATIONS.COMPLETED);
    assert.equal(completed.status, "completed");

    const blocked = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 0, stdout: "BLOCKED: waiting for owner decision" }) }));
    assert.equal(blocked.classification, FACTORY_DROID_CLASSIFICATIONS.BLOCKED);
    assert.equal(blocked.blockerDetected, true);

    const failed = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 3, stdout: "session_id: s1\n", stderr: "boom" }) }));
    assert.equal(failed.classification, FACTORY_DROID_CLASSIFICATIONS.FAILED);

    const usage = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 1, stderr: "You have hit your usage limit. Try again at 8:00 PM UTC." }) }));
    assert.equal(usage.classification, FACTORY_DROID_CLASSIFICATIONS.USAGE_LIMIT);
    assert.equal(usage.status, "paused");
    assert.equal(usage.retryAfter, "8:00 PM UTC");

    const malformed = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 0, stdout: "unstructured output with no markers" }) }));
    assert.equal(malformed.classification, FACTORY_DROID_CLASSIFICATIONS.MALFORMED_OUTPUT);

    const empty = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 0, stdout: "" }) }));
    assert.equal(empty.classification, FACTORY_DROID_CLASSIFICATIONS.MALFORMED_OUTPUT);
  } finally { cleanup(context); }
});

test("mock execution redacts secret-like output", () => {
  const context = makeProject();
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: 'session_id: s9\nFACTORY_TOKEN=sk-abcdefghijklmnop123456\nghp_ABCDEFGHIJKLMNOPQRST\n' })
    }));
    assert.equal(/sk-[A-Za-z0-9]/u.test(JSON.stringify(result)), false);
    assert.equal(/ghp_[A-Za-z0-9]/u.test(JSON.stringify(result)), false);
    assert.match(result.stdout, /\[REDACTED\]/u);
  } finally { cleanup(context); }
});

test("mock execution rejects unsafe project and prompt paths without spawning", () => {
  const context = makeProject();
  let spawned = false;
  const spawn = () => { spawned = true; return { status: 0, stdout: "" }; };
  try {
    // Project path outside the allowed root.
    assert.throws(
      () => runFactoryDroidWorkspaceExec(execRequest(context, { projectPath: path.join(context.directory, "outside"), spawn })),
      (error) => error instanceof HephaestusError
    );
    // Prompt path traversal.
    assert.throws(
      () => runFactoryDroidWorkspaceExec(execRequest(context, { promptPath: "../../etc/passwd", spawn })),
      (error) => code(error, "INVALID_AGENT_PROMPT_PATH")
    );
    // Artifact path traversal.
    assert.throws(
      () => runFactoryDroidWorkspaceExec(execRequest(context, { artifactPath: "../escape.json", spawn })),
      (error) => code(error, "INVALID_FACTORY_EXEC_ARTIFACT_PATH")
    );
    assert.equal(spawned, false, "unsafe requests must be rejected before any spawn");
  } finally { cleanup(context); }
});

test("without an explicit permit or an injected spawn, no process runs and it reports provider-not-enabled", () => {
  const context = makeProject();
  let spawned = false;
  const spawn = () => { spawned = true; return { status: 0, stdout: "session_id: s" }; };
  try {
    // No permit: refuses, still returns the planned argv for inspection, spawns nothing.
    const noPermit = runFactoryDroidWorkspaceExec(execRequest(context, { explicitFactoryExecutionPermit: false, spawn }));
    assert.equal(noPermit.executed, false);
    assert.equal(noPermit.classification, FACTORY_DROID_CLASSIFICATIONS.PROVIDER_NOT_ENABLED);
    assert.equal(noPermit.reason, "execution-not-permitted");
    assert.ok(Array.isArray(noPermit.plannedArgv));

    // Permit but no spawn: there is no real runner, so it refuses (never invokes droid).
    const noSpawn = runFactoryDroidWorkspaceExec(execRequest(context));
    assert.equal(noSpawn.executed, false);
    assert.equal(noSpawn.classification, FACTORY_DROID_CLASSIFICATIONS.PROVIDER_NOT_ENABLED);
    assert.equal(noSpawn.reason, "mock-spawn-required");
    assert.equal(spawned, false);
  } finally { cleanup(context); }
});

test("Factory adapter runTask still refuses and the provider stays non-live-executable even if config enables it", () => {
  const adapter = getProviderAdapter("factory-droid");
  const refusal = adapter.runTask({});
  assert.equal(refusal.executed, false);
  assert.equal(refusal.classification, "PROVIDER_NOT_ENABLED");
  assert.equal(adapter.liveExecutable, false);

  const factoryOn = { providers: { "factory-droid": { enabled: true, executionEnabled: true } } };
  assert.equal(isProviderLiveExecutable("factory-droid", factoryOn), false);
  assert.equal(isProviderLiveExecutable("codex"), true, "Codex behavior is unchanged");
});
