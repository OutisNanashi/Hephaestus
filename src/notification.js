import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

export const NOTIFICATION_EVENT_TYPES = Object.freeze([
  "manual_blocker", "phase_completed", "merge_completed", "usage_limit", "agent_failure", "container_failure"
]);

const EVENT_TYPES = new Set(NOTIFICATION_EVENT_TYPES);
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;

function text(value, label, code = "INVALID_NOTIFICATION_EVENT") {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string.`, code);
  return value.trim();
}

function optionalText(value, label, code = "INVALID_NOTIFICATION_EVENT") {
  if (value === null || value === undefined) return null;
  return text(value, label, code);
}

function timestamp(value) {
  const result = text(value, "Notification timestamp");
  if (Number.isNaN(Date.parse(result))) fail("Notification timestamp must be valid ISO date text.", "INVALID_NOTIFICATION_EVENT");
  return result;
}

function fingerprint(event) {
  return crypto.createHash("sha256").update(JSON.stringify({ type: event.type, project: event.project, phase: event.phase, status: event.status, reason: event.reason, requiredAction: event.requiredAction })).digest("hex").slice(0, 24);
}

/** Validate and freeze the small, user-facing event contract used by notification transports. */
export function createNotificationEvent(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") fail("Notification event must be an object.", "INVALID_NOTIFICATION_EVENT");
  const allowed = new Set(["type", "project", "phase", "status", "reason", "requiredAction", "timestamp", "dedupeKey", "severity"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) fail("Notification event contains unsupported fields.", "INVALID_NOTIFICATION_EVENT");
  const type = text(raw.type, "Notification type");
  if (!EVENT_TYPES.has(type)) fail(`Unsupported notification type: ${type}.`, "INVALID_NOTIFICATION_EVENT");
  const event = {
    type,
    project: text(raw.project, "Notification project"),
    phase: optionalText(raw.phase, "Notification phase"),
    status: text(raw.status, "Notification status"),
    reason: text(raw.reason, "Notification reason"),
    requiredAction: optionalText(raw.requiredAction, "Notification requiredAction"),
    timestamp: timestamp(raw.timestamp),
    severity: optionalText(raw.severity, "Notification severity")
  };
  event.dedupeKey = raw.dedupeKey === undefined ? fingerprint(event) : text(raw.dedupeKey, "Notification dedupeKey");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(event.dedupeKey)) fail("Notification dedupeKey contains unsafe characters.", "INVALID_NOTIFICATION_EVENT");
  return Object.freeze(event);
}

function redactPattern(value) {
  return value
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+\/-]{12,}\b/giu, "$1 [REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|[0-9]{7,}:[A-Za-z0-9_-]{20,})\b/gu, "[REDACTED]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|bot[_ -]?token|github[_ -]?token|password|secret)\s*([:=])\s*([^\s,;]+)/giu, "$1$2[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[REDACTED]");
}

/** Redact common credential forms before text becomes a message, report, or log field. */
export function redactSecrets(value) {
  return typeof value === "string" ? redactPattern(value) : value;
}

export function redactNotificationEvent(event) {
  const validated = createNotificationEvent(event);
  return Object.freeze({ ...validated, reason: redactSecrets(validated.reason), requiredAction: validated.requiredAction === null ? null : redactSecrets(validated.requiredAction) });
}

function headline(event) {
  const phase = event.phase === null ? "" : ` phase ${event.phase}`;
  return `[${event.project}]${phase}`;
}

/** Render only actionable lifecycle events; ordinary logs are not part of this model. */
export function renderNotification(event) {
  const item = redactNotificationEvent(event);
  const action = item.requiredAction === null ? "" : `\nAction: ${item.requiredAction}`;
  const kind = {
    manual_blocker: "Manual action required",
    phase_completed: "Phase completed",
    merge_completed: "Merge completed",
    usage_limit: "Usage limit reached",
    agent_failure: "Agent failure",
    container_failure: "Container failure"
  }[item.type];
  return `${kind}: ${headline(item)}\n${item.reason}${action}`;
}

export class NotificationDeduper {
  #seen = new Set();

  claim(event) {
    const item = createNotificationEvent(event);
    if (this.#seen.has(item.dedupeKey)) return false;
    this.#seen.add(item.dedupeKey);
    return true;
  }
}

function result(status, event, fields = {}) {
  return Object.freeze({ status, event: redactNotificationEvent(event), redactionApplied: true, ...fields });
}

/** Build an explicit opt-in Telegram transport. Disabled and incomplete configuration never sends network traffic. */
export function createTelegramTransport({ enabled = false, botToken = null, chatId = null, fetchImpl = globalThis.fetch } = {}) {
  const configured = enabled === true && typeof botToken === "string" && botToken.trim() !== "" && typeof chatId === "string" && chatId.trim() !== "";
  return Object.freeze({
    async send(message) {
      const safeMessage = redactSecrets(text(message, "Notification message", "INVALID_NOTIFICATION_MESSAGE"));
      if (!configured) return Object.freeze({ status: "skipped", failureReason: enabled ? "telegram configuration missing" : "telegram disabled", message: safeMessage });
      if (typeof fetchImpl !== "function") return Object.freeze({ status: "failed", failureReason: "telegram fetch unavailable", message: safeMessage });
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: safeMessage, disable_web_page_preview: true })
        });
        if (!response?.ok) return Object.freeze({ status: "failed", failureReason: `telegram request failed with status ${response?.status ?? "unknown"}`, message: safeMessage });
        return Object.freeze({ status: "sent", failureReason: null, message: safeMessage });
      } catch (error) {
        return Object.freeze({ status: "failed", failureReason: redactSecrets(error instanceof Error ? error.message : String(error)), message: safeMessage });
      }
    }
  });
}

/** Read only named environment references; configuration never contains literal Telegram secrets. */
export function createTelegramTransportFromEnvironment(telegram = undefined, env = process.env, fetchImpl = globalThis.fetch) {
  if (!telegram || telegram.enabled !== true) return createTelegramTransport({ enabled: false, fetchImpl });
  const tokenName = text(telegram.botTokenEnv, "Telegram botTokenEnv", "INVALID_NOTIFICATION_CONFIG");
  const chatName = text(telegram.chatIdEnv, "Telegram chatIdEnv", "INVALID_NOTIFICATION_CONFIG");
  if (!ENV_NAME.test(tokenName) || !ENV_NAME.test(chatName)) fail("Telegram environment references must be environment variable names.", "INVALID_NOTIFICATION_CONFIG");
  return createTelegramTransport({ enabled: true, botToken: env[tokenName], chatId: env[chatName], fetchImpl });
}

export async function dispatchNotification({ event, transport, deduper = new NotificationDeduper() }) {
  const item = createNotificationEvent(event);
  if (!transport || typeof transport.send !== "function") fail("Notification transport must expose send().", "INVALID_NOTIFICATION_TRANSPORT");
  if (!deduper.claim(item)) return result("skipped", item, { deduplicated: true, failureReason: "duplicate notification" });
  const sent = await transport.send(renderNotification(item));
  const status = ["sent", "skipped", "failed"].includes(sent?.status) ? sent.status : "failed";
  return result(status, item, { deduplicated: false, failureReason: sent?.failureReason ? redactSecrets(String(sent.failureReason)) : null });
}

export function saveNotificationReport(projectPath, notificationResult) {
  if (!notificationResult || !notificationResult.event || !["sent", "skipped", "failed"].includes(notificationResult.status)) fail("Notification result has an invalid schema.", "INVALID_NOTIFICATION_RESULT");
  const root = assertRealPathWithinRoot(projectPath, projectPath);
  const directory = path.join(root, "out", "notification_reports");
  fs.mkdirSync(directory, { recursive: true });
  assertRealPathWithinRoot(root, directory);
  const destination = path.join(directory, `${notificationResult.event.dedupeKey}.json`);
  const safeDestination = path.resolve(destination);
  if (!safeDestination.startsWith(`${path.resolve(directory)}${path.sep}`)) fail("Notification report path is unsafe.", "OUTSIDE_ALLOWED_ROOT");
  if (fs.existsSync(safeDestination) && fs.lstatSync(safeDestination).isSymbolicLink()) fail("Notification report must not be a symbolic link.", "OUTSIDE_ALLOWED_ROOT");
  fs.writeFileSync(safeDestination, `${JSON.stringify({ ...notificationResult, event: redactNotificationEvent(notificationResult.event) }, null, 2)}\n`, "utf8");
  return safeDestination;
}
