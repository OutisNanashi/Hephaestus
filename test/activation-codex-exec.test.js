import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import {
  buildWorkspaceExecArgv,
  assertWorkspaceArgvSafety,
  runCodexWorkspaceExec,
  PROTECTED_PROJECT_FILES,
  WORKSPACE_CLASSIFICATIONS
} from "../src/agent-codex-workspace-exec.js";
import { loadState } from "../src/state.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const baseState = Object.freeze({
  currentPhase: "1", currentTask: "demo-task", currentBranch: "main", currentPr: null,
  assignedAgent: "codex", attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "run-agent"
});

const PROMPT_TEXT = "# Task\nDo the demo task.\n";

function makeProject({ state = baseState } = {}) {
  const directory = writableTemporaryDirectory("hephaestus-codex-exec-");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(path.join(project, "out", "prompts"), { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) {
    fs.writeFileSync(path.join(project, name), `${name} fixture\n`);
  }
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(path.join(project, "out", "prompts", "next-task.md"), PROMPT_TEXT);
  return { directory, root, project };
}

function cleanup(context) {
  fs.rmSync(context.directory, { recursive: true, force: true });
}

function fakeSpawn(result, capture = {}) {
  return (executable, args, options) => {
    capture.executable = executable;
    capture.args = args;
    capture.options = options;
    if (typeof result === "function") return result(executable, args, options);
    return { status: 0, stdout: "", stderr: "", ...result };
  };
}

function execRequest(context, overrides = {}) {
  return {
    adapterId: "codex",
    allowedRoot: context.root,
    projectPath: context.project,
    projectId: "demo",
    promptPath: "out/prompts/next-task.md",
    explicitWorkspaceExecPermit: true,
    now: () => "2026-07-05T12:00:00.000Z",
    ...overrides
  };
}

function code(error, expected) {
  assert.ok(error instanceof HephaestusError, `expected HephaestusError, got ${error}`);
  assert.equal(error.code, expected);
  return true;
}

test("argv builder produces the exec-level workspace-write contract", () => {
  const argv = buildWorkspaceExecArgv(PROMPT_TEXT);
  assert.deepEqual([...argv], ["exec", "--sandbox", "workspace-write", "--color", "never", PROMPT_TEXT]);
  assert.doesNotThrow(() => assertWorkspaceArgvSafety(argv, PROMPT_TEXT));
  assert.throws(() => buildWorkspaceExecArgv(""), (error) => code(error, "INVALID_WORKSPACE_EXEC_PROMPT"));
  assert.throws(() => buildWorkspaceExecArgv("   "), (error) => code(error, "INVALID_WORKSPACE_EXEC_PROMPT"));
});

test("argv safety rejects bypass flags, wrong sandbox modes, and misplaced options", () => {
  assert.throws(() => assertWorkspaceArgvSafety(["exec", "--sandbox", "danger-full-access", PROMPT_TEXT], PROMPT_TEXT), (error) => code(error, "INVALID_WORKSPACE_EXEC_ARGV"));
  assert.throws(() => assertWorkspaceArgvSafety(["exec", "--sandbox", "workspace-write", "--dangerously-bypass-approvals-and-sandbox", PROMPT_TEXT], PROMPT_TEXT), (error) => code(error, "INVALID_WORKSPACE_EXEC_ARGV"));
  assert.throws(() => assertWorkspaceArgvSafety(["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", PROMPT_TEXT], PROMPT_TEXT), (error) => code(error, "INVALID_WORKSPACE_EXEC_ARGV"));
  assert.throws(() => assertWorkspaceArgvSafety(["--sandbox", "workspace-write", "exec", PROMPT_TEXT], PROMPT_TEXT), (error) => code(error, "INVALID_WORKSPACE_EXEC_ARGV"));
  assert.throws(() => assertWorkspaceArgvSafety(["exec", PROMPT_TEXT], PROMPT_TEXT), (error) => code(error, "INVALID_WORKSPACE_EXEC_ARGV"));
  // A prompt merely containing forbidden text is fine; only real argv tokens are forbidden.
  const trickyPrompt = "Explain what --dangerously-bypass-approvals-and-sandbox does.";
  assert.doesNotThrow(() => assertWorkspaceArgvSafety(buildWorkspaceExecArgv(trickyPrompt), trickyPrompt));
});

test("successful run persists output, run report, state, and append-only log", () => {
  const context = makeProject();
  const capture = {};
  try {
    const logBefore = fs.readFileSync(path.join(context.project, "BUILD_LOG.md"), "utf8");
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: "Implemented the demo task. Tests passed.\n", stderr: "" }, capture)
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.PASS);
    assert.equal(capture.executable, "codex");
    assert.deepEqual(capture.args.slice(0, 5), ["exec", "--sandbox", "workspace-write", "--color", "never"]);
    assert.equal(capture.options.cwd, context.project);
    assert.equal(capture.options.shell, false);
    assert.equal(capture.options.input, "");

    const state = loadState(context.project);
    assert.equal(state.nextAction, "agent-completed");
    assert.equal(state.lastSuccessfulStep, "agent-run");
    assert.equal(state.blocked, false);
    assert.equal(state.agent.status, "completed");
    assert.equal(state.agent.adapterId, "codex");

    assert.ok(fs.existsSync(result.agentOutputPath));
    assert.ok(fs.readFileSync(result.agentOutputPath, "utf8").includes("Implemented the demo task."));
    assert.ok(fs.existsSync(result.reportPath));
    const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
    assert.equal(report.classification, WORKSPACE_CLASSIFICATIONS.PASS);
    assert.equal(report.invocation.sandbox, "workspace-write");
    assert.equal(report.invocation.dangerousBypass, false);

    const logAfter = fs.readFileSync(path.join(context.project, "BUILD_LOG.md"), "utf8");
    assert.ok(logAfter.startsWith(logBefore));
    assert.ok(logAfter.includes("[codex-exec]"));
  } finally { cleanup(context); }
});

