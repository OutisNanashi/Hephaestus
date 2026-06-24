import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { resolveConfigPath } from "./safe-path.js";

const REQUIRED_CONFIG_KEYS = ["allowedRoot", "registryPath", "logDirectory"];
const OPTIONAL_CONFIG_KEYS = new Set(["notifications"]);
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/u;

/** Load simple local KEY=value entries without replacing explicitly supplied environment values. */
export function loadLocalEnvironment(filePath, env = process.env) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const loaded = [];
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || Object.prototype.hasOwnProperty.call(env, match[1])) continue;
    env[match[1]] = match[2];
    loaded.push(match[1]);
  }
  return Object.freeze(loaded);
}

function notificationConfig(raw) {
  if (raw === undefined) return undefined;
  if (!raw || Array.isArray(raw) || typeof raw !== "object" || Object.keys(raw).some((key) => key !== "telegram")) {
    fail("Configuration notifications must contain only an optional telegram object.", "INVALID_CONFIG");
  }
  if (raw.telegram === undefined) return Object.freeze({});
  const telegram = raw.telegram;
  const keys = ["enabled", "botTokenEnv", "chatIdEnv"];
  if (!telegram || Array.isArray(telegram) || typeof telegram !== "object" || Object.keys(telegram).some((key) => !keys.includes(key))) {
    fail("Configuration telegram notification settings are invalid.", "INVALID_CONFIG");
  }
  if (typeof telegram.enabled !== "boolean") fail("Configuration telegram enabled must be a boolean.", "INVALID_CONFIG");
  for (const key of ["botTokenEnv", "chatIdEnv"]) {
    if (telegram[key] !== undefined && (typeof telegram[key] !== "string" || !ENVIRONMENT_NAME.test(telegram[key]))) {
      fail(`Configuration telegram ${key} must be an environment variable name.`, "INVALID_CONFIG");
    }
  }
  if (telegram.enabled && (telegram.botTokenEnv === undefined || telegram.chatIdEnv === undefined)) {
    fail("Enabled Telegram notifications require botTokenEnv and chatIdEnv references.", "INVALID_CONFIG");
  }
  return Object.freeze({ telegram: Object.freeze({ ...telegram }) });
}

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
  loadLocalEnvironment(path.join(path.dirname(absoluteConfigPath), ".env"));
  const raw = readJson(absoluteConfigPath, "Configuration");
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") {
    fail("Configuration must be a JSON object.", "INVALID_CONFIG");
  }
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!(key in raw)) {
      fail(`Configuration is missing required key: ${key}.`, "INVALID_CONFIG");
    }
  }
  const allowedKeys = new Set([...REQUIRED_CONFIG_KEYS, ...OPTIONAL_CONFIG_KEYS]);
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
    logDirectory: resolveConfigPath(configDirectory, raw.logDirectory, "logDirectory"),
    ...(raw.notifications === undefined ? {} : { notifications: notificationConfig(raw.notifications) })
  });
}
