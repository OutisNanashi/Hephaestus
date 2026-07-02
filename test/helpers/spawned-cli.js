import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function spawnCliSync(executable, args, options = {}) {
  return spawnSync(executable, args, { cwd: REPO_ROOT, ...options });
}
