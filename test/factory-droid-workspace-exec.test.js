import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import {
  assertFactoryArgvSafety,
  buildFactoryDroidExecArgv,
  FACTORY_DROID_CLASSIFICATIONS,
  FACTORY_DROID_EXEC_FLAGS,
  FACTORY_DROID_JSON_FIELDS,
  runFactoryDroidWorkspaceExec
} from "../src/agent-factory-droid-workspace-exec.js";
import { getProviderAdapter, isProviderLiveExecutable } from "../src/provider-adapters.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "factory-droid");
function fixture(name) { return fs.readFileSync(path.join(FIXTURES, name), "utf8"); }

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

test("verified planned argv is `droid exec --output-format json --auto low --cwd <p> -f <prompt>`", () => {
  const argv = buildFactoryDroidExecArgv({ promptFilePath: "/p/demo/out/prompts/next-task.md", projectPath: "/p/demo" });
  assert.deepEqual([...argv], [
    "exec", "--output-format", "json", "--auto", "low", "--cwd", "/p/demo", "-f", "/p/demo/out/prompts/next-task.md"
  ]);
  assert.doesNotThrow(() => assertFactoryArgvSafety(argv));
  assert.equal(FACTORY_DROID_EXEC_FLAGS.autonomy, "low");
  assert.deepEqual([...FACTORY_DROID_JSON_FIELDS], ["type", "subtype", "is_error", "duration_ms", "num_turns", "result", "session_id"]);
});

test("argv safety rejects the unsafe permission bypass and any autonomy above low", () => {
  assert.throws(() => assertFactoryArgvSafety(["exec", "--skip-permissions-unsafe", "-f", "p"]), (error) => code(error, "INVALID_FACTORY_EXEC_ARGV"));
  assert.throws(() => assertFactoryArgvSafety(["exec", "--auto", "high", "-f", "p"]), (error) => code(error, "INVALID_FACTORY_EXEC_ARGV"));
  assert.throws(() => assertFactoryArgvSafety(["exec", "--auto", "medium", "-f", "p"]), (error) => code(error, "INVALID_FACTORY_EXEC_ARGV"));
  assert.throws(() => assertFactoryArgvSafety(["--auto", "low", "exec"]), (error) => code(error, "INVALID_FACTORY_EXEC_ARGV"));
});

test("mock execution builds the verified command and uses only the injected spawn", () => {
  const context = makeProject();
  const capture = {};
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: fixture("exec-success.json"), stderr: "" }, capture)
    }));
    assert.equal(capture.calls, 1);
    assert.equal(capture.executable, "droid");
    assert.deepEqual(capture.args.slice(0, 5), ["exec", "--output-format", "json", "--auto", "low"]);
    assert.equal(capture.args.at(-2), "-f");
    assert.equal(capture.args[capture.args.indexOf("--cwd") + 1], fs.realpathSync(context.project));
    assert.equal(capture.options.shell, false);
    assert.equal(capture.options.cwd, fs.realpathSync(context.project));
    assert.equal(capture.options.input, "");
    // No FACTORY_API_KEY (or any non-allowlisted var) is ever forwarded.
    assert.equal("FACTORY_API_KEY" in capture.options.env, false);
    assert.deepEqual(Object.keys(capture.options.env).filter((k) => !["LANG", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(k)), []);
    assert.equal(result.mode, "mock-dry-run");
    assert.equal(result.invocation.autonomy, "low");
    assert.match(result.invocation.gitAutonomy, /no commit\/push\/merge/u);
  } finally { cleanup(context); }
});

test("verified JSON output is parsed: session id, result, and success classification from fixture", () => {
  const context = makeProject();
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: fixture("exec-success.json"), stderr: "" })
    }));
    assert.equal(result.classification, FACTORY_DROID_CLASSIFICATIONS.COMPLETED);
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "01JQ9F5X2K7M3B8N4T6V0WYZ12");
    assert.equal(result.isError, false);
    assert.match(result.result, /Updated the README/u);
  } finally { cleanup(context); }
});

test("is_error:true in the documented JSON is a failure even at exit 0", () => {
  const context = makeProject();
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: fixture("exec-error.json"), stderr: "" })
    }));
    assert.equal(result.classification, FACTORY_DROID_CLASSIFICATIONS.FAILED);
    assert.equal(result.sessionId, "01JQ9G7A1B2C3D4E5F6G7H8J9K");
  } finally { cleanup(context); }
});

