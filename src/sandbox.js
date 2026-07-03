import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.js";
import { inspectProject } from "./inspection.js";
import { assertRealPathWithinRoot } from "./safe-path.js";

export const SANDBOX_IMAGE = "node:20-alpine";
const SANDBOX_WORKSPACE = "/workspace";
const SAFE_CONTAINER_ENVIRONMENT = Object.freeze({ LANG: "C.UTF-8" });
const COMMAND_TIMEOUT_MS = 1_000;
const DOCKER_LIFECYCLE_TIMEOUT_MS = 5_000;
const NPM_TEST_TIMEOUT_MS = 15_000;
const WSL_DOCKER_STUB = /could not be found in this WSL 2 distro|activate the WSL integration/iu;

const ALLOWLIST = Object.freeze({
  "test-echo": Object.freeze({ script: "printf 'sandbox-ok\\n'" }),
  "test-stderr": Object.freeze({ script: "printf 'sandbox-out\\n'; printf 'sandbox-err\\n' >&2; exit 7" }),
  "test-timeout": Object.freeze({ script: "sleep 5", timeoutMs: COMMAND_TIMEOUT_MS }),
  "test-workspace": Object.freeze({ script: "test -d /workspace && test -f /workspace/PLAN.md" }),
  "test-host-inaccessible": Object.freeze({ script: "test ! -e /host && test ! -e /mnt/c" }),
  "test-identity": Object.freeze({ script: "printf 'workspace=%s\\n' \"$PWD\"; printf 'hostname=%s\\n' \"$(hostname)\"" }),
  "test-npm": Object.freeze({ script: "npm test", timeoutMs: NPM_TEST_TIMEOUT_MS })
  , "fixture-agent": Object.freeze({ script: "test -f /workspace/out/agent_runs/current/prompt.md && printf 'fixture-agent received prompt:\\n'; cat /workspace/out/agent_runs/current/prompt.md; printf '\\nfixture-agent completed\\n'" })
  , "fixture-agent-empty": Object.freeze({ script: ":" })
  , "fixture-agent-crash": Object.freeze({ script: "printf 'fixture-agent crashed\\n' >&2; exit 23" })
  , "fixture-agent-usage-limit": Object.freeze({ script: "printf 'usage limit reached; try again later\\n'" })
  , "fixture-agent-blocker": Object.freeze({ script: "printf 'BLOCKED: required file is missing\\n'" })
  , "fixture-agent-timeout": Object.freeze({ script: "sleep 5", timeoutMs: COMMAND_TIMEOUT_MS })
});

function dockerEnvironment() {
  return { PATH: process.env.PATH };
}

function windowsMountPath(hostPath) {
  const match = /^\/mnt\/([a-z])\/(.+)$/iu.exec(hostPath);
  return match ? `${match[1].toUpperCase()}:/${match[2]}` : hostPath;
}

function dockerDesktopArgs(args) {
  return args.map((arg, index) => {
    if (args[index - 1] !== "--mount") return arg;
    return arg.replace(/(^|,)src=([^,]+)/u, (part, prefix, source) => `${prefix}src=${windowsMountPath(source)}`);
  });
}

function spawnDocker(executable, args, timeout) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGTERM",
    env: dockerEnvironment()
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL";
  return {
    error: result.error ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? null,
    timedOut
  };
}

function shouldRetryWithDockerDesktop(result) {
  return result.error?.code === "ENOENT" || result.error?.code === "EACCES" || WSL_DOCKER_STUB.test(result.stderr);
}

function dockerResult(args, timeout = DOCKER_LIFECYCLE_TIMEOUT_MS) {
  let result = spawnDocker("docker", args, timeout);
  if (shouldRetryWithDockerDesktop(result)) result = spawnDocker("docker.exe", dockerDesktopArgs(args), timeout);
  if (result.error && !result.timedOut) {
    fail(`Docker sandbox command could not start: ${result.error.message}`, "SANDBOX_RUNTIME_FAILED");
  }
  return Object.freeze({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut
  });
}

function assertSafeMountPath(projectPath) {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    fail("Sandbox mount path must be a non-empty string.", "UNSAFE_SANDBOX_MOUNT_PATH");
  }
  if (/[,=\n\r\0]/u.test(projectPath)) {
    fail("Sandbox mount path contains characters that would corrupt the Docker mount specification.", "UNSAFE_SANDBOX_MOUNT_PATH");
  }
}

export function sandboxArgs(projectPath, containerName, script) {
  assertSafeMountPath(projectPath);
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
    const command = ALLOWLIST[commandId];
    result = dockerResult(sandboxArgs(projectState.projectPath, name, command.script), command.timeoutMs ?? DOCKER_LIFECYCLE_TIMEOUT_MS);
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
