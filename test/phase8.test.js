import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run, runAsync } from "../src/cli.js";
import { HephaestusError } from "../src/errors.js";
import {
  NotificationDeduper,
  createNotificationEvent,
  createTelegramTransport,
  createTelegramTransportFromEnvironment,
  dispatchNotification,
  renderNotification,
  saveNotificationReport
} from "../src/notification.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const timestamp = "2026-06-23T12:00:00.000Z";
const types = ["manual_blocker", "phase_completed", "merge_completed", "usage_limit", "agent_failure", "container_failure"];

function event(overrides = {}) {
  return {
    type: "manual_blocker",
    project: "hephaestus",
    phase: "8",
    status: "blocked",
    reason: "Telegram configuration requires user attention.",
    requiredAction: "Set the configured environment references.",
    timestamp,
    ...overrides
  };
}

function fakeTransport(result = { status: "sent", failureReason: null }) {
  const messages = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      return result;
    }
  };
}

function projectContext() {
  const directory = writableTemporaryDirectory("hephaestus-phase8-");
  const project = path.join(directory, "demo");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "BUILD_LOG.md"), "# Build log\n\nExisting entry.\n");
  return { directory, project };
}

function cliContext() {
  const directory = writableTemporaryDirectory("hephaestus-phase8-cli-");
  const root = path.join(directory, "projects");
  const project = path.join(root, "demo");
  fs.mkdirSync(project, { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) fs.writeFileSync(path.join(project, name), "fixture\n");
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify({ currentPhase: "8", currentTask: "notifications", currentBranch: "phase8", currentPr: null, assignedAgent: null, attemptCount: 0, blocked: false, usageLimitPaused: false, lastSuccessfulStep: null, mergeStatus: "not-started", containerStatus: "healthy", lastGptDecision: null, nextAction: "notify" })}\n`);
  const fixtures = path.join(root, "notification-fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(path.join(fixtures, "event.json"), `${JSON.stringify(event())}\n`);
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, `${JSON.stringify({ allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs" })}\n`);
  fs.writeFileSync(path.join(directory, "projects.json"), `${JSON.stringify({ projects: [{ id: "demo", path: "demo" }] })}\n`);
  return { directory, config };
}

function code(error, expected) {
  assert.ok(error instanceof HephaestusError);
  assert.equal(error.code, expected);
  return true;
}

test("all required notification event types render concise user-facing templates", () => {
  const headings = {
    manual_blocker: "Manual action required",
    phase_completed: "Phase completed",
    merge_completed: "Merge completed",
    usage_limit: "Usage limit reached",
    agent_failure: "Agent failure",
    container_failure: "Container failure"
  };
  for (const type of types) {
    const rendered = renderNotification(event({ type, reason: `${type} reason` }));
    assert.match(rendered, /\[hephaestus\] phase 8/u);
    assert.match(rendered, new RegExp(headings[type], "u"));
  }
  const blocker = renderNotification(event());
  assert.match(blocker, /Action: Set the configured environment references\./u);
});

test("ordinary internal logs are rejected and never reach a transport", async () => {
  const transport = fakeTransport();
  assert.throws(() => createNotificationEvent(event({ type: "internal_log" })), (error) => code(error, "INVALID_NOTIFICATION_EVENT"));
  assert.equal(transport.messages.length, 0);
});

test("duplicate events are skipped after a first successful delivery", async () => {
  const transport = fakeTransport();
  const deduper = new NotificationDeduper();
  const first = await dispatchNotification({ event: event(), transport, deduper });
  const second = await dispatchNotification({ event: event(), transport, deduper });
  assert.equal(first.status, "sent");
  assert.equal(second.status, "skipped");
  assert.equal(second.deduplicated, true);
  assert.equal(transport.messages.length, 1);
});

test("credential-like values are redacted before notification text is rendered", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDE";
  const telegram = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  const rendered = renderNotification(event({ reason: `GitHub token=${secret}; telegram=${telegram}`, requiredAction: "Use Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD" }));
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes(telegram), false);
  assert.equal(rendered.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false);
  assert.match(rendered, /\[REDACTED\]/u);
});

test("failed sends are graceful and their persisted report redacts failures without touching BUILD_LOG", async () => {
  const context = projectContext();
  const secret = "super-secret-value-abcdefghijklmnopqrstuvwxyz123456";
  try {
    const result = await dispatchNotification({
      event: event({ reason: `password=${secret}` }),
      transport: fakeTransport({ status: "failed", failureReason: `Bearer ${secret}` })
    });
    assert.equal(result.status, "failed");
    const report = saveNotificationReport(context.project, result);
    const content = fs.readFileSync(report, "utf8");
    assert.equal(content.includes(secret), false);
    assert.match(content, /\[REDACTED\]/u);
    assert.equal(fs.readFileSync(path.join(context.project, "BUILD_LOG.md"), "utf8"), "# Build log\n\nExisting entry.\n");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

test("missing Telegram configuration is a safe no-op and does not invoke fetch", async () => {
  let called = false;
  const transport = createTelegramTransportFromEnvironment({ enabled: true, botTokenEnv: "TELEGRAM_BOT_TOKEN", chatIdEnv: "TELEGRAM_CHAT_ID" }, {}, async () => {
    called = true;
    throw new Error("network must not run");
  });
  const result = await dispatchNotification({ event: event(), transport });
  assert.equal(result.status, "skipped");
  assert.equal(called, false);
});

test("real transport failures are captured without throwing and no real network call occurs in tests", async () => {
  let called = false;
  const transport = createTelegramTransport({
    enabled: true,
    botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    chatId: "42",
    fetchImpl: async () => {
      called = true;
      throw new Error("network password=not-for-telegram");
    }
  });
  const result = await dispatchNotification({ event: event(), transport });
  assert.equal(called, true);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason.includes("not-for-telegram"), false);
});

test("stalled Telegram sends time out, abort the injected request, and fail gracefully", async () => {
  let signal;
  const transport = createTelegramTransport({
    enabled: true,
    botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    chatId: "42",
    timeoutMs: 10,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }
  });
  const result = await dispatchNotification({ event: event(), transport });
  assert.equal(result.status, "failed");
  assert.match(result.failureReason, /timed out after 10ms/u);
  assert.equal(signal.aborted, true);
});

test("notification reports are deterministic per dedupe key and invalid events are rejected", async () => {
  const context = projectContext();
  try {
    const item = event({ dedupeKey: "phase8-demo-blocker" });
    const result = await dispatchNotification({ event: item, transport: fakeTransport() });
    const report = saveNotificationReport(context.project, result);
    assert.equal(path.basename(report), "phase8-demo-blocker.json");
    assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).status, "sent");
    assert.throws(() => createNotificationEvent(event({ dedupeKey: "../unsafe" })), (error) => code(error, "INVALID_NOTIFICATION_EVENT"));
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

function canCreateSymlinks() {
  const probeDirectory = fs.mkdtempSync(path.join(path.resolve("test"), "symlink-probe-"));
  const probeTarget = path.join(probeDirectory, "target");
  const probeLink = path.join(probeDirectory, "link");
  try {
    fs.writeFileSync(probeTarget, "probe");
    fs.symlinkSync(probeTarget, probeLink);
    return true;
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "ENOSYS" || error.code === "EACCES")) return false;
    throw error;
  } finally {
    fs.rmSync(probeDirectory, { recursive: true, force: true });
  }
}

test("notification report writes reject symlink targets without following them", async (t) => {
  if (!canCreateSymlinks()) { t.skip("symlink creation is not available in this environment"); return; }
  const context = projectContext();
  try {
    const item = event({ dedupeKey: "phase8-symlink-report" });
    const result = await dispatchNotification({ event: item, transport: fakeTransport() });
    const directory = path.join(context.project, "out", "notification_reports");
    const destination = path.join(directory, "phase8-symlink-report.json");
    const outside = path.join(context.directory, "outside.json");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(outside, "unchanged\n");
    fs.symlinkSync(outside, destination);
    assert.throws(() => saveNotificationReport(context.project, result), (error) => code(error, "OUTSIDE_ALLOWED_ROOT"));
    assert.equal(fs.readFileSync(outside, "utf8"), "unchanged\n");
  } finally {
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
});

function cliContextWithTelegram() {
  const context = cliContext();
  fs.writeFileSync(context.config, `${JSON.stringify({
    allowedRoot: "./projects", registryPath: "./projects.json", logDirectory: "./logs",
    notifications: { telegram: { enabled: true, botTokenEnv: "TELEGRAM_BOT_TOKEN", chatIdEnv: "TELEGRAM_CHAT_ID" } }
  })}\n`);
  return context;
}

async function withSendEnvironment({ token, chatId }, action) {
  const originalWrite = process.stdout.write;
  const originalFetch = globalThis.fetch;
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  const state = { output: "", fetchCalls: 0, lastBody: null };
  process.stdout.write = (chunk) => { state.output += chunk; return true; };
  if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = token;
  if (chatId === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = chatId;
  globalThis.fetch = async (_url, options) => { state.fetchCalls += 1; state.lastBody = options?.body ?? null; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  try { await action(state); } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
  }
}

test("notify send delivers exactly one event via mocked transport, prints no token/chat id, and writes a project-local report", async () => {
  const context = cliContextWithTelegram();
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  const chatId = "987654321000";
  try {
    await withSendEnvironment({ token, chatId }, async (state) => {
      const exit = await runAsync(["notify", "send", "demo", "--config", context.config, "--fixture", "notification-fixtures/event.json"]);
      assert.equal(exit, 0);
      const parsed = JSON.parse(state.output);
      assert.equal(parsed.mode, "send");
      assert.equal(parsed.status, "sent");
      assert.equal(state.fetchCalls, 1); // exactly one send, no spam
      assert.equal(state.output.includes(token), false); // bot token never printed
      assert.equal(state.output.includes(chatId), false); // chat id never printed
      assert.ok(parsed.reportPath.includes(path.join("out", "notification_reports")));
      const report = fs.readFileSync(parsed.reportPath, "utf8");
      assert.equal(report.includes(token), false);
      assert.equal(JSON.parse(report).status, "sent");
    });
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("notify send fails safely and calls no transport when Telegram config/env is missing", async () => {
  const context = cliContext(); // no notifications block
  try {
    await withSendEnvironment({ token: undefined, chatId: undefined }, async (state) => {
      const exit = await runAsync(["notify", "send", "demo", "--config", context.config, "--fixture", "notification-fixtures/event.json"]);
      assert.equal(exit, 1); // skipped -> non-zero, safe
      assert.equal(JSON.parse(state.output).status, "skipped");
      assert.equal(state.fetchCalls, 0); // no network attempt
    });
  } finally { fs.rmSync(context.directory, { recursive: true, force: true }); }
});

test("notify render CLI is fixture-only and cannot send a Telegram message", () => {
  const context = cliContext();
  let output = "";
  let fetchCalled = false;
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDE";
  const original = process.stdout.write;
  const originalFetch = globalThis.fetch;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  globalThis.fetch = () => { fetchCalled = true; throw new Error("network must not run"); };
  try {
    fs.writeFileSync(path.join(context.directory, "projects", "notification-fixtures", "event.json"), `${JSON.stringify(event({ reason: `token=${secret}`, requiredAction: `Bearer ${secret}` }))}\n`);
    assert.equal(run(["notify", "render", "demo", "--config", context.config, "--fixture", "notification-fixtures/event.json"]), 0);
  } finally {
    process.stdout.write = original;
    globalThis.fetch = originalFetch;
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, "render-only");
  assert.match(parsed.message, /Manual action required/u);
  assert.equal(fetchCalled, false);
  assert.equal(output.includes(secret), false);
  assert.match(parsed.event.reason, /\[REDACTED\]/u);
  assert.match(parsed.event.requiredAction, /\[REDACTED\]/u);
});
