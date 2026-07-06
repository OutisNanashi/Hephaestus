import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_MERGE_MODE, finishRunLive, MANUAL_MERGE_MODE, MERGE_PIPELINE } from "../src/auto-merge.js";
import { HephaestusError } from "../src/errors.js";
import { run } from "../src/cli.js";

const config = Object.freeze({ allowedRoot: "/projects", brain: { model: "test-model" } });
const project = Object.freeze({ id: "demo", path: "/projects/demo" });
const state = Object.freeze({ currentTask: "demo-task", currentPhase: "1" });
const completeLoop = Object.freeze({ status: "task-complete", reason: "done", cycles: [] });

function deps({ approved = true, merged = true, pending = true } = {}) {
  const calls = [];
  const api = {
    calls,
    validateProjectDirectory: () => {
      calls.push("validate");
      return { path: project.path, state };
    },
    hasPendingChanges: () => {
      calls.push("pending-check");
      return pending;
    },
    commitTask: (repo, message) => {
      calls.push("git-commit");
      assert.equal(repo, project.path);
      assert.equal(message, "Hephaestus: demo-task");
      return { hash: "commit123", branch: "hephaestus/demo/demo-task", message };
    },
    recordDeclaredTests: () => {
      calls.push("record-tests");
      return { reportPath: "/projects/demo/out/test_reports/evidence.json", verification: { status: "passed" }, commands: [{ id: "unit", exitCode: 0 }] };
    },
    openGithubPr: () => {
      calls.push("pr-open");
      return { status: "open", url: "https://example.test/pr/1" };
    },
    fetchGithubMergeEvidence: () => {
      calls.push("fetch-evidence");
      return { project: project.id, phase: "1", pr: { number: 1, headCommit: "abc123" } };
    },
    verifyTestEvidence: () => {
      calls.push("verify-tests");
      return { status: "passed" };
    },
    requestMergeApproval: async () => {
      calls.push("merge-approve");
      return approved ? { approved: true, rationale: "ok" } : { approved: false, rationale: "no" };
    },
    saveApproval: () => {
      calls.push("save-approval");
      return "/projects/demo/merge-inbox/approval.json";
    },
    executeGithubMerge: () => {
      calls.push("merge-execute");
      return { merged, mergeCommit: merged ? "merge123" : null, blockers: merged ? [] : ["DIRTY_WORKTREE"] };
    }
  };
  return api;
}

test("default run-live is Manual-merge Mode and does not call merge functions", async () => {
  const fake = deps();
  const result = await finishRunLive({ config, project, loop: completeLoop, deps: fake });
  assert.equal(result.mode, MANUAL_MERGE_MODE);
  assert.equal(result.autoMerge, false);
  assert.deepEqual(result.mergePipeline, MERGE_PIPELINE);
  assert.deepEqual(fake.calls, []);
});

test("run-live --manual-merge is accepted and behaves like default Manual-merge Mode", async () => {
  assert.throws(() => run(["run-live", "--manual-merge"]), (error) => {
    assert.ok(error instanceof HephaestusError);
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /requires the async CLI runner/u);
    assert.doesNotMatch(error.message, /Unknown option|cannot be used together|only apply/u);
    return true;
  });

  const defaultFake = deps();
  const manualFake = deps();
  const defaultResult = await finishRunLive({ config, project, loop: completeLoop, deps: defaultFake });
  const manualResult = await finishRunLive({ mode: MANUAL_MERGE_MODE, config, project, loop: completeLoop, deps: manualFake });
  const relevantManualFields = (result) => ({
    mode: result.mode,
    autoMerge: result.autoMerge,
    mergePipeline: result.mergePipeline,
    merge: result.merge ?? null
  });

  assert.deepEqual(relevantManualFields(manualResult), relevantManualFields(defaultResult));
  assert.equal(manualResult.mode, MANUAL_MERGE_MODE);
  assert.equal(manualResult.autoMerge, false);
  assert.equal(manualResult.merge ?? null, null);
  assert.deepEqual(defaultFake.calls, []);
  assert.deepEqual(manualFake.calls, []);
});

test("Auto-merge Mode commits pending work, records tests, opens PR, asks GPT, then executes merge after approval", async () => {
  const fake = deps();
  const result = await finishRunLive({ mode: AUTO_MERGE_MODE, config, project, loop: completeLoop, deps: fake });
  assert.equal(result.merge.merged, true);
  assert.deepEqual(fake.calls, ["validate", "pending-check", "git-commit", "record-tests", "pr-open", "validate", "fetch-evidence", "verify-tests", "merge-approve", "save-approval", "validate", "merge-execute"]);
});

test("Auto-merge Mode skips the commit when the worktree is already clean", async () => {
  const fake = deps({ pending: false });
  const result = await finishRunLive({ mode: AUTO_MERGE_MODE, config, project, loop: completeLoop, deps: fake });
  assert.equal(result.merge.merged, true);
  assert.deepEqual(fake.calls, ["validate", "pending-check", "record-tests", "pr-open", "validate", "fetch-evidence", "verify-tests", "merge-approve", "save-approval", "validate", "merge-execute"]);
});

test("Auto-merge Mode stops without merge when GPT approval rejects", async () => {
  const fake = deps({ approved: false });
  const result = await finishRunLive({ mode: AUTO_MERGE_MODE, config, project, loop: completeLoop, deps: fake });
  assert.equal(result.merge.merged, false);
  assert.equal(result.merge.stage, "merge-approve");
  assert.deepEqual(fake.calls, ["validate", "pending-check", "git-commit", "record-tests", "pr-open", "validate", "fetch-evidence", "verify-tests", "merge-approve"]);
});

test("Auto-merge Mode does not start PR/approval/merge after non-complete endings", async () => {
  for (const status of ["blocked", "paused", "failed", "max-cycles-reached", "completed"]) {
    const fake = deps();
    const result = await finishRunLive({ mode: AUTO_MERGE_MODE, config, project, loop: { ...completeLoop, status }, deps: fake });
    assert.equal(result.merge.merged, false);
    assert.equal(result.merge.stage, "skipped");
    assert.deepEqual(fake.calls, []);
  }
});

test("Auto-merge Mode returns gate blockers without executing a successful merge", async () => {
  const fake = deps({ merged: false });
  const result = await finishRunLive({ mode: AUTO_MERGE_MODE, config, project, loop: completeLoop, deps: fake });
  assert.equal(result.merge.merged, false);
  assert.deepEqual(result.merge.blockers, ["DIRTY_WORKTREE"]);
  assert.equal(fake.calls.at(-1), "merge-execute");
});

test("Auto-merge Mode stops clearly on invalid test evidence", async () => {
  const fake = deps();
  fake.verifyTestEvidence = () => {
    fake.calls.push("verify-tests");
    return { status: "blocked" };
  };
  await assert.rejects(() => finishRunLive({ mode: AUTO_MERGE_MODE, config, project, loop: completeLoop, deps: fake }), (error) => {
    assert.ok(error instanceof HephaestusError);
    assert.equal(error.code, "AUTO_MERGE_TESTS_NOT_PASSED");
    return true;
  });
  assert.equal(fake.calls.includes("merge-approve"), false);
  assert.equal(fake.calls.includes("merge-execute"), false);
});

test("run-live rejects conflicting merge mode flags", () => {
  assert.throws(() => run(["run-live", "--auto-merge", "--manual-merge"]), (error) => {
    assert.ok(error instanceof HephaestusError);
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /cannot be used together/u);
    return true;
  });
});
