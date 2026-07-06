import { fail } from "./errors.js";
import { requestOpenAIStructured } from "./openai-provider.js";

const PLAN_JSON_SUFFIX = "\n\nRespond with ONLY one valid JSON object. When another phase remains: keys status (\"phase-ready\"), phase, taskId, taskMarkdown, rationale. When the plan is fully built: keys status (\"all-complete\"), rationale. No markdown, no code fences, no commentary.";

// taskId becomes both the STATE task name and the git branch segment, so it must
// be a safe slug. taskMarkdown becomes CURRENT_TASK.md verbatim.
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_TASK_MARKDOWN = 8_000;
const SECRET_HINT = /openai[-_ ]?api[-_ ]?key|bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{16,}/iu;

function validatePhasePlan(raw) {
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") fail("Phase plan must be a JSON object.", "INVALID_PHASE_PLAN");
  if (raw.status === "all-complete") {
    if (Object.keys(raw).some((key) => !["status", "rationale"].includes(key))) fail("all-complete phase plan must contain only status and rationale.", "INVALID_PHASE_PLAN");
    if (typeof raw.rationale !== "string" || raw.rationale.trim() === "") fail("Phase plan rationale must be a non-empty string.", "INVALID_PHASE_PLAN");
    return Object.freeze({ status: "all-complete", rationale: raw.rationale });
  }
  if (raw.status !== "phase-ready") fail('Phase plan status must be "phase-ready" or "all-complete".', "INVALID_PHASE_PLAN");
  const keys = ["status", "phase", "taskId", "taskMarkdown", "rationale"];
  if (keys.some((key) => !(key in raw)) || Object.keys(raw).some((key) => !keys.includes(key))) fail("phase-ready phase plan must contain exactly status, phase, taskId, taskMarkdown, rationale.", "INVALID_PHASE_PLAN");
  const phase = typeof raw.phase === "string" ? raw.phase.trim() : String(raw.phase ?? "");
  if (phase === "") fail("Phase plan phase must be a non-empty value.", "INVALID_PHASE_PLAN");
  if (typeof raw.taskId !== "string" || !TASK_ID.test(raw.taskId)) fail("Phase plan taskId must be a lowercase hyphenated slug.", "INVALID_PHASE_PLAN");
  if (typeof raw.taskMarkdown !== "string" || raw.taskMarkdown.trim() === "") fail("Phase plan taskMarkdown must be a non-empty string.", "INVALID_PHASE_PLAN");
  if (raw.taskMarkdown.length > MAX_TASK_MARKDOWN) fail("Phase plan taskMarkdown is too large.", "INVALID_PHASE_PLAN");
  if (SECRET_HINT.test(raw.taskMarkdown)) fail("Phase plan taskMarkdown appears to contain secret material.", "INVALID_PHASE_PLAN");
  if (typeof raw.rationale !== "string" || raw.rationale.trim() === "") fail("Phase plan rationale must be a non-empty string.", "INVALID_PHASE_PLAN");
  return Object.freeze({ status: "phase-ready", phase, taskId: raw.taskId, taskMarkdown: raw.taskMarkdown, rationale: raw.rationale });
}

function planInput({ planContext, buildLog, currentPhase }) {
  const log = typeof buildLog === "string" && buildLog.trim() !== "" ? buildLog.slice(-2_000) : "(empty)";
  return `You are the phase planner for an automated build system. The project PLAN.md defines ordered phases. The build log records which phases have been implemented and merged. Determine the SINGLE next phase that has not yet been built, and define one bounded task for it.

Return status "phase-ready" with:
- phase: the next phase identifier from PLAN.md (e.g. "3")
- taskId: a short lowercase-hyphenated slug naming the task (e.g. "command-line-interface")
- taskMarkdown: the full contents for CURRENT_TASK.md — a concrete objective, the allowed files, what is forbidden (especially owner/conductor files and later-phase work), and the exact required tests for this phase, taken from PLAN.md
- rationale: one sentence on why this is the next phase

If every phase described in PLAN.md has already been built and merged, return status "all-complete" with a rationale and no other keys. Never invent phases beyond PLAN.md. Never repeat an already-merged phase.

Most recently completed phase according to STATE.json: ${currentPhase}

PLAN.md:
${planContext.slice(0, MAX_TASK_MARKDOWN)}

Recent build log (tail):
${log}`;
}

/** Ask GPT for the next unbuilt phase and its bounded task, or all-complete. Never writes files. */
export async function requestNextPhasePlan({ apiKey, model, planContext, buildLog, currentPhase, fetchImpl }) {
  if (typeof planContext !== "string" || planContext.trim() === "") fail("Phase planning requires PLAN.md context.", "INVALID_PHASE_PLAN_REQUEST");
  return requestOpenAIStructured({
    apiKey,
    model,
    input: planInput({ planContext, buildLog, currentPhase }),
    validate: validatePhasePlan,
    strictSuffix: PLAN_JSON_SUFFIX,
    failureCode: "INVALID_PHASE_PLAN",
    fetchImpl
  });
}
