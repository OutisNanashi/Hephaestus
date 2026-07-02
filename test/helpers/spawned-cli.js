import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function spawnCliSync(executable, args, options = {}) {
  const resolvedArgs = args.map((arg) => arg === "src/cli.js" ? path.join(REPO_ROOT, arg) : arg);
  const spawnOptions = {
    cwd: REPO_ROOT,
    ...options,
    env: { ...process.env, ...options.env, PWD: REPO_ROOT }
  };
  const result = spawnSync(executable, resolvedArgs, spawnOptions);
  const stderr = String(result.stderr ?? "");
  return result.stdout?.length === 0 && /uv_cwd|process\.cwd/u.test(stderr)
    ? spawnSync(executable, resolvedArgs, spawnOptions)
    : result;
}