test("classifies blocked / failed(nonzero) / usage-limit / auth / malformed from fixture text", () => {
  const context = makeProject();
  try {
    const blocked = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 0, stdout: "BLOCKED: waiting for owner decision" }) }));
    assert.equal(blocked.classification, FACTORY_DROID_CLASSIFICATIONS.BLOCKED);

    const failed = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 3, stderr: "tool error" }) }));
    assert.equal(failed.classification, FACTORY_DROID_CLASSIFICATIONS.FAILED);

    // UNVERIFIED heuristics (Factory does not document these strings).
    const usage = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 1, stderr: "Rate limit reached. Try again at 8:00 PM UTC." }) }));
    assert.equal(usage.classification, FACTORY_DROID_CLASSIFICATIONS.USAGE_LIMIT);
    assert.equal(usage.retryAfter, "8:00 PM UTC");

    const auth = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 1, stderr: "Unauthorized: invalid api key" }) }));
    assert.equal(auth.classification, FACTORY_DROID_CLASSIFICATIONS.FAILED);

    // Exit 0 but not the documented JSON object -> malformed.
    const malformed = runFactoryDroidWorkspaceExec(execRequest(context, { spawn: fakeSpawn({ status: 0, stdout: "plain text, not json" }) }));
    assert.equal(malformed.classification, FACTORY_DROID_CLASSIFICATIONS.MALFORMED_OUTPUT);
  } finally { cleanup(context); }
});

test("mock execution redacts secret-like output including Factory fk- keys", () => {
  const context = makeProject();
  try {
    const result = runFactoryDroidWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: '{"session_id":"s9","is_error":false,"result":"ok"}\nFACTORY_API_KEY=fk-abcdef1234567890\nsk-abcdefghijklmnop123456\n' })
    }));
    assert.equal(/fk-[A-Za-z0-9]/u.test(JSON.stringify(result)), false);
    assert.equal(/sk-[A-Za-z0-9]/u.test(JSON.stringify(result)), false);
    assert.match(result.stdout, /\[REDACTED\]/u);
  } finally { cleanup(context); }
});

test("mock execution rejects unsafe project and prompt paths without spawning", () => {
  const context = makeProject();
  let spawned = false;
  const spawn = () => { spawned = true; return { status: 0, stdout: "" }; };
  try {
    assert.throws(
      () => runFactoryDroidWorkspaceExec(execRequest(context, { projectPath: path.join(context.directory, "outside"), spawn })),
      (error) => error instanceof HephaestusError
    );
    assert.throws(
      () => runFactoryDroidWorkspaceExec(execRequest(context, { promptPath: "../../etc/passwd", spawn })),
      (error) => code(error, "INVALID_AGENT_PROMPT_PATH")
    );
    assert.equal(spawned, false, "unsafe requests must be rejected before any spawn");
  } finally { cleanup(context); }
});

test("without an explicit permit or an injected spawn, no process runs and it reports provider-not-enabled", () => {
  const context = makeProject();
  let spawned = false;
  const spawn = () => { spawned = true; return { status: 0, stdout: '{"session_id":"s","is_error":false}' }; };
  try {
    const noPermit = runFactoryDroidWorkspaceExec(execRequest(context, { explicitFactoryExecutionPermit: false, spawn }));
    assert.equal(noPermit.executed, false);
    assert.equal(noPermit.classification, FACTORY_DROID_CLASSIFICATIONS.PROVIDER_NOT_ENABLED);
    assert.equal(noPermit.reason, "execution-not-permitted");
    assert.ok(Array.isArray(noPermit.plannedArgv));

    const noSpawn = runFactoryDroidWorkspaceExec(execRequest(context));
    assert.equal(noSpawn.executed, false);
    assert.equal(noSpawn.classification, FACTORY_DROID_CLASSIFICATIONS.PROVIDER_NOT_ENABLED);
    assert.equal(noSpawn.reason, "mock-spawn-required");
    assert.equal(spawned, false);
  } finally { cleanup(context); }
});

test("Factory adapter runTask still refuses and stays non-live-executable even if config enables it", () => {
  const adapter = getProviderAdapter("factory-droid");
  const refusal = adapter.runTask({});
  assert.equal(refusal.executed, false);
  assert.equal(refusal.classification, "PROVIDER_NOT_ENABLED");
  assert.equal(adapter.liveExecutable, false);

  const factoryOn = { providers: { "factory-droid": { enabled: true, executionEnabled: true } } };
  assert.equal(isProviderLiveExecutable("factory-droid", factoryOn), false);
  assert.equal(isProviderLiveExecutable("codex"), true, "Codex behavior is unchanged");
});
