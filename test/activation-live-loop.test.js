import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import { runLiveLoop } from "../src/live-loop.js";
import { loadState } from "../src/state.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const baseState = Object.freeze({
  currentPhase: "1", currentTask: "demo-task", currentBranch: "main", currentPr: null,
  assignedAgent: "codex", attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: null, mergeStatus: "not-started",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "run-agent"
});

function decision(overrides = {}) {
  return {
    nextAction: "implement the demo task",
    rationale: "The plan requires the demo task.",
    allowedFiles: ["src/demo.js"],
    requiredTests: ["npm test"],
    stopConditions: ["stop on missing files"],
    loopSignal: "continue",
    ...overrides
  };
}

// Sequenced OpenAI-shaped fetch: each call consumes the next decision.
function brainFetch(decisions, capture = {}) {
  let index = 0;
  capture.requests = [];
  return async (url, options) => {
    capture.requests.push(JSON.parse(options.body));
    const current = decisions[Math.min(index, decisions.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ output_text: JSON.stringify(current) })
    };
  };
}

function agentSpawn(results, capture = {}) {
  let index = 0;
  capture.calls = 0;
  return () => {
    capture.calls += 1;
    const current = results[Math.min(index, results.length - 1)];
    index += 1;
    return { status: 0, stdout: "Implemented and tested.\n", stderr: "", ...current };
  };
}

function makeProject({ state = baseState } = {}) {
  const directory = writableTemporaryDirectory("hephaestus-live-loop-");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "PLAN.md"), "# Demo project\n\nBuild the demo task.\n");
  fs.writeFileSync(path.join(project, "BUILDING_REFERENCE.md"), "No special rules.\n");
  fs.writeFileSync(path.join(project, "BUILD_LOG.md"), "# Build log\n");
  fs.writeFileSync(path.join(project, "CURRENT_TASK.md"), "Demo task.\n");
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  return { directory, root, project };
}

function cleanup(context) {
  fs.rmSync(context.directory, { recursive: true, force: true });
}

function loopRequest(context, overrides = {}) {
  return {
    allowedRoot: context.root,
    projectPath: context.project,
    projectId: "demo",
    brain: { provider: "openai", model: "test-model" },
    env: { OPENAI_API_KEY: "test-key" },
    ...overrides
  };
}

test("loop runs brain then agent and stops when the brain reports task-complete", async () => {
  const context = makeProject();
  const brainCapture = {};
  const agentCapture = {};
  try {
    const result = await runLiveLoop(loopRequest(context, {
      fetchImpl: brainFetch([decision(), decision({ loopSignal: "task-complete", rationale: "Demo task verified complete." })], brainCapture),
      spawn: agentSpawn([{}], agentCapture)
    }));
    assert.equal(result.status, "task-complete");
    assert.equal(result.cycles.length, 2);
    assert.equal(result.cycles[0].execClassification, "CODEX_EXEC_PASS");
    assert.equal(result.cycles[1].execClassification, null);
    assert.equal(agentCapture.calls, 1);
    // The second brain call must see the agent's report from the first cycle.
    assert.match(brainCapture.requests[1].input, /Latest coding-agent report/u);
    assert.match(brainCapture.requests[1].input, /Implemented and tested\./u);
    const state = loadState(context.project);
    assert.equal(state.nextAction, "agent-completed");
    // Prompt was saved inside the project by the brain cycle.
    assert.ok(fs.existsSync(path.join(context.project, "out", "prompts", "next-task.md")));
  } finally { cleanup(context); }
});

test("a Codex usage limit pauses the loop and the project", async () => {
  const context = makeProject();
  try {
    const result = await runLiveLoop(loopRequest(context, {
      fetchImpl: brainFetch([decision()]),
      spawn: agentSpawn([{ status: 1, stdout: "", stderr: "You've hit your usage limit. Try again at 6:00 PM." }])
    }));
    assert.equal(result.status, "paused");
    assert.match(result.reason, /usage limit/iu);
    assert.equal(loadState(context.project).usageLimitPaused, true);
  } finally { cleanup(context); }
});

test("a brain blocked signal stops the loop without running the agent", async () => {
  const context = makeProject();
  const agentCapture = {};
  try {
    const result = await runLiveLoop(loopRequest(context, {
      fetchImpl: brainFetch([decision({ loopSignal: "blocked", rationale: "A credential is missing.", nextAction: "add the API key to .env" })]),
      spawn: agentSpawn([{}], agentCapture)
    }));
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /credential is missing/u);
    assert.equal(agentCapture.calls, 0);
  } finally { cleanup(context); }
});

