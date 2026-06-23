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
