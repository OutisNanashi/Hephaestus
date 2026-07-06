import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import { dirtyIgnoringConductorArtifacts, fetchGithubMergeEvidence, openGithubPr } from "../src/github-workflow.js";
import { loadTestDeclaration, recordDeclaredTests, verifyTestEvidence } from "../src/test-gate.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const NODE = process.execPath;

function makeProject({ argv = [NODE, "-e", "console.log('unit-ok')"], rawArgv } = {}) {
  const directory = writableTemporaryDirectory("hephaestus-record-tests-");
  const project = path.join(directory, "demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "source.txt"), "source\n");
  const command = { id: "unit", outputRequired: true, ...(rawArgv !== undefined ? { argv: rawArgv } : argv === null ? {} : { argv }) };
  fs.writeFileSync(path.join(project, "TESTS.json"), `${JSON.stringify({ requiredCommands: [command], watchedFiles: ["source.txt"] })}\n`);
  return { directory, project };
}

function cleanup(context) {
  fs.rmSync(context.directory, { recursive: true, force: true });
}

test("recordDeclaredTests runs the declared command and records evidence the gate verifies", () => {
  const context = makeProject();
  try {
    const result = recordDeclaredTests(context.project);
    assert.equal(result.verification.status, "passed");
    assert.deepEqual(result.commands, [{ id: "unit", exitCode: 0 }]);
    const evidence = JSON.parse(fs.readFileSync(path.join(context.project, "out", "test_reports", "evidence.json"), "utf8"));
    assert.equal(evidence.recordedBy, "conductor-record-tests");
    assert.match(evidence.commands[0].stdout, /unit-ok/u);
    assert.equal(verifyTestEvidence(context.project).status, "passed");
  } finally {
    cleanup(context);
  }
});

test("recordDeclaredTests records a failing command and the gate blocks it", () => {
  const context = makeProject({ argv: [NODE, "-e", "console.error('boom'); process.exit(3)"] });
  try {
    const result = recordDeclaredTests(context.project);
    assert.equal(result.verification.status, "blocked");
    assert.equal(result.verification.reason, "command-failed");
    assert.deepEqual(result.commands, [{ id: "unit", exitCode: 3 }]);
  } finally {
    cleanup(context);
  }
});

test("recordDeclaredTests refuses a declared command without argv", () => {
  const context = makeProject({ argv: null });
  try {
    assert.throws(() => recordDeclaredTests(context.project), (error) => {
      assert.ok(error instanceof HephaestusError);
      assert.equal(error.code, "TEST_COMMAND_NOT_RUNNABLE");
      return true;
    });
    assert.equal(fs.existsSync(path.join(context.project, "out", "test_reports", "evidence.json")), false);
  } finally {
    cleanup(context);
  }
});

test("TESTS.json rejects a malformed argv declaration", () => {
  const context = makeProject({ rawArgv: "npm test" });
  try {
    assert.throws(() => loadTestDeclaration(context.project), (error) => {
      assert.ok(error instanceof HephaestusError);
      assert.equal(error.code, "MALFORMED_TEST_DECLARATION");
      return true;
    });
  } finally {
    cleanup(context);
  }
});

test("recordDeclaredTests never passes brain or Telegram secrets to test commands", () => {
  const context = makeProject({ argv: [NODE, "-e", "console.log(`key=${process.env.OPENAI_API_KEY ?? \"absent\"} tg=${process.env.TELEGRAM_BOT_TOKEN ?? \"absent\"}`)"] });
  try {
    const result = recordDeclaredTests(context.project, {
      env: { ...process.env, OPENAI_API_KEY: "super-secret", TELEGRAM_BOT_TOKEN: "tg-secret" }
    });
    assert.equal(result.verification.status, "passed");
    const evidence = JSON.parse(fs.readFileSync(path.join(context.project, "out", "test_reports", "evidence.json"), "utf8"));
    assert.match(evidence.commands[0].stdout, /key=absent tg=absent/u);
  } finally {
    cleanup(context);
  }
});

const prState = Object.freeze({
  currentPhase: "1", currentTask: "demo-task", currentBranch: "hephaestus/demo/demo-task", currentPr: null,
  assignedAgent: "codex", attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: "agent-run", mergeStatus: "blocked",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "merge-readiness"
});

function makePrProject() {
  const directory = writableTemporaryDirectory("hephaestus-pr-push-");
  const project = path.join(directory, "demo");
  fs.mkdirSync(project, { recursive: true });
  for (const name of ["PLAN.md", "BUILDING_REFERENCE.md", "BUILD_LOG.md", "CURRENT_TASK.md"]) {
    fs.writeFileSync(path.join(project, name), `${name} fixture\n`);
  }
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(prState, null, 2)}\n`);
  execFileSync("git", ["init", "-q", "-b", "hephaestus/demo/demo-task"], { cwd: project });
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: project });
  return { directory, project };
}

function prSpawn({ pushStatus = 0 } = {}, capture = {}) {
  capture.calls = [];
  return (executable, args) => {
    capture.calls.push([executable, ...args]);
    if (executable === "git" && args[0] === "push") return { status: pushStatus, stdout: "", stderr: pushStatus === 0 ? "" : "remote rejected" };
    if (executable === "gh" && args[0] === "pr" && args[1] === "view" && args.includes("number,url,state")) {
      return { status: 1, stdout: "", stderr: "no pull requests found" };
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "create") return { status: 0, stdout: "", stderr: "" };
    if (executable === "gh" && args[0] === "pr" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ url: "https://example.test/pr/1" }), stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected spawn: ${executable} ${args.join(" ")}` };
  };
}

