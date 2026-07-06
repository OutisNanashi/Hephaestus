import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HephaestusError } from "../src/errors.js";
import { isTransientNetworkError, openGithubPr } from "../src/github-workflow.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

const state = Object.freeze({
  currentPhase: "1", currentTask: "task", currentBranch: "hephaestus/demo/task", currentPr: null,
  assignedAgent: "codex", attemptCount: 0, blocked: false, usageLimitPaused: false,
  lastSuccessfulStep: "agent-run", mergeStatus: "blocked",
  containerStatus: "not-started", lastGptDecision: null, nextAction: "agent-completed"
});

function makeRepo() {
  const directory = writableTemporaryDirectory("hephaestus-gh-retry-");
  const project = path.join(directory, "demo");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "hephaestus/demo/task", project]);
  execFileSync("git", ["config", "user.email", "t@local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "t"], { cwd: project });
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(path.join(project, "file.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: project });
  return { directory, project };
}

function cleanup(context) {
  fs.rmSync(context.directory, { recursive: true, force: true });
}

// Fake spawn: push succeeds, no existing PR, `pr create` fails `createFailures`
// times with the exact transient message before succeeding.
function retrySpawn({ createFailures = 1, createError = "pull request create failed: HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)" } = {}, capture = {}) {
  capture.createCalls = 0;
  return (exe, args) => {
    if (exe === "git" && args[0] === "push") return { status: 0, stdout: "", stderr: "" };
    if (exe === "gh" && args[1] === "view" && args.includes("number,url,state")) return { status: 1, stdout: "", stderr: "no pull requests found for the given branch" };
    if (exe === "gh" && args[1] === "create") {
      capture.createCalls += 1;
      if (capture.createCalls <= createFailures) return { status: 1, stdout: "", stderr: createError };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (exe === "gh" && args[1] === "view" && args.includes("url")) return { status: 0, stdout: JSON.stringify({ url: "https://github.com/demo/demo/pull/9" }), stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
}

test("isTransientNetworkError classifies GitHub blips but not real failures", () => {
  for (const transient of ["HTTP 504: Gateway Timeout", "502 Bad Gateway", "503 Service Unavailable", "could not resolve host: github.com", "connection reset by peer", "the remote end hung up unexpectedly", "please try again later"]) {
    assert.equal(isTransientNetworkError(transient), true, transient);
  }
  for (const real of ["not authenticated", "gh: Not Found (HTTP 404)", "permission denied", "a pull request already exists", "merge conflict"]) {
    assert.equal(isTransientNetworkError(real), false, real);
  }
});

test("a transient 504 on pr-create is retried and the PR is created", () => {
  const context = makeRepo();
  const capture = {};
  try {
    const metadata = openGithubPr({
      projectPath: context.project, state, title: "Demo",
      spawn: retrySpawn({ createFailures: 2 }, capture),
      sleep: () => {}
    });
    assert.equal(metadata.status, "open");
    assert.equal(metadata.url, "https://github.com/demo/demo/pull/9");
    assert.equal(capture.createCalls, 3, "two transient failures then success");
  } finally { cleanup(context); }
});

test("a non-transient pr-create failure aborts immediately without retrying", () => {
  const context = makeRepo();
  const capture = {};
  try {
    assert.throws(() => openGithubPr({
      projectPath: context.project, state, title: "Demo",
      spawn: retrySpawn({ createFailures: 5, createError: "not authenticated. run gh auth login" }, capture),
      sleep: () => { throw new Error("must not sleep on a non-transient error"); }
    }), (error) => {
      assert.ok(error instanceof HephaestusError);
      assert.equal(error.code, "GITHUB_WORKFLOW_FAILED");
      return true;
    });
    assert.equal(capture.createCalls, 1, "no retry on a real failure");
  } finally { cleanup(context); }
});

test("openGithubPr refuses to open a PR from the base branch before touching the network", () => {
  const directory = writableTemporaryDirectory("hephaestus-gh-base-");
  const project = path.join(directory, "demo");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "master", project]);
  execFileSync("git", ["config", "user.email", "t@local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "t"], { cwd: project });
  fs.writeFileSync(path.join(project, "STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(path.join(project, "file.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: project });
  try {
    assert.throws(() => openGithubPr({
      projectPath: project, state, title: "Demo",
      spawn: () => { throw new Error("spawn must not run for a base-branch PR"); },
      sleep: () => {}
    }), (error) => {
      assert.ok(error instanceof HephaestusError);
      assert.equal(error.code, "GITHUB_WORKFLOW_FAILED");
      return true;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("transient failures past the attempt budget give up with the workflow error code", () => {
  const context = makeRepo();
  const capture = {};
  try {
    assert.throws(() => openGithubPr({
      projectPath: context.project, state, title: "Demo",
      spawn: retrySpawn({ createFailures: 99 }, capture),
      sleep: () => {}
    }), (error) => error.code === "GITHUB_WORKFLOW_FAILED");
    assert.equal(capture.createCalls, 4, "bounded to four attempts");
  } finally { cleanup(context); }
});
