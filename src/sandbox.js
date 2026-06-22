import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

export const SANDBOX_IMAGE = "postgres:16-alpine";
const SANDBOX_WORKSPACE = "/workspace";
const SAFE_CONTAINER_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const COMMAND_TIMEOUT_MS = 1_000;

const ALLOWLIST = Object.freeze({
  "test-echo": Object.freeze({ script: "printf 'sandbox-ok\\n'" }),
  "test-stderr": Object.freeze({ script: "printf 'sandbox-out\\n'; printf 'sandbox-err\\n' >&2; exit 7" }),
  "test-timeout": Object.freeze({ script: "sleep 5" }),
  "test-workspace": Object.freeze({ script: "test -d /workspace && test -f /workspace/PLAN.md" }),
  "test-host-inaccessible": Object.freeze({ script: "test ! -e /host && test ! -e /mnt/c" })
  , "fixture-agent": Object.freeze({ script: "test -f /workspace/out/prompts/next-task.md && printf 'fixture-agent received prompt:\\n'; cat /workspace/out/prompts/next-task.md; printf '\\nfixture-agent completed\\n'" })
  , "fixture-agent-empty": Object.freeze({ script: ":" })
  , "fixture-agent-crash": Object.freeze({ script: "printf 'fixture-agent crashed\\n' >&2; exit 23" })
  , "fixture-agent-usage-limit": Object.freeze({ script: "printf 'usage limit reached; try again later\\n'" })
});

function dockerEnvironment() {
  return { PATH: process.env.PATH };
}

function dockerResult(args, timeout = COMMAND_TIMEOUT_MS) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGTERM",
    env: dockerEnvironment()
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  if (result.error && !timedOut) {
    fail(`Docker sandbox command could not start: ${result.error.message}`, "SANDBOX_RUNTIME_FAILED");
  }
  return Object.freeze({
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? null,
    timedOut
  });
}

function sandboxArgs(projectPath, containerName, script) {
  return [
    "run", "--name", containerName, "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "128m",
    "--mount", `type=bind,src=${projectPath},dst=${SANDBOX_WORKSPACE},readonly`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--workdir", SANDBOX_WORKSPACE,
    "--user", "65534:65534",
    "--env", `LANG=${SAFE_CONTAINER_ENVIRONMENT.LANG}`,
    "--entrypoint", "/bin/sh",
    SANDBOX_IMAGE,
    "-c", script
  ];
}

function containerName() {
  return `hephaestus-sandbox-${randomUUID()}`;
}

function reportDirectory(projectPath) {
  const outDirectory = path.join(projectPath, "out");
  const reportsDirectory = path.join(outDirectory, "test_reports");
  for (const directory of [outDirectory, reportsDirectory]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    assertRealPathWithinRoot(projectPath, directory);
    if (!fs.statSync(directory).isDirectory()) fail("Command report path is not a directory.", "INVALID_REPORT_DIRECTORY");
  }
  return reportsDirectory;
}

function saveCommandReport(projectPath, commandId, report) {
  const reportPath = path.join(reportDirectory(projectPath), `command-${commandId}.json`);
  if (fs.existsSync(reportPath)) assertRealPathWithinRoot(projectPath, reportPath);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export function cleanupSandbox(name) {
  const result = dockerResult(["rm", "--force", name], COMMAND_TIMEOUT_MS);
  return Object.freeze({ attempted: true, removed: result.exitCode === 0 });
}

export function sandboxContainerExists(name) {
  const result = dockerResult(["container", "inspect", name], COMMAND_TIMEOUT_MS);
  return result.exitCode === 0;
}

/** Start a disposable hardened container and confirm the read-only mount exists. */
export function checkSandboxHealth(allowedRoot, projectPath) {
  const projectState = inspectProject(allowedRoot, projectPath);
  const name = containerName();
  let result;
  try {
    result = dockerResult(sandboxArgs(projectState.projectPath, name, "test -d /workspace && test -r /workspace/PLAN.md"));
  } finally {
    cleanupSandbox(name);
  }
  if (result.timedOut || result.exitCode !== 0) {
    fail(`Sandbox health check failed: ${result.stderr || "container did not confirm workspace mount"}`, "SANDBOX_HEALTH_FAILED");
  }
  return Object.freeze({
    healthy: true,
    workspace: SANDBOX_WORKSPACE,
    projectPath: projectState.projectPath,
    image: SANDBOX_IMAGE
  });
}

/** Run one fixed allowlisted command in a disposable, isolated container. */
export function runSandboxCommand({ allowedRoot, projectPath, commandId }) {
  if (!Object.hasOwn(ALLOWLIST, commandId)) {
    fail(`Sandbox command is not allowlisted: ${commandId}.`, "COMMAND_NOT_ALLOWED");
  }
  const projectState = inspectProject(allowedRoot, projectPath);
  const health = checkSandboxHealth(allowedRoot, projectState.projectPath);
  const name = containerName();
  let result;
  let cleanup;
  try {
    result = dockerResult(sandboxArgs(projectState.projectPath, name, ALLOWLIST[commandId].script));
  } finally {
    cleanup = cleanupSandbox(name);
  }
  const status = result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed";
  const report = Object.freeze({
    commandId,
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    sandbox: {
      image: SANDBOX_IMAGE,
      workspace: SANDBOX_WORKSPACE,
      network: "none",
      readOnlyRoot: true,
      projectMountedReadOnly: true,
      environment: SAFE_CONTAINER_ENVIRONMENT,
      health
    },
    cleanup
  });
  const reportPath = saveCommandReport(projectState.projectPath, commandId, report);
  return Object.freeze({ ...report, reportPath, containerName: name });
}
