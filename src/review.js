import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail, HephaestusError } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";
import { saveState, validateState } from "./state.js";

const STATUSES = new Set(["unresolved", "resolved", "dismissed"]);
const SOURCE_NAMES = new Map([["coderabbit", "CodeRabbit"], ["qodo", "Qodo"], ["codex", "Codex"], ["copilot", "Copilot"], ["gpt", "GPT"], ["gpt review notes", "GPT"]]);
const NOTES_START = "<!-- hephaestus:review-ingestion:start -->";
const NOTES_END = "<!-- hephaestus:review-ingestion:end -->";

function text(value, label, code = "INVALID_REVIEW_ITEM") {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string.`, code);
  return value.trim();
}
function optionalText(value, label, code) { return value === undefined || value === null ? null : text(value, label, code); }
function timestamp(value, label, code = "INVALID_REVIEW_ITEM") { const result = text(value, label, code); if (Number.isNaN(Date.parse(result))) fail(`${label} must be an ISO timestamp.`, code); return result; }
function sourceName(value, code = "INVALID_REVIEW_ITEM") { const valueText = text(value, "Review source", code); const known = SOURCE_NAMES.get(valueText.toLowerCase()); if (known) return known; if (!/^[A-Za-z][A-Za-z0-9 ._-]*$/u.test(valueText)) fail("Review source contains unsupported characters.", code); return valueText; }
function line(value, label) { if (value === undefined || value === null) return null; if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer.`, "INVALID_REVIEW_ITEM"); return value; }
function generatedId({ source, filePath, lineStart, lineEnd, body }) { return `review-${crypto.createHash("sha256").update([source, filePath ?? "", lineStart ?? "", lineEnd ?? "", body].join("\u0000")).digest("hex").slice(0, 24)}`; }

function normalizeDecision(raw, status) {
  const decision = raw.gptDecision;
  const required = typeof decision?.required === "boolean" ? decision.required : raw.actionable !== false;
  if (status !== "dismissed") return Object.freeze({ required, dismissed: false, dismissalReason: null, decidedAt: null });
  if (!decision || Array.isArray(decision) || typeof decision !== "object" || decision.dismissed !== true) fail("Dismissed review items require explicit GPT dismissal metadata.", "MISSING_GPT_DISMISSAL_DECISION");
  const dismissalReason = optionalText(decision.dismissalReason ?? decision.reason, "GPT dismissal reason", "MISSING_GPT_DISMISSAL_DECISION");
  const decidedAt = decision.decidedAt === undefined ? null : timestamp(decision.decidedAt, "GPT decision timestamp", "MISSING_GPT_DISMISSAL_DECISION");
  if (dismissalReason === null || decidedAt === null) fail("Dismissed review items require a GPT dismissal reason and timestamp.", "MISSING_GPT_DISMISSAL_DECISION");
  return Object.freeze({ required: true, dismissed: true, dismissalReason, decidedAt });
}

