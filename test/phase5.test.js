import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import { loadTestDeclaration, projectFingerprint, saveTestEvidence, verifyTestEvidence } from "../src/test-gate.js";

function makeContext() {
  const directory = fs.mkdtempSync(path.join(path.resolve("test"), "tmp-"));
  fs.writeFileSync(path.join(directory, "source.txt"), "original\n");
  fs.writeFileSync(path.join(directory, "TESTS.json"), JSON.stringify({ requiredCommands: [{ id: "unit", outputRequired: true }], watchedFiles: ["source.txt"] }));
  return directory;
}
function evidence(projectPath, commands = [{ id: "unit", exitCode: 0, stdout: "ok\n", stderr: "" }]) { return { projectFingerprint: projectFingerprint(projectPath, loadTestDeclaration(projectPath)), commands }; }
function code(error, expected) { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; }

test("passing structured test report is accepted and saved", () => { const p=makeContext(); try { const report=saveTestEvidence(p,evidence(p)); assert.ok(fs.existsSync(report)); assert.equal(verifyTestEvidence(p).status,"passed"); } finally { fs.rmSync(p,{recursive:true,force:true}); } });
test("failing command blocks the gate", () => { const p=makeContext(); try { saveTestEvidence(p,evidence(p,[{id:"unit",exitCode:1,stdout:"",stderr:"failed"}])); assert.deepEqual(verifyTestEvidence(p).status,"blocked"); } finally { fs.rmSync(p,{recursive:true,force:true}); } });
test("missing report and malformed report are rejected", () => { const p=makeContext(); try { assert.throws(()=>verifyTestEvidence(p),(e)=>code(e,"MISSING_TEST_EVIDENCE")); fs.mkdirSync(path.join(p,"out","test_reports"),{recursive:true}); fs.writeFileSync(path.join(p,"out","test_reports","evidence.json"),"tests passed"); assert.throws(()=>verifyTestEvidence(p),(e)=>code(e,"MALFORMED_TEST_EVIDENCE")); } finally { fs.rmSync(p,{recursive:true,force:true}); } });
test("missing command, exit code, and required output block safely", () => { const p=makeContext(); try { saveTestEvidence(p,evidence(p,[])); assert.equal(verifyTestEvidence(p).reason,"required-command-missing"); saveTestEvidence(p,{projectFingerprint:projectFingerprint(p,loadTestDeclaration(p)),commands:[{id:"unit",stdout:"x",stderr:""}]}); assert.throws(()=>verifyTestEvidence(p),(e)=>code(e,"MALFORMED_TEST_EVIDENCE")); saveTestEvidence(p,evidence(p,[{id:"unit",exitCode:0,stdout:"",stderr:""}])); assert.equal(verifyTestEvidence(p).reason,"required-output-missing"); } finally { fs.rmSync(p,{recursive:true,force:true}); } });
test("post-fix changes require retest", () => { const p=makeContext(); try { saveTestEvidence(p,evidence(p)); fs.writeFileSync(path.join(p,"source.txt"),"changed\n"); assert.equal(verifyTestEvidence(p).reason,"post-fix-retest-required"); } finally { fs.rmSync(p,{recursive:true,force:true}); } });
