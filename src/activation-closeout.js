import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "./agent-adapters.js";
import { HephaestusError, fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";
import { CLEANUP_WHITELIST, runActivationFixtureCleanup } from "./activation-fixture-hygiene.js";
import {
  READONLY_SMOKE_ARGV,
  READONLY_SMOKE_FLAGS,
  READONLY_SMOKE_PROMPT
} from "./agent-readonly-exec.js";
import {
  INSPECT_FLAGS,
  buildInspectArgv
} from "./agent-readonly-inspect.js";
import {
  STEP_6I_FLAGS,
  STEP_6I_MARKER,
  STEP_6I_PROMPT_RELATIVE,
  buildStep6iArgv,
  buildStep6iPrompt
} from "./agent-readonly-prompt-record.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/u;
const PATH_ERROR_CODES = new Set(["OUTSIDE_ALLOWED_ROOT", "INVALID_PATH", "UNSAFE_PATH", "INVALID_PROJECT_PATH", "PATH_RESOLUTION_FAILED"]);

const ALLOWED_REQUEST_KEYS = new Set([
  "allowedRoot", "projectPath", "projectId", "knownCommands",
  "explicitCloseoutPermit", "now", "writeReport", "repoRoot"
]);

const REQUIRED_COMMANDS = Object.freeze([
  "agent-codex-readonly-smoke",
  "agent-codex-readonly-inspect",
  "agent-codex-readonly-inspect-record",
  "agent-codex-readonly-prompt-record",
  "activation-clean-fixture-artifacts"
]);

const REQUIRED_MODULES = Object.freeze([
  "src/agent-readonly-exec.js",
  "src/agent-readonly-inspect.js",
  "src/agent-readonly-inspect-record.js",
  "src/agent-readonly-prompt-record.js",
  "src/activation-fixture-hygiene.js"
]);

const FORBIDDEN_SANDBOX_VALUES = Object.freeze(["workspace-write", "danger-full-access"]);

const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--add-dir",
  "--search",
  "-c"
]);

export const CLOSEOUT_REPORT_RELATIVE = "out/summaries/step-6k-readonly-codex-closeout.json";

export const CLASSIFICATIONS = Object.freeze({
  PASS: "STEP_6K_PASS",
  UNSAFE_PROJECT: "STEP_6K_BLOCKED_UNSAFE_PROJECT",
  MISSING_PROJECT: "STEP_6K_BLOCKED_MISSING_PROJECT",
  MISSING_COMMAND: "STEP_6K_BLOCKED_MISSING_COMMAND",
  MISSING_MODULE: "STEP_6K_BLOCKED_MISSING_MODULE",
  SAFETY_INVARIANT_WEAKENED: "STEP_6K_BLOCKED_SAFETY_INVARIANT_WEAKENED",
  CLEANUP_FAILED: "STEP_6K_BLOCKED_CLEANUP_FAILED",
  FIXTURE_DIRTY: "STEP_6K_BLOCKED_FIXTURE_DIRTY",
  REPORT_WRITE_FAILED: "STEP_6K_BLOCKED_REPORT_WRITE_FAILED",
  INVALID_REQUEST: "STEP_6K_BLOCKED_INVALID_REQUEST"
});

function defaultNow() { return new Date().toISOString(); }