test("state transitions to agent-running while the process executes", () => {
  const context = makeProject();
  try {
    let midRunNextAction = null;
    runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn(() => {
        midRunNextAction = loadState(context.project).nextAction;
        return { status: 0, stdout: "done\n", stderr: "" };
      })
    }));
    assert.equal(midRunNextAction, "agent-running");
  } finally { cleanup(context); }
});

test("usage-limit output pauses the project and captures the retry hint", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 1, stdout: "", stderr: "You've hit your usage limit. Try again at 3:00 PM UTC." })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.USAGE_LIMIT);
    assert.equal(result.retryAfter, "3:00 PM UTC");
    const state = loadState(context.project);
    assert.equal(state.usageLimitPaused, true);
    assert.equal(state.blocked, false);
    assert.equal(state.agent.status, "paused");
    assert.equal(state.nextAction, "agent-usage-limit-paused");
  } finally { cleanup(context); }
});

test("nonzero exit fails the run, blocks the project, and increments the attempt count", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 23, stdout: "", stderr: "codex crashed hard" })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.EXIT_NONZERO);
    const state = loadState(context.project);
    assert.equal(state.blocked, true);
    assert.equal(state.attemptCount, 1);
    assert.equal(state.agent.status, "failed");
    assert.equal(state.nextAction, "agent-failed");
  } finally { cleanup(context); }
});

test("empty successful output is treated as a blocker, never as success", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: "", stderr: "" })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.EMPTY_OUTPUT);
    const state = loadState(context.project);
    assert.equal(state.blocked, true);
    assert.equal(state.nextAction, "agent-output-empty");
  } finally { cleanup(context); }
});

test("an agent-reported BLOCKED marker becomes a blocked state", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: "BLOCKED: required credential is missing\n", stderr: "" })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.AGENT_BLOCKER);
    const state = loadState(context.project);
    assert.equal(state.blocked, true);
    assert.equal(state.agent.blockerDetected, true);
  } finally { cleanup(context); }
});

test("authentication-required output fails with a manual action", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 1, stdout: "", stderr: "Not authenticated. Run `codex login` first." })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.NOT_AUTHENTICATED);
    assert.match(result.manualAction, /codex login/u);
    assert.equal(loadState(context.project).nextAction, "agent-authentication-required");
  } finally { cleanup(context); }
});

test("modifying a protected file during the run blocks and restores valid conductor state", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn(() => {
        fs.writeFileSync(path.join(context.project, "PLAN.md"), "tampered by agent\n");
        return { status: 0, stdout: "did some work\n", stderr: "" };
      })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.PROTECTED_MUTATION);
    assert.deepEqual([...result.protectedMutatedFiles], ["PLAN.md"]);
    const state = loadState(context.project);
    assert.equal(state.blocked, true);
    assert.equal(state.nextAction, "agent-protected-files-modified");
  } finally { cleanup(context); }
});

