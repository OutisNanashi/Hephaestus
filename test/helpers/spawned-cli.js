import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CWD_STARTUP_FAILURE = /uv_cwd|process\.cwd/u;

function isCwdStartupFailure(result) {
  const stdout = String(result.stdout ?? "");
  const text = `${String(result.stderr ?? "")}\n${String(result.error?.message ?? "")}`;
  return stdout.length === 0 && CWD_STARTUP_FAILURE.test(text);
}

export function spawnCliSync(executable, args, options = {}) {
  const resolvedArgs = args.map((arg) => arg === "src/cli.js" ? path.join(REPO_ROOT, arg) : arg);
  const spawnOptions = {
    ...options,
    cwd: REPO_ROOT,
    env: { ...process.env, ...options.env, PWD: REPO_ROOT }
  };
  const result = spawnSync(executable, resolvedArgs, spawnOptions);
  return isCwdStartupFailure(result)
    ? spawnSync(executable, resolvedArgs, spawnOptions)
    : result;
}

export function withEmptyPath(directory, action) {
  const original = { PATH: process.env.PATH, Path: process.env.Path, path: process.env.path };
  try {
    process.env.PATH = directory;
    process.env.Path = directory;
    process.env.path = directory;
    return action();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