function assertRequestShape(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Closeout request must be an object.", "INVALID_CLOSEOUT_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Closeout request contains an unsupported field: ${key}.`, "INVALID_CLOSEOUT_REQUEST");
    }
  }
}

function checkArgvSafety(argv) {
  const flat = argv.map((entry) => String(entry));
  for (const forbidden of FORBIDDEN_ARGV_TOKENS) if (flat.includes(forbidden)) return false;
  for (const forbiddenSandbox of FORBIDDEN_SANDBOX_VALUES) if (flat.includes(forbiddenSandbox)) return false;
  return true;
}

function checkFlags(flags) {
  return flags.shell === false
    && flags.sandbox === "read-only"
    && flags.askForApproval === "never";
}

function buildSafetyInvariantResults() {
  const results = [];

  results.push({ id: "step-6f.shell", ok: READONLY_SMOKE_FLAGS.shell === false });
  results.push({ id: "step-6f.sandbox-read-only", ok: READONLY_SMOKE_FLAGS.sandbox === "read-only" });
  results.push({ id: "step-6f.ask-for-approval-never", ok: READONLY_SMOKE_FLAGS.askForApproval === "never" });
  results.push({ id: "step-6f.argv-no-forbidden-tokens", ok: checkArgvSafety([...READONLY_SMOKE_ARGV]) });
  results.push({ id: "step-6f.prompt-hardcoded", ok: typeof READONLY_SMOKE_PROMPT === "string" && READONLY_SMOKE_PROMPT.length > 0 });

  results.push({ id: "step-6g.shell", ok: INSPECT_FLAGS.shell === false });
  results.push({ id: "step-6g.sandbox-read-only", ok: INSPECT_FLAGS.sandbox === "read-only" });
  results.push({ id: "step-6g.ask-for-approval-never", ok: INSPECT_FLAGS.askForApproval === "never" });
  let inspectArgvOk = false;
  try {
    const argv = buildInspectArgv("example-project");
    inspectArgvOk = checkArgvSafety([...argv]);
  } catch { inspectArgvOk = false; }
  results.push({ id: "step-6g.argv-no-forbidden-tokens", ok: inspectArgvOk });

  results.push({ id: "step-6i.shell", ok: STEP_6I_FLAGS.shell === false });
  results.push({ id: "step-6i.sandbox-read-only", ok: STEP_6I_FLAGS.sandbox === "read-only" });
  results.push({ id: "step-6i.ask-for-approval-never", ok: STEP_6I_FLAGS.askForApproval === "never" });
  results.push({ id: "step-6i.marker-pinned", ok: STEP_6I_MARKER === "HEPHAESTUS_STEP_6I_PROMPT_FILE_HANDOFF_OK" });
  results.push({ id: "step-6i.prompt-source-pinned", ok: STEP_6I_PROMPT_RELATIVE === "out/prompts/step-6i-readonly-prompt.md" });
  let step6iArgvOk = false;
  try {
    const prompt = buildStep6iPrompt("example-project");
    const argv = buildStep6iArgv(prompt);
    step6iArgvOk = checkArgvSafety([...argv]) && argv[argv.length - 1] === prompt;
  } catch { step6iArgvOk = false; }
  results.push({ id: "step-6i.argv-no-forbidden-tokens", ok: step6iArgvOk });

  const codexAdapter = getAdapter("codex");
  results.push({
    id: "real-agent.executionAllowed-false",
    ok: codexAdapter !== null && codexAdapter.kind === "real" && codexAdapter.executionAllowed === false
  });
  results.push({
    id: "real-agent.preflightSupported-true",
    ok: codexAdapter !== null && codexAdapter.preflightSupported === true
  });

  results.push({
    id: "cleanup.whitelist-narrow",
    ok: CLEANUP_WHITELIST.exactFiles.length === 7
      && CLEANUP_WHITELIST.exactFiles.includes("AGENT_OUTPUT.md")
      && CLEANUP_WHITELIST.exactFiles.includes("out/prompts/step-6i-readonly-prompt.md")
      && CLEANUP_WHITELIST.exactFiles.includes("out/prompts/step-6l-brain-readonly-prompt.md")
      && CLEANUP_WHITELIST.exactFiles.includes("out/prompts/step-6m-provider-readonly-prompt.md")
      && CLEANUP_WHITELIST.exactFiles.includes("out/brain_decisions/step-6l-mocked-brain-decision.json")
      && CLEANUP_WHITELIST.exactFiles.includes("out/brain_decisions/step-6m-provider-brain-decision.json")
      && CLEANUP_WHITELIST.exactFiles.includes("out/summaries/step-6k-readonly-codex-closeout.json")
      && CLEANUP_WHITELIST.patternedDirectories.length === 4
      && CLEANUP_WHITELIST.emptyDirectories.length === 5
  });

  return results;
}

function checkRequiredModules(repoRoot) {
  const missing = [];
  const checked = [];
  for (const relative of REQUIRED_MODULES) {
    const absolute = path.join(repoRoot, relative);
    const exists = fs.existsSync(absolute) && fs.statSync(absolute).isFile();
    checked.push(relative);
    if (!exists) missing.push(relative);
  }
  return { checked, missing };
}

function checkRequiredCommands(knownCommands) {
  const missing = [];
  for (const required of REQUIRED_COMMANDS) {
    if (!knownCommands.includes(required)) missing.push(required);
  }
  return { checked: [...REQUIRED_COMMANDS], missing };
}

function fixtureCleanCheck(projectPath) {
  const remaining = [];
  if (fs.existsSync(path.join(projectPath, "AGENT_OUTPUT.md"))) remaining.push("AGENT_OUTPUT.md");
  const out = path.join(projectPath, "out");
  if (fs.existsSync(out)) {
    try {
      const entries = fs.readdirSync(out);
      if (entries.length > 0) remaining.push(`out/ (entries: ${entries.join(",")})`);
    } catch { /* ignore */ }
  }
  return remaining;
}

function freezeReport({ classification, projectId, allowedRoot, projectPath, checkedCommands, missingCommands, checkedModules, missingModules, safetyInvariantResults, cleanupResult, fixtureClean, reportWritten, reportPath, repoRoot, planChanged, rootBuildLogCreated, rootStateJsonCreated, blockedReasons, recordedAt }) {
  const closeoutPassed = classification === CLASSIFICATIONS.PASS;
  const safetyOk = safetyInvariantResults.every((entry) => entry.ok === true);
  return Object.freeze({
    schema: "hephaestus.step-6k.activation-closeout/v1",
    classification,
    closeoutPassed,
    readonlyActivationComplete: closeoutPassed,
    workspaceWriteEnabled: false,
    arbitraryPromptExecutionEnabled: false,
    autonomousExecutionEnabled: false,
    project: Object.freeze({ id: projectId ?? null, allowedRoot: allowedRoot ?? null, resolvedPath: projectPath ?? null }),
    repoRoot,
    checkedCommands: Object.freeze([...checkedCommands]),
    missingCommands: Object.freeze([...missingCommands]),
    checkedModules: Object.freeze([...checkedModules]),
    missingModules: Object.freeze([...missingModules]),
    safetyInvariantResults: Object.freeze(safetyInvariantResults.map((entry) => Object.freeze({ ...entry }))),
    safetyInvariantsOk: safetyOk,
    cleanupResult: cleanupResult ?? null,
    fixtureClean,
    rootBuildLogCreated,
    rootStateJsonCreated,
    planChanged,
    reportWritten: reportWritten === true,
    reportPath: reportPath ?? null,
    nextAllowedStep: closeoutPassed ? "6L or later (design only)" : null,
    blockedReasons: Object.freeze([...blockedReasons]),
    step6lOrNextPhaseSafeToDesign: closeoutPassed,
    recordedAt,
    manualAction: closeoutPassed ? null : "Resolve the listed blocked reasons before designing the next step."
  });
}

/** Audit the Step 6F–6J real-Codex read-only activation chain and emit a closeout report; never runs real Codex. */
export function runActivationCloseoutReadonlyCodex(request) {
  assertRequestShape(request);
  if (request.explicitCloseoutPermit !== true) {
    fail("Activation closeout requires explicitCloseoutPermit=true.", "CLOSEOUT_PERMIT_REQUIRED");
  }
  if (typeof request.allowedRoot !== "string" || request.allowedRoot.length === 0) {
    fail("Activation closeout requires allowedRoot.", "INVALID_CLOSEOUT_REQUEST");
  }
  if (typeof request.projectPath !== "string" || request.projectPath.length === 0) {
    fail("Activation closeout requires projectPath.", "INVALID_CLOSEOUT_REQUEST");
  }
  if (typeof request.projectId !== "string" || !PROJECT_ID_PATTERN.test(request.projectId)) {
    fail("Activation closeout requires a safe projectId.", "INVALID_CLOSEOUT_REQUEST");
  }
  if (!Array.isArray(request.knownCommands) || !request.knownCommands.every((entry) => typeof entry === "string")) {
    fail("Activation closeout requires a knownCommands string array.", "INVALID_CLOSEOUT_REQUEST");
  }

  const projectId = request.projectId;
  const allowedRoot = path.resolve(request.allowedRoot);
  const repoRoot = typeof request.repoRoot === "string" && request.repoRoot.length > 0
    ? path.resolve(request.repoRoot)
    : process.cwd();
  const now = typeof request.now === "function" ? request.now : defaultNow;
  const writeReport = request.writeReport === true;
  const recordedAt = now();

  let projectPath = null;
  try {
    projectPath = resolveSafePath(allowedRoot, request.projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeReport({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath: null,
        checkedCommands: [], missingCommands: [],
        checkedModules: [], missingModules: [],
        safetyInvariantResults: [], cleanupResult: null,
        fixtureClean: false, reportWritten: false, reportPath: null, repoRoot,
        planChanged: false, rootBuildLogCreated: false, rootStateJsonCreated: false,
        blockedReasons: ["unsafe-project-path"], recordedAt
      });
    }
    throw error;
  }
  if (!fs.existsSync(projectPath)) {
    return freezeReport({
      classification: CLASSIFICATIONS.MISSING_PROJECT,
      projectId, allowedRoot, projectPath,
      checkedCommands: [], missingCommands: [],
      checkedModules: [], missingModules: [],
      safetyInvariantResults: [], cleanupResult: null,
      fixtureClean: false, reportWritten: false, reportPath: null, repoRoot,
      planChanged: false, rootBuildLogCreated: false, rootStateJsonCreated: false,
      blockedReasons: ["missing-project"], recordedAt
    });
  }
  try {
    assertRealPathWithinRoot(allowedRoot, projectPath);
  } catch (error) {
    if (error instanceof HephaestusError && PATH_ERROR_CODES.has(error.code)) {
      return freezeReport({
        classification: CLASSIFICATIONS.UNSAFE_PROJECT,
        projectId, allowedRoot, projectPath,
        checkedCommands: [], missingCommands: [],
        checkedModules: [], missingModules: [],
        safetyInvariantResults: [], cleanupResult: null,
        fixtureClean: false, reportWritten: false, reportPath: null, repoRoot,
        planChanged: false, rootBuildLogCreated: false, rootStateJsonCreated: false,
        blockedReasons: ["unsafe-project-realpath"], recordedAt
      });
    }
    throw error;
  }

  const blockedReasons = [];

  const { checked: checkedCommands, missing: missingCommands } = checkRequiredCommands(request.knownCommands);
  const { checked: checkedModules, missing: missingModules } = checkRequiredModules(repoRoot);
  const safetyInvariantResults = buildSafetyInvariantResults();

  const cleanupResult = runActivationFixtureCleanup({
    allowedRoot: request.allowedRoot,
    projectPath: request.projectPath,
    projectId,
    explicitCleanupPermit: true,
    now
  });
  const cleanupOk = cleanupResult.cleanupSafe === true;

  const fixtureRemaining = fixtureCleanCheck(projectPath);
  const fixtureClean = fixtureRemaining.length === 0;

  const rootBuildLogCreated = fs.existsSync(path.join(repoRoot, "BUILD_LOG.md"));
  const rootStateJsonCreated = fs.existsSync(path.join(repoRoot, "STATE.json"));
  const planChanged = false;

  if (missingCommands.length > 0) blockedReasons.push(`missing-commands:${missingCommands.join(",")}`);
  if (missingModules.length > 0) blockedReasons.push(`missing-modules:${missingModules.join(",")}`);
  const failedInvariants = safetyInvariantResults.filter((entry) => entry.ok !== true).map((entry) => entry.id);
  if (failedInvariants.length > 0) blockedReasons.push(`safety-invariants-weakened:${failedInvariants.join(",")}`);
  if (!cleanupOk) blockedReasons.push("cleanup-failed");
  if (!fixtureClean) blockedReasons.push(`fixture-dirty:${fixtureRemaining.join(",")}`);
  if (rootBuildLogCreated) blockedReasons.push("root-build-log-exists");
  if (rootStateJsonCreated) blockedReasons.push("root-state-json-exists");

  let classification;
  if (missingCommands.length > 0) classification = CLASSIFICATIONS.MISSING_COMMAND;
  else if (missingModules.length > 0) classification = CLASSIFICATIONS.MISSING_MODULE;
  else if (failedInvariants.length > 0) classification = CLASSIFICATIONS.SAFETY_INVARIANT_WEAKENED;
  else if (!cleanupOk) classification = CLASSIFICATIONS.CLEANUP_FAILED;
  else if (!fixtureClean) classification = CLASSIFICATIONS.FIXTURE_DIRTY;
  else classification = CLASSIFICATIONS.PASS;

  let reportWritten = false;
  let reportPath = null;
  if (writeReport && classification === CLASSIFICATIONS.PASS) {
    try {
      const reportAbsolute = resolveSafePath(projectPath, CLOSEOUT_REPORT_RELATIVE);
      fs.mkdirSync(path.dirname(reportAbsolute), { recursive: true });
      const payload = {
        schema: "hephaestus.step-6k.activation-closeout/v1",
        classification,
        project: projectId,
        recordedAt,
        readonlyActivationComplete: true,
        workspaceWriteEnabled: false,
        arbitraryPromptExecutionEnabled: false,
        autonomousExecutionEnabled: false,
        checkedCommands,
        missingCommands,
        checkedModules,
        missingModules,
        safetyInvariantResults,
        cleanup: cleanupResult,
        fixtureClean,
        nextAllowedStep: "6L or later (design only)"
      };
      fs.writeFileSync(reportAbsolute, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
      reportWritten = true;
      reportPath = CLOSEOUT_REPORT_RELATIVE;
    } catch (error) {
      blockedReasons.push(`report-write-failed:${error?.code ?? "unknown"}`);
      classification = CLASSIFICATIONS.REPORT_WRITE_FAILED;
    }
  }

  return freezeReport({
    classification,
    projectId, allowedRoot, projectPath,
    checkedCommands, missingCommands,
    checkedModules, missingModules,
    safetyInvariantResults, cleanupResult,
    fixtureClean, reportWritten, reportPath, repoRoot,
    planChanged, rootBuildLogCreated, rootStateJsonCreated,
    blockedReasons, recordedAt
  });
}