/** Normalize one untrusted review comment. New items default to unresolved. */
export function normalizeReviewItem(raw, { timestamp: batchTimestamp } = {}) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") fail("Review item must be an object.", "INVALID_REVIEW_ITEM");
  const source = sourceName(raw.source);
  const body = text(raw.body ?? raw.rawText ?? raw.text, "Review body");
  const filePath = optionalText(raw.filePath ?? raw.path, "Review file path");
  if (filePath?.includes("\0") || filePath?.split(/[\\/]+/u).includes("..")) fail("Review file path is unsafe.", "INVALID_REVIEW_ITEM");
  const lineStart = line(raw.lineStart ?? raw.line ?? raw.lineNumber, "Review line start");
  const lineEnd = line(raw.lineEnd ?? raw.endLine, "Review line end");
  if (lineEnd !== null && lineStart === null) fail("Review line end requires a line start.", "INVALID_REVIEW_ITEM");
  if (lineEnd !== null && lineStart !== null && lineEnd < lineStart) fail("Review line end cannot precede line start.", "INVALID_REVIEW_ITEM");
  const status = raw.status ?? "unresolved";
  if (!STATUSES.has(status)) fail("Review status is invalid.", "INVALID_REVIEW_ITEM");
  if (raw.actionable !== undefined && typeof raw.actionable !== "boolean") fail("Review actionable must be a boolean.", "INVALID_REVIEW_ITEM");
  const externalId = optionalText(raw.externalId ?? raw.id, "Review external id");
  const defaultTimestamp = batchTimestamp ?? raw.lastSeenAt ?? raw.firstSeenAt;
  const firstSeenAt = timestamp(raw.firstSeenAt ?? defaultTimestamp, "Review first seen timestamp");
  const lastSeenAt = timestamp(raw.lastSeenAt ?? defaultTimestamp, "Review last seen timestamp");
  const gptDecision = normalizeDecision(raw, status);
  const item = {
    id: externalId ?? generatedId({ source, filePath, lineStart, lineEnd, body }), source, externalId, filePath, lineStart, lineEnd,
    severity: optionalText(raw.severity, "Review severity"), category: optionalText(raw.category ?? raw.type, "Review category"), body,
    summary: raw.summary === undefined ? body.replace(/\s+/gu, " ").trim().slice(0, 240) : text(raw.summary, "Review summary"),
    actionable: raw.actionable !== false, status, firstSeenAt, lastSeenAt, url: optionalText(raw.url, "Review URL"), gptDecision,
    gptDecisionRequired: gptDecision.required, gptDismissed: gptDecision.dismissed, dismissalReason: gptDecision.dismissalReason
  };
  return Object.freeze({ ...item, blocksMerge: item.actionable && item.status === "unresolved" });
}

