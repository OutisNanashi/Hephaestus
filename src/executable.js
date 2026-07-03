import fs from "node:fs";
import path from "node:path";

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function defaultExistsFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a command name to a real file on PATH, cross-platform. On Windows this
 * honours PATHEXT so npm shims (e.g. `codex.cmd`) resolve even though a bare
 * `codex` file does not exist. Pure and injectable for testing; no process spawn.
 * Returns the resolved absolute-ish path, or null when nothing matches.
 */
export function resolveExecutablePath(executable, env = process.env, { platform = process.platform, existsFile = defaultExistsFile } = {}) {
  if (typeof executable !== "string" || executable.trim() === "") return null;
  const isWindows = platform === "win32";
  const p = isWindows ? path.win32 : path.posix;
  const delimiter = isWindows ? ";" : ":";
  // On Windows an extensionless file (the Unix shell script npm also drops) is NOT
  // runnable via spawn; only PATHEXT entries are. Try the bare name only when it
  // already carries a known executable extension (e.g. codex.cmd passed directly).
  const pathext = (env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT).split(";").map((item) => item.trim()).filter(Boolean);
  const nameHasExecExtension = pathext.some((extension) => executable.toLowerCase().endsWith(extension.toLowerCase()));
  const extensions = isWindows ? (nameHasExecExtension ? [""] : pathext) : [""];

  const hasDirectory = executable.includes("/") || executable.includes("\\");
  const bases = hasDirectory
    ? [executable]
    : (env.PATH ?? env.Path ?? env.path ?? "").split(delimiter).filter(Boolean).map((directory) => p.join(directory, executable));

  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (existsFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Turn a command name into a concrete spawn target. On Windows a batch shim
 * (`.cmd`/`.bat`) is executed via `cmd.exe /d /s /c <resolved>` so it runs
 * without `shell: true` (the arguments stay fixed, so there is no shell
 * interpolation of untrusted input). Returns null when the executable is absent.
 */
export function resolveSpawnTarget(executable, env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutablePath(executable, env, { ...options, platform });
  if (resolved === null) return null;
  const isWindows = platform === "win32";
  const extension = (isWindows ? path.win32 : path.posix).extname(resolved).toLowerCase();
  if (isWindows && (extension === ".cmd" || extension === ".bat")) {
    const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    return Object.freeze({ command: comspec, prefixArgs: Object.freeze(["/d", "/s", "/c", resolved]), resolved, viaShim: true });
  }
  return Object.freeze({ command: resolved, prefixArgs: Object.freeze([]), resolved, viaShim: false });
}