test("openGithubPr publishes the branch with a normal push before creating the PR", () => {
  const context = makePrProject();
  try {
    const capture = {};
    const pr = openGithubPr({ projectPath: context.project, state: prState, title: "Hephaestus: demo-task", spawn: prSpawn({}, capture) });
    assert.equal(pr.status, "open");
    assert.deepEqual(capture.calls[0], ["git", "push", "--set-upstream", "origin", "hephaestus/demo/demo-task"]);
    const flat = capture.calls.flat();
    for (const forbidden of ["--force", "-f", "--force-with-lease"]) {
      assert.equal(flat.includes(forbidden), false, `push must never use ${forbidden}`);
    }
  } finally {
    cleanup(context);
  }
});

function mergeEvidenceSpawn(mergeableSequence) {
  let view = 0;
  return (executable, args) => {
    if (executable === "gh" && args[0] === "pr" && args[1] === "view") {
      const mergeable = mergeableSequence[Math.min(view, mergeableSequence.length - 1)];
      view += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 1, url: "https://example.test/pr/1", state: "OPEN",
          headRefName: "hephaestus/demo/demo-task", baseRefName: "master",
          mergeable, headRefOid: "abc123"
        }),
        stderr: ""
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected spawn: ${executable} ${args.join(" ")}` };
  };
}

test("fetchGithubMergeEvidence polls until GitHub resolves UNKNOWN mergeability", () => {
  const context = makePrProject();
  try {
    const sleeps = [];
    const evidence = fetchGithubMergeEvidence({
      projectPath: context.project, state: prState, projectId: "demo",
      spawn: mergeEvidenceSpawn(["UNKNOWN", "UNKNOWN", "MERGEABLE"]),
      sleep: (ms) => sleeps.push(ms)
    });
    assert.equal(evidence.pr.mergeable, true);
    assert.equal(sleeps.length, 2);
  } finally {
    cleanup(context);
  }
});

test("fetchGithubMergeEvidence stops polling and reports unclear mergeability after the attempt budget", () => {
  const context = makePrProject();
  try {
    const sleeps = [];
    const evidence = fetchGithubMergeEvidence({
      projectPath: context.project, state: prState, projectId: "demo",
      spawn: mergeEvidenceSpawn(["UNKNOWN"]),
      sleep: (ms) => sleeps.push(ms)
    });
    assert.equal(evidence.pr.mergeable, null);
    assert.equal(sleeps.length, 5);
  } finally {
    cleanup(context);
  }
});

test("dirty parsing ignores conductor artifacts even when the first porcelain line lost its leading space", () => {
  // git() trims stdout, so " M BUILD_LOG.md\n M STATE.json" arrives as "M BUILD_LOG.md\n M STATE.json".
  assert.equal(dirtyIgnoringConductorArtifacts("M BUILD_LOG.md\n M STATE.json"), false);
  assert.equal(dirtyIgnoringConductorArtifacts("M STATE.json\n?? out/test_reports/evidence.json"), false);
  assert.equal(dirtyIgnoringConductorArtifacts("M src/calc.js\n M STATE.json"), true);
  assert.equal(dirtyIgnoringConductorArtifacts("?? untracked.txt"), true);
  assert.equal(dirtyIgnoringConductorArtifacts(""), false);
});

test("merge evidence reports a clean tree when only conductor artifacts changed (through real git)", () => {
  const context = makePrProject();
  try {
    fs.appendFileSync(path.join(context.project, "BUILD_LOG.md"), "[test] conductor churn\n");
    fs.writeFileSync(path.join(context.project, "STATE.json"), `${JSON.stringify({ ...prState, attemptCount: 1 }, null, 2)}\n`);
    const clean = fetchGithubMergeEvidence({
      projectPath: context.project, state: prState, projectId: "demo",
      spawn: mergeEvidenceSpawn(["MERGEABLE"]), sleep: () => {}
    });
    assert.equal(clean.dirty, false);
    fs.appendFileSync(path.join(context.project, "PLAN.md"), "real change\n");
    const dirty = fetchGithubMergeEvidence({
      projectPath: context.project, state: prState, projectId: "demo",
      spawn: mergeEvidenceSpawn(["MERGEABLE"]), sleep: () => {}
    });
    assert.equal(dirty.dirty, true);
  } finally {
    cleanup(context);
  }
});

test("openGithubPr stops cleanly when the push is rejected and never reaches gh", () => {
  const context = makePrProject();
  try {
    const capture = {};
    assert.throws(() => openGithubPr({ projectPath: context.project, state: prState, title: "Hephaestus: demo-task", spawn: prSpawn({ pushStatus: 1 }, capture) }), (error) => {
      assert.ok(error instanceof HephaestusError);
      assert.equal(error.code, "GIT_WORKFLOW_FAILED");
      return true;
    });
    assert.equal(capture.calls.some(([executable]) => executable === "gh"), false);
  } finally {
    cleanup(context);
  }
});