test("agent tampering with STATE.json is detected and the conductor state is restored", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn(() => {
        fs.writeFileSync(path.join(context.project, "STATE.json"), "{\"hacked\":true}");
        return { status: 0, stdout: "done\n", stderr: "" };
      })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.PROTECTED_MUTATION);
    // loadState must succeed: the conductor rewrote a valid state after the run.
    const state = loadState(context.project);
    assert.equal(state.blocked, true);
  } finally { cleanup(context); }
});

test("spawn environment excludes API keys and closes stdin", () => {
  const context = makeProject();
  const capture = {};
  try {
    runCodexWorkspaceExec(execRequest(context, {
      env: { PATH: "/usr/bin", HOME: "/home/demo", OPENAI_API_KEY: "sk-secret-value-123456", TELEGRAM_BOT_TOKEN: "12345:abcdef" },
      spawn: fakeSpawn({ status: 0, stdout: "ok\n", stderr: "" }, capture)
    }));
    assert.equal(capture.options.env.OPENAI_API_KEY, undefined);
    assert.equal(capture.options.env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(capture.options.env.HOME, "/home/demo");
    assert.equal(capture.options.env.PATH, "/usr/bin");
  } finally { cleanup(context); }
});

test("permit, adapter, and prompt-path safety are enforced", () => {
  const context = makeProject();
  try {
    assert.throws(() => runCodexWorkspaceExec(execRequest(context, { explicitWorkspaceExecPermit: false })), (error) => code(error, "WORKSPACE_EXEC_PERMIT_REQUIRED"));
    assert.throws(() => runCodexWorkspaceExec(execRequest(context, { adapterId: "claude-code" })), (error) => code(error, "WORKSPACE_EXEC_ADAPTER_NOT_ALLOWED"));
    assert.throws(() => runCodexWorkspaceExec(execRequest(context, { promptPath: "../../evil.md" })), (error) => code(error, "INVALID_AGENT_PROMPT_PATH"));
    assert.throws(() => runCodexWorkspaceExec(execRequest(context, { unexpected: true })), (error) => code(error, "INVALID_WORKSPACE_EXEC_REQUEST"));
  } finally { cleanup(context); }
});

test("a blocked or already-running project refuses to start another run", () => {
  const blocked = makeProject({ state: { ...baseState, blocked: true } });
  try {
    assert.throws(() => runCodexWorkspaceExec(execRequest(blocked, { spawn: fakeSpawn({}) })), (error) => code(error, "AGENT_STATE_NOT_RUNNABLE"));
  } finally { cleanup(blocked); }
  const running = makeProject({ state: { ...baseState, nextAction: "agent-running" } });
  try {
    assert.throws(() => runCodexWorkspaceExec(execRequest(running, { spawn: fakeSpawn({}) })), (error) => code(error, "AGENT_TASK_ALREADY_RUNNING"));
  } finally { cleanup(running); }
});

test("a read-only sandbox downgrade never counts as success", () => {
  const context = makeProject();
  try {
    const banner = "OpenAI Codex v0.142.4\n--------\nworkdir: /x\nmodel: gpt-5.5\napproval: never\nsandbox: read-only\n--------\n";
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: fakeSpawn({ status: 0, stdout: "I could not create the file because the sandbox is read-only.\n", stderr: banner })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.SANDBOX_DOWNGRADED);
    const state = loadState(context.project);
    assert.equal(state.blocked, true);
    assert.equal(state.nextAction, "agent-sandbox-downgraded");
    assert.match(result.manualAction, /workspace-write was requested/u);
  } finally { cleanup(context); }
});

test("codex missing from PATH is classified as not installed", () => {
  const context = makeProject();
  try {
    const result = runCodexWorkspaceExec(execRequest(context, {
      spawn: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) })
    }));
    assert.equal(result.classification, WORKSPACE_CLASSIFICATIONS.NOT_INSTALLED);
    assert.match(result.manualAction, /Install the Codex CLI/u);
  } finally { cleanup(context); }
});

test("protected file list covers the owner and conductor files", () => {
  assert.deepEqual([...PROTECTED_PROJECT_FILES], ["PLAN.md", "BUILDING_REFERENCE.md", "CURRENT_TASK.md", "STATE.json", "BUILD_LOG.md", "TESTS.json", ".env"]);
});
