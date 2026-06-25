import path from "node:path";
import { getAdapter } from "./agent-adapters.js";
import { checkAgentPermit } from "./agent-permit.js";

const SCHEMA_VERSION = 1;
const SAFE_ENVIRONMENT_POLICY = "sandbox-safe (LANG=C.UTF-8 only)";

function adapterPublicView(adapter) {
  return Object.freeze({
    id: adapter.id,
    displayName: adapter.displayName,
    kind: adapter.kind,
    executionAllowed: adapter.executionAllowed,
    preflightSupported: adapter.preflightSupported,
    defaultEnabled: adapter.defaultEnabled,
    expectedExecutable: adapter.expectedExecutable
  });
}

function intendedPaths(projectPath) {
  return Object.freeze({
    workingDirectory: projectPath,
    deliveredPromptPath: path.join(projectPath, "out", "agent_runs", "current", "prompt.md"),
    outputCapturePath: path.join(projectPath, "out", "agent_runs", "current", "output.log"),
    agentOutputPath: path.join(projectPath, "AGENT_OUTPUT.md"),
    buildLogBehavior: "append-only",
    stateBehavior: "schema-validated-agent-block"
  });
}

function invocationDetails(adapter) {
  return Object.freeze({
    executable: adapter.expectedExecutable,
    argv: adapter.kind === "real" ? null : null,
    shell: false,
    envPolicy: SAFE_ENVIRONMENT_POLICY,
    autoApproval: false,
    invocationContractDefined: false
  });
}

function safetyChecklist(adapter) {
  return Object.freeze({
    shellFalse: true,
    noUserSuppliedExecutable: true,
    noSecretsInPlan: true,
    noPromptInPlanByDefault: true,
    noProjectMutation: true,
    realAgentExecutionDenied: adapter.kind === "real",
    autoApprovalDenied: true,
    invocationContractDefined: false
  });
}

function executionStatus(permit) {
  if (permit.allowed && permit.mode === "execution") return "permitted";
  if (permit.allowed && permit.mode === "dry-run") return "planned";
  return "blocked";
}

/** Build an auditable, secret-free run plan for a future real-agent invocation without executing it. */
export function createAgentRunPlan({ adapterId, projectName, projectPath, allowedRoot, promptPath, autoApproval = false, executionRequested = false, includePrompt = false, now = () => new Date().toISOString() }) {
  const permit = checkAgentPermit({
    adapterId,
    projectName,
    projectPath,
    allowedRoot,
    promptPath,
    dryRun: true,
    executionRequested,
    autoApproval
  });
  const adapter = getAdapter(adapterId);
  const createdAt = now();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    adapter: adapterPublicView(adapter),
    project: Object.freeze({ name: permit.projectName, path: permit.projectPath }),
    prompt: Object.freeze({
      path: permit.prompt.path,
      sizeBytes: permit.prompt.sizeBytes,
      sha256: permit.prompt.sha256,
      includedContent: includePrompt === true,
      content: includePrompt === true ? "[INCLUDED-IN-TEST-FIXTURE-ONLY]" : null
    }),
    intended: intendedPaths(permit.projectPath),
    invocation: invocationDetails(adapter),
    safetyChecklist: safetyChecklist(adapter),
    permit,
    execution: Object.freeze({
      status: executionStatus(permit),
      blockers: permit.blockers,
      reasonCodes: permit.reasonCodes,
      executionWouldStart: permit.executionWouldStart,
      promptSent: false,
      projectStateWouldMutate: permit.projectStateWouldMutate
    })
  });
}
