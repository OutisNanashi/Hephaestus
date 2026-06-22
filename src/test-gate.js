import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail, HephaestusError } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

const DECLARATION = "TESTS.json";
const REPORT = path.join("out", "test_reports", "evidence.json");

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

export function loadTestDeclaration(projectPath) {
  const value = readJson(projectPath, DECLARATION, "TESTS.json");
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.requiredCommands) || !Array.isArray(value.watchedFiles)) fail("TESTS.json has an invalid schema.", "MALFORMED_TEST_DECLARATION");
  if (value.requiredCommands.length === 0 || value.requiredCommands.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.outputRequired !== "boolean")) fail("TESTS.json requiredCommands is invalid.", "MALFORMED_TEST_DECLARATION");
  if (new Set(value.requiredCommands.map((entry) => entry.id)).size !== value.requiredCommands.length || value.watchedFiles.some((file) => !validRelativeFile(file))) fail("TESTS.json contains duplicate commands or unsafe watched files.", "MALFORMED_TEST_DECLARATION");
  return Object.freeze({ requiredCommands: Object.freeze(value.requiredCommands.map((entry) => Object.freeze({ id: entry.id, outputRequired: entry.outputRequired }))), watchedFiles: Object.freeze([...value.watchedFiles]) });
}

export function projectFingerprint(projectPath, declaration) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of [...declaration.watchedFiles].sort()) {
    const filePath = path.join(projectPath, relativePath);
    assertRealPathWithinRoot(projectPath, filePath);
    hash.update(relativePath); hash.update("\0"); hash.update(fs.readFileSync(filePath)); hash.update("\0");
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
