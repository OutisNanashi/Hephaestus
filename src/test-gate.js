import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail, HephaestusError } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

const DECLARATION = "TESTS.json";
const REPORT = path.join("out", "test_reports", "evidence.json");
const TEST_COMMAND_TIMEOUT_MS = 600_000;

function readJson(projectPath, relativePath, label) {
  let filePath;
  try {
    filePath = resolveSafePath(projectPath, relativePath);
  } catch (error) {
    if (error instanceof HephaestusError) throw error;
    fail(`${label} path is invalid.`, "MISSING_TEST_EVIDENCE");
  }
  if (!fs.existsSync(filePath)) fail(`${label} is missing or unreadable.`, "MISSING_TEST_EVIDENCE");
  assertRealPathWithinRoot(projectPath, filePath);
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch (error) { fail(`${label} is missing or unreadable.`, "MISSING_TEST_EVIDENCE"); }
  try { return JSON.parse(text); } catch (error) { fail(`${label} is malformed JSON.`, "MALFORMED_TEST_EVIDENCE"); }
}

function validRelativeFile(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/u).includes("..");
}

function validArgv(value) {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.every((token) => typeof token === "string" && token.trim() !== ""));
}

export function loadTestDeclaration(projectPath) {
  const value = readJson(projectPath, DECLARATION, "TESTS.json");
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.requiredCommands) || !Array.isArray(value.watchedFiles)) fail("TESTS.json has an invalid schema.", "MALFORMED_TEST_DECLARATION");
  if (value.requiredCommands.length === 0 || value.requiredCommands.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.outputRequired !== "boolean" || !validArgv(entry.argv))) fail("TESTS.json requiredCommands is invalid.", "MALFORMED_TEST_DECLARATION");
  if (new Set(value.requiredCommands.map((entry) => entry.id)).size !== value.requiredCommands.length || value.watchedFiles.some((file) => !validRelativeFile(file))) fail("TESTS.json contains duplicate commands or unsafe watched files.", "MALFORMED_TEST_DECLARATION");
  return Object.freeze({ requiredCommands: Object.freeze(value.requiredCommands.map((entry) => Object.freeze({ id: entry.id, outputRequired: entry.outputRequired, ...(entry.argv === undefined ? {} : { argv: Object.freeze([...entry.argv]) }) }))), watchedFiles: Object.freeze([...value.watchedFiles]) });
}

export function projectFingerprint(projectPath, declaration) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of [...declaration.watchedFiles].sort()) {
    const filePath = path.join(projectPath, relativePath);
    hash.update(relativePath); hash.update("\0");
    // A watched file may not exist yet (declared for a later phase). Its absence
    // is fingerprinted, so creating it later still forces a fresh retest.
    if (fs.existsSync(filePath)) {
      assertRealPathWithinRoot(projectPath, filePath);
      hash.update("1\0"); hash.update(fs.readFileSync(filePath));
    } else {
      hash.update("0\0");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function reportPath(projectPath) { return path.join(projectPath, REPORT); }

export function saveTestEvidence(projectPath, evidence) {
  const directory = path.dirname(reportPath(projectPath));
  for (const part of [path.join(projectPath, "out"), directory]) { if (!fs.existsSync(part)) fs.mkdirSync(part); assertRealPathWithinRoot(projectPath, part); }
  fs.writeFileSync(reportPath(projectPath), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return reportPath(projectPath);
}

export function verifyTestEvidence(projectPath) {
  const declaration = loadTestDeclaration(projectPath);
  const fingerprint = projectFingerprint(projectPath, declaration);
  const evidence = readJson(projectPath, REPORT, "Test evidence report");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || typeof evidence.projectFingerprint !== "string" || !Array.isArray(evidence.commands)) fail("Test evidence report has an invalid schema.", "MALFORMED_TEST_EVIDENCE");
  if (evidence.projectFingerprint !== fingerprint) return Object.freeze({ status: "blocked", reason: "post-fix-retest-required", projectFingerprint: fingerprint });
  const commands = new Map();
  for (const command of evidence.commands) {
    if (!command || typeof command.id !== "string" || !Number.isInteger(command.exitCode) || typeof command.stdout !== "string" || typeof command.stderr !== "string") fail("Test evidence command record is malformed.", "MALFORMED_TEST_EVIDENCE");
    if (commands.has(command.id)) fail("Test evidence contains duplicate command records.", "MALFORMED_TEST_EVIDENCE");
    commands.set(command.id, command);
  }
  for (const required of declaration.requiredCommands) {
    const command = commands.get(required.id);
    if (!command) return Object.freeze({ status: "blocked", reason: "required-command-missing", commandId: required.id, projectFingerprint: fingerprint });
    if (command.exitCode !== 0) return Object.freeze({ status: "blocked", reason: "command-failed", commandId: required.id, projectFingerprint: fingerprint });
    if (required.outputRequired && `${command.stdout}${command.stderr}`.trim() === "") return Object.freeze({ status: "blocked", reason: "required-output-missing", commandId: required.id, projectFingerprint: fingerprint });
  }
  return Object.freeze({ status: "passed", projectFingerprint: fingerprint, requiredCommands: declaration.requiredCommands.map((entry) => entry.id) });
}

// Test commands run with the same minimal environment policy as the coding
// agent: locale, PATH, and home locations only — never the brain or Telegram secrets.
function safeTestEnvironment(env) {
  const safe = { LANG: "C.UTF-8", PATH: env.PATH ?? env.Path ?? env.path ?? "" };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"]) {
    if (typeof env[key] === "string" && env[key] !== "") safe[key] = env[key];
  }
  return safe;
}

function defaultTestSpawn(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false });
}

/**
 * Run every TESTS.json-declared command inside the project and record the
 * structured evidence the merge gate verifies. The conductor runs the commands
 * itself (shell-less, secret-free environment), so evidence never depends on
 * agent claims. Returns the saved report path plus the gate's verification.
 */
export function recordDeclaredTests(projectPath, { spawn = defaultTestSpawn, env = process.env, timeoutMs = TEST_COMMAND_TIMEOUT_MS, now = () => new Date().toISOString() } = {}) {
  const declaration = loadTestDeclaration(projectPath);
  const commands = [];
  for (const required of declaration.requiredCommands) {
    if (required.argv === undefined) {
      fail(`TESTS.json command ${required.id} declares no argv, so the conductor cannot run it.`, "TEST_COMMAND_NOT_RUNNABLE");
    }
    const result = spawn(required.argv[0], required.argv.slice(1), {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      shell: false,
      cwd: projectPath,
      env: safeTestEnvironment(env),
      input: ""
    });
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL") {
      fail(`Test command ${required.id} timed out.`, "TEST_COMMAND_TIMED_OUT");
    }
    if (result.error) fail(`Test command ${required.id} could not start: ${result.error.message}`, "TEST_COMMAND_FAILED_TO_START");
    commands.push({
      id: required.id,
      exitCode: typeof result.status === "number" ? result.status : -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    });
  }
  // Fingerprint after the run so the evidence matches the exact files the gate will re-hash.
  const evidence = {
    recordedAt: now(),
    recordedBy: "conductor-record-tests",
    projectFingerprint: projectFingerprint(projectPath, declaration),
    commands
  };
  const reportPath = saveTestEvidence(projectPath, evidence);
  return Object.freeze({
    reportPath,
    verification: verifyTestEvidence(projectPath),
    commands: Object.freeze(commands.map((command) => Object.freeze({ id: command.id, exitCode: command.exitCode })))
  });
}
