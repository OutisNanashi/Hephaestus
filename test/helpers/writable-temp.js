import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create an isolated test directory without assuming the OS-provided temporary
 * location is writable (a common WSL/Windows configuration issue).
 */
export function writableTemporaryDirectory(prefix) {
  const candidates = [process.platform === "win32" ? null : "/tmp", os.tmpdir(), path.resolve("test", ".tmp")];
  const errors = [];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return fs.mkdtempSync(path.join(candidate, prefix));
    } catch (error) {
      errors.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(`No writable temporary directory is available (${errors.join("; ")}).`);
}

/**
 * Docker-backed tests run containers as uid/gid 65534. The bind-mounted test
 * root must be traversable by that unprivileged user or the workspace health
 * check correctly fails before any command runs.
 */
export function containerReadableTemporaryDirectory(prefix) {
  const directory = writableTemporaryDirectory(prefix);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o755);
  return directory;
}

export function makeTreeContainerReadable(target) {
  if (process.platform === "win32") return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o755);
    for (const entry of fs.readdirSync(target)) {
      makeTreeContainerReadable(path.join(target, entry));
    }
    return;
  }
  if (stat.isFile()) fs.chmodSync(target, 0o644);
}
