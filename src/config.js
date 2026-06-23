import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { resolveConfigPath } from "./safe-path.js";

const REQUIRED_CONFIG_KEYS = ["allowedRoot", "registryPath", "logDirectory"];

function readJson(filePath, label) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${label} could not be read: ${error.message}`, "FILE_READ_FAILED");
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${label} contains invalid JSON: ${error.message}`, "INVALID_JSON");
  }
}

export function loadConfig(configPath = path.resolve("hephaestus.config.json")) {
  const absoluteConfigPath = path.resolve(configPath);
  const raw = readJson(absoluteConfigPath, "Configuration");
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") {
    fail("Configuration must be a JSON object.", "INVALID_CONFIG");
  }
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!(key in raw)) {
      fail(`Configuration is missing required key: ${key}.`, "INVALID_CONFIG");
    }
  }
  const allowedKeys = new Set(REQUIRED_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      fail(`Configuration contains unsupported key: ${key}.`, "INVALID_CONFIG");
    }
  }

  const configDirectory = path.dirname(absoluteConfigPath);
  if (typeof raw.allowedRoot !== "string" || raw.allowedRoot.length === 0) {
    fail("Configuration allowedRoot must be a non-empty string.", "INVALID_CONFIG");
  }

  const allowedRoot = path.resolve(configDirectory, raw.allowedRoot);
  let allowedRootStat;
  try {
    allowedRootStat = fs.statSync(allowedRoot);
  } catch (error) {
    fail(`Configuration allowedRoot could not be inspected: ${error.message}`, "INVALID_CONFIG");
  }
  if (!allowedRootStat.isDirectory()) {
    fail("Configuration allowedRoot must name an existing directory.", "INVALID_CONFIG");
  }

  return Object.freeze({
    configPath: absoluteConfigPath,
    allowedRoot: fs.realpathSync(allowedRoot),
    registryPath: resolveConfigPath(configDirectory, raw.registryPath, "registryPath"),
    logDirectory: resolveConfigPath(configDirectory, raw.logDirectory, "logDirectory")
  });
}
