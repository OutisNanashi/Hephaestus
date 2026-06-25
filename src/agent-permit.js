import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAdapter, requireAdapter } from "./agent-adapters.js";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";

const ALLOWED_REQUEST_KEYS = new Set([
  "adapterId", "projectName", "projectPath", "promptPath", "allowedRoot",
  "dryRun", "executionRequested", "explicitRealAgentPermit", "sandboxReady",
  "autoApproval", "secretsPolicy"
]);

function assertRequestShape(request) {
  if (!request || Array.isArray(request) || typeof request !== "object") {
    fail("Agent permit request must be an object.", "INVALID_PERMIT_REQUEST");
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      fail(`Agent permit request contains an unsupported field: ${key}.`, "INVALID_PERMIT_REQUEST");
    }
  }
  if (typeof request.adapterId !== "string" || request.adapterId.trim() === "") {
    fail("Agent permit request requires adapterId.", "INVALID_PERMIT_REQUEST");
  }
}

function safePromptPath({ allowedRoot, projectPath, promptPath }) {
  if (typeof promptPath !== "string" || promptPath.length === 0 || promptPath.split(/[\\/]+/u).includes("..")) {
    fail("Agent prompt path must be a non-empty relative path without traversal.", "INVALID_AGENT_PROMPT_PATH");
  }
  const projectRelative = path.isAbsolute(promptPath) ? promptPath : path.join(projectPath, promptPath);
  const resolved = fs.existsSync(projectRelative) ? projectRelative : path.resolve(promptPath);
  assertRealPathWithinRoot(allowedRoot, resolved);
  if (!fs.statSync(resolved).isFile()) fail("Agent prompt path must be a regular file.", "INVALID_AGENT_PROMPT_PATH");
  return resolved;
}

function promptDetails(promptPath) {
  const stat = fs.statSync(promptPath);
  const buffer = fs.readFileSync(promptPath);
  const content = buffer.toString("utf8");
  if (content.trim() === "") fail("Agent prompt must not be empty.", "EMPTY_AGENT_PROMPT");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return Object.freeze({ path: promptPath, sizeBytes: stat.size, sha256 });
}

function blocker(code, detail) {
  return Object.freeze({ code, detail });
}

function frozenList(items) {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

/** Decide whether a fixture or real-agent run may proceed, and in which mode, without ever invoking an agent. */
export function checkAgentPermit(rawRequest) {
  assertRequestShape(rawRequest);
  const adapter = requireAdapter(rawRequest.adapterId);
  if (typeof rawRequest.allowedRoot !== "string" || rawRequest.allowedRoot.length === 0) {
    fail("Agent permit request requires a non-empty allowedRoot.", "INVALID_PERMIT_REQUEST");
  }
  if (typeof rawRequest.projectPath !== "string" || rawRequest.projectPath.length === 0) {
    fail("Agent permit request requires a non-empty projectPath.", "INVALID_PERMIT_REQUEST");
  }
  const allowedRoot = path.resolve(rawRequest.allowedRoot);
  const projectPath = resolveSafePath(allowedRoot, rawRequest.projectPath);
  assertRealPathWithinRoot(allowedRoot, projectPath);
  const prompt = promptDetails(safePromptPath({ allowedRoot, projectPath, promptPath: rawRequest.promptPath }));

  const projectName = typeof rawRequest.projectName === "string" && rawRequest.projectName.trim() !== ""
    ? rawRequest.projectName.trim()
    : path.basename(projectPath);
  const dryRun = rawRequest.dryRun === true;
  const executionRequested = rawRequest.executionRequested === true;
  const autoApproval = rawRequest.autoApproval === true;
  const sandboxReady = rawRequest.sandboxReady === true;
  const explicitRealAgentPermit = rawRequest.explicitRealAgentPermit === true;
  const secretsPolicy = rawRequest.secretsPolicy ?? Object.freeze({});
  if (!secretsPolicy || Array.isArray(secretsPolicy) || typeof secretsPolicy !== "object") {
    fail("Agent permit secretsPolicy must be a plain object when supplied.", "INVALID_PERMIT_REQUEST");
  }
  if (secretsPolicy.allowSecretEnvironment === true || secretsPolicy.exposeApiKey === true) {
    fail("Agent permit secrets policy is unsafe.", "UNSAFE_SECRETS_POLICY");
  }

  const blockers = [];
  let mode = executionRequested ? "execution" : "dry-run";
  if (dryRun) mode = "dry-run";

  if (adapter.kind === "real") {
    if (executionRequested) {
      blockers.push(blocker("REAL_AGENT_EXECUTION_DISABLED", `Real-agent execution is denied in Step 6C for adapter ${adapter.id}.`));
    }
    if (autoApproval) {
      blockers.push(blocker("REAL_AGENT_AUTO_APPROVAL_DISABLED", `Auto-approval is denied for real adapter ${adapter.id}.`));
    }
    if (!adapter.preflightSupported) {
      blockers.push(blocker("ADAPTER_DOES_NOT_SUPPORT_PREFLIGHT", `Adapter ${adapter.id} cannot be planned without preflight support.`));
    }
    if (explicitRealAgentPermit) {
      blockers.push(blocker("REAL_AGENT_EXECUTION_DISABLED", "Explicit real-agent permits are not honoured in Step 6C."));
    }
  } else if (adapter.kind === "fixture") {
    if (executionRequested && !sandboxReady) {
      blockers.push(blocker("SANDBOX_NOT_READY", "Fixture execution requires a ready sandbox."));
    }
    if (autoApproval) {
      blockers.push(blocker("AUTO_APPROVAL_NOT_REQUIRED", "Auto-approval flag is rejected because fixture adapters never need it."));
    }
  } else {
    blockers.push(blocker("UNKNOWN_ADAPTER_KIND", `Adapter ${adapter.id} kind ${adapter.kind} is not recognized.`));
  }

  const executionWouldStart = adapter.kind === "fixture" && executionRequested && blockers.length === 0;
  const allowed = blockers.length === 0 && (mode === "execution" ? executionWouldStart : true);
  const projectStateWouldMutate = executionWouldStart;
  const promptSent = false;

  return Object.freeze({
    allowed,
    mode,
    adapterId: adapter.id,
    adapterKind: adapter.kind,
    projectName,
    projectPath,
    allowedRoot,
    prompt,
    promptSent,
    executionWouldStart,
    projectStateWouldMutate,
    reasonCodes: Object.freeze(blockers.map((entry) => entry.code)),
    blockers: frozenList(blockers)
  });
}

export function permitForFixtureExecution(request) {
  return checkAgentPermit({ ...request, dryRun: false, executionRequested: true, sandboxReady: true });
}

export { ALLOWED_REQUEST_KEYS };

export function knownAdapter(adapterId) {
  return getAdapter(adapterId) !== null;
}
