import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_MERGE_MODE, MANUAL_MERGE_MODE } from "../src/auto-merge.js";
import { HephaestusError } from "../src/errors.js";
import { orchestrateRunLive, MAX_PHASES_PER_RUN } from "../src/run-live-orchestrator.js";

const config = { allowedRoot: ".", brain: { model: "m" }, notifications: {} };
const project = { id: "demo", path: "demo" };

// A fake project whose state advances exactly as the real modules would: build a
// task, merge it, advance to the next phase, until PLAN.md's phases run out.
function harness({ phases = 3, build = () => "task-complete", merged = () => true, startMerged = false, advanceKeepsTask = false } = {}) {
  const box = { phase: 1, task: "task-1", merged: startMerged, done: false, builds: 0, merges: 0, advances: 0, prepares: 0, branch: "master" };
  const deps = {
    readState: () => ({
      currentPhase: String(box.phase),
      currentTask: box.task,
      mergeStatus: box.merged ? "merged" : "not-started",
      nextAction: box.done ? "project-complete" : (box.merged ? "next-phase-eligible" : "run-agent")
    }),
    prepareBranch: () => { box.prepares += 1; const created = box.branch === "master"; box.branch = `hephaestus/demo/${box.task}`; return { created, branch: box.branch }; },
    runLiveLoop: async () => { box.builds += 1; return { status: build(box), reason: "reason", cycles: [], notification: "sent" }; },
    autoMerge: async () => {
      box.merges += 1;
      const ok = merged(box);
      if (ok) box.merged = true;
      return { merge: { merged: ok, pr: box.phase, mergeCommit: `commit-${box.phase}`, blockers: ok ? [] : ["MISSING_GPT_APPROVAL"] } };
    },
    advance: async () => {
      box.advances += 1;
      box.merged = false;
      if (advanceKeepsTask) return { status: "phase-ready", phase: String(box.phase), taskId: box.task, branch: "b" };
      if (box.phase >= phases) { box.done = true; return { status: "all-complete", rationale: "every phase built" }; }
      box.phase += 1; box.task = `task-${box.phase}`;
      return { status: "phase-ready", phase: String(box.phase), taskId: box.task, branch: "b" };
    }
  };
  return { deps, box };
}

test("Auto mode chains build -> merge -> advance through every phase to completion", async () => {
  const { deps, box } = harness({ phases: 3 });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "project-complete");
  assert.equal(box.builds, 3);
  assert.equal(box.prepares, 3, "a task branch is ensured before every phase build");
  assert.equal(box.merges, 3);
  const merged = result.phases.filter((p) => p.stage === "merged");
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((p) => p.phase), ["1", "2", "3"]);
  assert.equal(merged[2].next, "all-complete");
});

test("Auto mode stops when a phase build blocks, without merging it", async () => {
  const { deps, box } = harness({ phases: 3, build: (b) => (b.phase === 2 ? "blocked" : "task-complete") });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "blocked");
  assert.equal(box.merges, 1, "only phase 1 merged");
  assert.equal(result.phases.at(-1).stage, "blocked");
});

test("Auto mode stops when the merge gate blocks a phase", async () => {
  const { deps, box } = harness({ phases: 3, merged: (b) => b.phase !== 2 });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "merge-blocked");
  assert.equal(box.advances, 1, "advanced only after phase 1");
  assert.ok(result.phases.at(-1).blockers.includes("MISSING_GPT_APPROVAL"));
});

test("Auto mode resumes a phase merged by a previous invocation but not yet advanced", async () => {
  const { deps, box } = harness({ phases: 3, startMerged: true });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "project-complete");
  // The first action is an advance (resume), not a build.
  assert.equal(result.phases[0].stage, "advanced");
  // Phase 1 was already merged before this run, so only phases 2 and 3 are built here.
  assert.equal(box.builds, 2);
});

test("Auto mode reports project-complete immediately when nothing remains", async () => {
  const { deps, box } = harness();
  deps.readState = () => ({ currentPhase: "3", currentTask: "task-3", mergeStatus: "not-started", nextAction: "project-complete" });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "project-complete");
  assert.equal(box.builds, 0);
});

test("Auto mode halts on no-progress if advancing does not change the task", async () => {
  const { deps } = harness({ phases: 5, advanceKeepsTask: true });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "no-progress");
});

test("Auto mode respects the phase budget and never loops forever", async () => {
  const { deps, box } = harness({ phases: 999 });
  const result = await orchestrateRunLive({ mode: AUTO_MERGE_MODE, config, project, deps });
  assert.equal(result.outcome, "phase-budget-reached");
  assert.ok(box.merges <= MAX_PHASES_PER_RUN + 1);
});

test("Manual mode runs one build loop and does not chain or merge", async () => {
  const { deps, box } = harness();
  const result = await orchestrateRunLive({ mode: MANUAL_MERGE_MODE, config, project, deps });
  assert.equal(result.mode, MANUAL_MERGE_MODE);
  assert.equal(result.outcome, "task-complete");
  assert.equal(box.builds, 1);
  assert.equal(box.merges, 0, "manual mode never auto-merges");
  assert.equal(box.advances, 0, "manual mode never auto-advances");
});

function codeIs(expected) {
  return (error) => { assert.ok(error instanceof HephaestusError); assert.equal(error.code, expected); return true; };
}

test("run-live routes a Codex (default and explicit) project through the existing build path", async () => {
  for (const codexProject of [{ id: "demo", path: "demo" }, { id: "demo", path: "demo", provider: "codex" }]) {
    const { deps, box } = harness();
    const result = await orchestrateRunLive({ mode: MANUAL_MERGE_MODE, config, project: codexProject, deps });
    assert.equal(result.outcome, "task-complete");
    assert.equal(box.builds, 1, "Codex project still executes exactly one build loop");
  }
});

test("run-live rejects a factory-droid project before executing any task (not live-executable)", async () => {
  const factoryProject = { id: "demo", path: "demo", provider: "factory-droid" };
  for (const mode of [MANUAL_MERGE_MODE, AUTO_MERGE_MODE]) {
    const { deps, box } = harness();
    await assert.rejects(
      orchestrateRunLive({ mode, config, project: factoryProject, deps }),
      codeIs("PROVIDER_NOT_LIVE_EXECUTABLE")
    );
    assert.equal(box.builds, 0, "no build loop runs for a non-live provider");
    assert.equal(box.prepares, 0, "no branch prep runs for a non-live provider");
    assert.equal(box.merges, 0);
  }
});

test("run-live rejects an unknown provider before executing any task", async () => {
  const { deps, box } = harness();
  await assert.rejects(
    orchestrateRunLive({ mode: MANUAL_MERGE_MODE, config, project: { id: "demo", path: "demo", provider: "devin" }, deps }),
    codeIs("PROVIDER_ADAPTER_NOT_AVAILABLE")
  );
  assert.equal(box.builds, 0);
});

test("config disabling Codex live execution stops run-live before any build", async () => {
  const { deps, box } = harness();
  const codexOff = { ...config, providers: { codex: { executionEnabled: false } } };
  await assert.rejects(
    orchestrateRunLive({ mode: MANUAL_MERGE_MODE, config: codexOff, project: { id: "demo", path: "demo", provider: "codex" }, deps }),
    codeIs("PROVIDER_NOT_LIVE_EXECUTABLE")
  );
  assert.equal(box.builds, 0);
});