function storedItem(item) {
  const { id, blocksMerge, gptDecisionRequired, gptDismissed, dismissalReason, ...raw } = item;
  return normalizeReviewItem({ ...raw, externalId: item.externalId, gptDecision: item.gptDecision, firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt }, { timestamp: item.lastSeenAt });
}
function safeFile(root, target) {
  if (!fs.existsSync(target)) return target;
  assertRealPathWithinRoot(root, target);
  if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) fail("Review storage path must be a regular non-symlink file.", "INVALID_REVIEW_PATH");
  return target;
}
function reportPath(projectPath) {
  const out = path.join(projectPath, "out"); const reports = path.join(out, "review_reports");
  for (const directory of [out, reports]) { if (!fs.existsSync(directory)) fs.mkdirSync(directory); assertRealPathWithinRoot(projectPath, directory); if (!fs.statSync(directory).isDirectory()) fail("Review report path is not a directory.", "INVALID_REVIEW_PATH"); }
  return safeFile(projectPath, path.join(reports, "review-items.json"));
}
function loadStored(projectPath) {
  const destination = reportPath(projectPath); if (!fs.existsSync(destination)) return [];
  let report; try { report = JSON.parse(fs.readFileSync(destination, "utf8")); } catch (error) { fail(`Review report contains invalid JSON: ${error.message}`, "INVALID_REVIEW_REPORT"); }
  if (!report || Array.isArray(report) || typeof report !== "object" || !Array.isArray(report.items)) fail("Review report has an invalid schema.", "INVALID_REVIEW_REPORT");
  const ids = new Set();
  return report.items.map((item) => { const normalized = storedItem(item); if (ids.has(normalized.id)) fail("Review report contains duplicate item ids.", "INVALID_REVIEW_REPORT"); ids.add(normalized.id); return normalized; });
}
function readFixture(allowedRoot, fixturePath) {
  const resolved = resolveSafePath(allowedRoot, fixturePath);
  try { const safePath = assertRealPathWithinRoot(allowedRoot, resolved); if (!fs.statSync(safePath).isFile()) fail("Review fixture must be a regular file.", "INVALID_REVIEW_FIXTURE"); return fs.readFileSync(safePath, "utf8"); }
  catch (error) { if (error instanceof HephaestusError) throw error; fail(`Review fixture could not be read: ${error?.message ?? "unknown error"}.`, "REVIEW_FIXTURE_READ_FAILED"); }
}
function sourceEntries(fixture) {
  if (Array.isArray(fixture.sources)) return fixture.sources;
  if (fixture.sources && typeof fixture.sources === "object") return Object.entries(fixture.sources).map(([source, value]) => ({ source, ...value }));
  if (Array.isArray(fixture.comments)) {
    const grouped = new Map();
    for (const comment of fixture.comments) {
      const source = sourceName(comment?.source, "INVALID_REVIEW_FIXTURE");
      if (!grouped.has(source)) grouped.set(source, []);
      grouped.get(source).push(comment);
    }
    return [...grouped.entries()].map(([source, comments]) => ({ source, availability: "available", comments }));
  }
  fail("Review fixture must contain sources or comments.", "INVALID_REVIEW_FIXTURE");
}
function parseFixture(content) {
  let fixture; try { fixture = JSON.parse(content); } catch (error) { fail(`Review fixture contains invalid JSON: ${error.message}`, "INVALID_REVIEW_FIXTURE"); }
  if (!fixture || Array.isArray(fixture) || typeof fixture !== "object") fail("Review fixture must be an object.", "INVALID_REVIEW_FIXTURE");
  if (fixture.providerFailure === true) return { kind: "failure", message: text(fixture.message, "Review fixture failure message", "INVALID_REVIEW_FIXTURE"), retryable: fixture.retryable !== false };
  const batchTimestamp = timestamp(fixture.timestamp, "Review fixture timestamp", "INVALID_REVIEW_FIXTURE"); const activeSources = []; const unavailableSources = []; const comments = [];
  for (const entry of sourceEntries(fixture)) {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") fail("Review source entry must be an object.", "INVALID_REVIEW_FIXTURE");
    const source = sourceName(entry.source, "INVALID_REVIEW_FIXTURE"); const availability = entry.availability ?? entry.status ?? "available";
    if (availability === "unavailable" || availability === "paused") { unavailableSources.push(source); continue; }
    if (availability !== "available" || !Array.isArray(entry.comments)) fail("Available review sources require a comments array.", "INVALID_REVIEW_FIXTURE");
    activeSources.push(source); for (const raw of entry.comments) comments.push({ raw: { ...raw, source: raw?.source ?? source }, statusExplicit: Object.hasOwn(raw ?? {}, "status") });
  }
  return { kind: "success", timestamp: batchTimestamp, activeSources: [...new Set(activeSources)].sort(), unavailableSources: [...new Set(unavailableSources)].sort(), comments };
}
function merge(existing, incoming, statusExplicit) {
  if (!existing) return incoming;
  const status = statusExplicit ? incoming.status : existing.status;
  const gptDecision = status === "dismissed" && !incoming.gptDecision.dismissed ? existing.gptDecision : incoming.gptDecision;
  const result = { ...existing, ...incoming, status, gptDecision, firstSeenAt: existing.firstSeenAt, lastSeenAt: incoming.lastSeenAt };
  return Object.freeze({ ...result, blocksMerge: result.actionable && result.status === "unresolved" });
}
function sort(items) { return [...items].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id)); }
function counts(items) { return { unresolvedBlockers: items.filter((item) => item.blocksMerge).length, dismissedCount: items.filter((item) => item.status === "dismissed").length, resolvedCount: items.filter((item) => item.status === "resolved").length }; }
function safeMarkdown(value) { return String(value).replace(/[\r\n]+/gu, " ").trim(); }
function itemLine(item) { const location = item.filePath === null ? "" : ` — ${item.filePath}${item.lineStart === null ? "" : `:${item.lineStart}${item.lineEnd && item.lineEnd !== item.lineStart ? `-${item.lineEnd}` : ""}`}`; return `- [${item.source}] \`${item.id}\`${location}: ${safeMarkdown(item.summary)}${item.actionable ? " (actionable)" : " (non-actionable)"}`; }
function list(items) { return items.length === 0 ? "- None" : items.map(itemLine).join("\n"); }

