import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runAgentPreflight } from "../src/agent-preflight.js";
import { resolveExecutablePath, resolveSpawnTarget } from "../src/executable.js";

// Injected existsFile mimicking Windows' case-insensitive filesystem (real fs.statSync
// matches uppercase PATHEXT ".CMD" against a lowercase "codex.cmd" file). No real fs/spawn.
function fsWith(...present) {
  const set = new Set(present.map((item) => item.toLowerCase()));
  return (candidate) => set.has(candidate.toLowerCase());
}

const winEnv = { PATH: "C:\\Program Files\\nodejs;C:\\Users\\dev\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";

test("resolves a Windows npm .cmd shim that a bare name would miss", () => {
  const shim = path.win32.join(npmDir, "codex.cmd");
  const resolved = resolveExecutablePath("codex", winEnv, { platform: "win32", existsFile: fsWith(shim) });
  assert.equal(resolved.toLowerCase(), shim.toLowerCase());
  assert.match(resolved, /\.CMD$/u); // resolved via PATHEXT
});

test("on Windows the unrunnable extensionless file is skipped in favour of the .cmd shim", () => {
  const bare = path.win32.join(npmDir, "codex");        // Unix shell script npm also drops
  const shim = path.win32.join(npmDir, "codex.cmd");    // the runnable Windows shim
  const target = resolveSpawnTarget("codex", winEnv, { platform: "win32", existsFile: fsWith(bare, shim) });
  assert.equal(target.viaShim, true);
  assert.match(target.prefixArgs[3], /\.CMD$/u);
});

test("resolves a Windows .exe without the batch wrapper", () => {
  const exe = path.win32.join(npmDir, "codex.exe");
  const target = resolveSpawnTarget("codex", winEnv, { platform: "win32", existsFile: fsWith(exe) });
  assert.equal(target.command.toLowerCase(), exe.toLowerCase());
  assert.deepEqual([[...target.prefixArgs], target.viaShim], [[], false]);
});

test("a Windows .cmd shim runs via cmd.exe /d /s /c without shell:true", () => {
  const shim = path.win32.join(npmDir, "codex.cmd");
  const target = resolveSpawnTarget("codex", winEnv, { platform: "win32", existsFile: fsWith(shim) });
  assert.equal(target.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(target.prefixArgs.length, 4);
  assert.deepEqual(target.prefixArgs.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(target.prefixArgs[3].toLowerCase(), shim.toLowerCase());
  assert.equal(target.viaShim, true);
});

test("missing executable resolves to null so callers can block safely", () => {
  assert.equal(resolveExecutablePath("claude", winEnv, { platform: "win32", existsFile: fsWith() }), null);
  assert.equal(resolveSpawnTarget("opencode", winEnv, { platform: "win32", existsFile: fsWith() }), null);
});

test("posix resolution finds a plain executable on PATH with no wrapper", () => {
  const posixEnv = { PATH: "/usr/local/bin:/usr/bin" };
  const bin = "/usr/local/bin/codex";
  const target = resolveSpawnTarget("codex", posixEnv, { platform: "linux", existsFile: fsWith(bin) });
  assert.deepEqual([target.command, [...target.prefixArgs], target.viaShim], [bin, [], false]);
});

test("preflight probes --version only, sends no prompt, mutates no project files, and blocks safely when missing", () => {
  const missing = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("not found"), { code: "ENOENT" }) });
  const missingReport = runAgentPreflight({ adapterId: "codex", env: { PATH: "/nonexistent" }, spawn: missing });
  assert.equal(missingReport.available, false);
  assert.equal(missingReport.reason, "executable-not-found");
  assert.equal(missingReport.promptSent, false);
  assert.equal(missingReport.mutatedProjectFiles, false);

  let probedArgs = null;
  const installed = (_exe, args) => { probedArgs = [...args]; return { status: 0, stdout: "codex-cli 0.142.4\n", stderr: "" }; };
  const okReport = runAgentPreflight({ adapterId: "codex", env: { PATH: "/usr/bin" }, spawn: installed });
  assert.deepEqual(probedArgs, ["--version"]); // never a prompt/task
  assert.equal(okReport.available, true);
  assert.match(okReport.version, /codex-cli 0\.142\.4/u);
  assert.equal(okReport.promptSent, false);
  assert.equal(okReport.mutatedProjectFiles, false);
});