test("a failing agent run ends the loop as blocked with the classification in the reason", async () => {
  const context = makeProject();
  try {
    const result = await runLiveLoop(loopRequest(context, {
      fetchImpl: brainFetch([decision()]),
      spawn: agentSpawn([{ status: 23, stdout: "", stderr: "crash" }])
    }));
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /CODEX_EXEC_BLOCKED_EXIT_NONZERO/u);
    assert.equal(loadState(context.project).blocked, true);
  } finally { cleanup(context); }
});

test("the loop refuses blocked and paused projects at entry", async () => {
  const blocked = makeProject({ state: { ...baseState, blocked: true, nextAction: "agent-blocked" } });
  try {
    const result = await runLiveLoop(loopRequest(blocked, { fetchImpl: brainFetch([decision()]) }));
    assert.equal(result.status, "blocked");
    assert.equal(result.cycles.length, 0);
  } finally { cleanup(blocked); }
  const paused = makeProject({ state: { ...baseState, usageLimitPaused: true } });
  try {
    const result = await runLiveLoop(loopRequest(paused, { fetchImpl: brainFetch([decision()]) }));
    assert.equal(result.status, "paused");
    assert.equal(result.cycles.length, 0);
  } finally { cleanup(paused); }
});

test("the loop stops at the cycle budget when the brain never signals completion", async () => {
  const context = makeProject();
  const agentCapture = {};
  try {
    const result = await runLiveLoop(loopRequest(context, {
      maxCycles: 3,
      fetchImpl: brainFetch([decision()]),
      spawn: agentSpawn([{}], agentCapture)
    }));
    assert.equal(result.status, "max-cycles-reached");
    assert.equal(result.cycles.length, 3);
    assert.equal(agentCapture.calls, 3);
  } finally { cleanup(context); }
});

test("terminal loop events send a Telegram notification when configured", async () => {
  const context = makeProject();
  const telegramCalls = [];
  const fetchImpl = async (url, options) => {
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      telegramCalls.push(JSON.parse(options.body));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ output_text: JSON.stringify(decision({ loopSignal: "task-complete", rationale: "All done." })) })
    };
  };
  try {
    const result = await runLiveLoop(loopRequest(context, {
      fetchImpl,
      env: { OPENAI_API_KEY: "test-key", TG_TOKEN: "12345:abc", TG_CHAT: "42" },
      telegram: { enabled: true, botTokenEnv: "TG_TOKEN", chatIdEnv: "TG_CHAT" }
    }));
    assert.equal(result.status, "task-complete");
    assert.equal(result.notification, "sent");
    assert.equal(telegramCalls.length, 1);
    assert.match(telegramCalls[0].text, /Phase completed/u);
    const reports = fs.readdirSync(path.join(context.project, "out", "notification_reports"));
    assert.equal(reports.length, 1);
  } finally { cleanup(context); }
});

test("a terminal event already notified in a previous invocation is not re-sent", async () => {
  const context = makeProject();
  const telegramCalls = [];
  const fetchImpl = async (url, options) => {
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      telegramCalls.push(options.body);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ output_text: JSON.stringify(decision({ loopSignal: "task-complete", rationale: "All done." })) })
    };
  };
  const request = loopRequest(context, {
    fetchImpl,
    env: { OPENAI_API_KEY: "test-key", TG_TOKEN: "12345:abc", TG_CHAT: "42" },
    telegram: { enabled: true, botTokenEnv: "TG_TOKEN", chatIdEnv: "TG_CHAT" }
  });
  try {
    assert.equal((await runLiveLoop(request)).notification, "sent");
    // Second invocation (e.g. a scheduler re-run) reaches the same terminal event.
    assert.equal((await runLiveLoop(request)).notification, "skipped");
    assert.equal(telegramCalls.length, 1);
  } finally { cleanup(context); }
});

test("notification failure never crashes the loop", async () => {
  const context = makeProject();
  const fetchImpl = async (url, options) => {
    if (typeof url === "string" && url.includes("api.telegram.org")) throw new Error("network down");
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ output_text: JSON.stringify(decision({ loopSignal: "task-complete", rationale: "Done." })) })
    };
  };
  try {
    const result = await runLiveLoop(loopRequest(context, {
      fetchImpl,
      env: { OPENAI_API_KEY: "test-key", TG_TOKEN: "12345:abc", TG_CHAT: "42" },
      telegram: { enabled: true, botTokenEnv: "TG_TOKEN", chatIdEnv: "TG_CHAT" }
    }));
    assert.equal(result.status, "task-complete");
    assert.equal(result.notification, "failed");
  } finally { cleanup(context); }
});

test("an invalid cycle budget is rejected", async () => {
  const context = makeProject();
  try {
    await assert.rejects(() => runLiveLoop(loopRequest(context, { maxCycles: 0 })), (error) => {
      assert.ok(error instanceof HephaestusError);
      assert.equal(error.code, "INVALID_LIVE_LOOP_REQUEST");
      return true;
    });
  } finally { cleanup(context); }
});