/** Render the generated section without replacing any manual text around it. */
export function renderReviewNotes(items, { timestamp: ingestedAt, activeSources, unavailableSources }) {
  const ordered = sort(items); const summary = counts(ordered); const dismissed = ordered.filter((item) => item.status === "dismissed");
  const decisions = dismissed.map((item) => `- \`${item.id}\`: dismissed by GPT at ${item.gptDecision.decidedAt}; ${safeMarkdown(item.gptDecision.dismissalReason)}`);
  return `${NOTES_START}\n# Review ingestion\n\nIngested at: ${ingestedAt}\n\n## Imported comments\n${list(ordered)}\n\n## Unresolved comments\n${list(ordered.filter((item) => item.status === "unresolved"))}\n\n## Resolved comments\n${list(ordered.filter((item) => item.status === "resolved"))}\n\n## Dismissed comments\n${list(dismissed)}\n\n## GPT decisions\n${decisions.length === 0 ? "- None" : decisions.join("\n")}\n\n## Review sources\n- Active: ${activeSources.length ? activeSources.join(", ") : "None"}\n- Unavailable: ${unavailableSources.length ? unavailableSources.join(", ") : "None"}\n\n## Current review-blocking status\n- Merge blocked by review comments: ${summary.unresolvedBlockers > 0 ? "yes" : "no"}\n- Unresolved actionable blockers: ${summary.unresolvedBlockers}\n${NOTES_END}\n`;
}
export function updateReviewNotes(projectPath, generated) {
  const destination = safeFile(projectPath, path.join(projectPath, "REVIEW_NOTES.md")); const existing = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : ""; const start = existing.indexOf(NOTES_START); const end = existing.indexOf(NOTES_END);
  let next;
  if (start !== -1 && end !== -1 && end >= start) next = `${existing.slice(0, start)}${generated}${existing.slice(end + NOTES_END.length).replace(/^\r?\n/u, "")}`;
  else if (start !== -1 || end !== -1) fail("REVIEW_NOTES.md contains an incomplete Hephaestus managed block.", "INVALID_REVIEW_NOTES");
  else next = existing === "" ? generated : `${existing.replace(/\s*$/u, "")}\n\n${generated}`;
  fs.writeFileSync(destination, next, "utf8"); return destination;
}
function failureState(state, message, retryable) { return { ...state, blocked: true, reviewStatus: "failed", mergeStatus: "blocked", review: { attempted: true, ingestionStatus: "failed", unresolvedBlockers: 0, dismissedCount: 0, resolvedCount: 0, activeSources: [], unavailableSources: [], mergeBlocked: true, ingestedAt: null, failureReason: message }, nextAction: retryable ? "retry-review-ingestion" : "manual-review-ingestion-required" }; }

/** Import a local fixture only. This function has no provider, GitHub, or merge capability. */
export function ingestReviewFixture({ allowedRoot, projectPath, fixturePath, state }) {
  const safeProjectPath = assertRealPathWithinRoot(allowedRoot, projectPath);
  const currentState = validateState(state);
  const fixture = parseFixture(readFixture(allowedRoot, fixturePath));
  if (fixture.kind === "failure") { const nextState = failureState(currentState, fixture.message, fixture.retryable); saveState(safeProjectPath, nextState); return Object.freeze({ status: "failed", state: nextState, retryable: fixture.retryable, error: fixture.message }); }
  const records = new Map(loadStored(safeProjectPath).map((item) => [item.id, item])); let duplicateCount = 0;
  for (const entry of fixture.comments) { const incoming = normalizeReviewItem(entry.raw, { timestamp: fixture.timestamp }); if (records.has(incoming.id)) duplicateCount += 1; records.set(incoming.id, merge(records.get(incoming.id), incoming, entry.statusExplicit)); }
  const items = sort([...records.values()]); const summary = counts(items); const mergeBlocked = summary.unresolvedBlockers > 0; const blocked = currentState.blocked || mergeBlocked;
  const savedReportPath = reportPath(safeProjectPath); fs.writeFileSync(savedReportPath, `${JSON.stringify({ version: 1, ingestedAt: fixture.timestamp, activeSources: fixture.activeSources, unavailableSources: fixture.unavailableSources, items }, null, 2)}\n`, "utf8");
  const notesPath = updateReviewNotes(safeProjectPath, renderReviewNotes(items, fixture));
  const nextState = { ...currentState, blocked, reviewStatus: mergeBlocked ? "blocked" : "ingested", mergeStatus: "blocked", review: { attempted: true, ingestionStatus: "succeeded", ...summary, activeSources: fixture.activeSources, unavailableSources: fixture.unavailableSources, mergeBlocked, ingestedAt: fixture.timestamp, failureReason: null }, lastSuccessfulStep: "review-ingestion", nextAction: mergeBlocked ? "review-decision-required" : (currentState.blocked ? currentState.nextAction : "review-complete") };
  saveState(safeProjectPath, nextState);
  return Object.freeze({ status: "completed", state: nextState, items: Object.freeze(items), duplicateCount, reportPath: savedReportPath, notesPath });
}
