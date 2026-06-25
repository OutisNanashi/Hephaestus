import fs from "node:fs";
import path from "node:path";
import { ADAPTER_IDS, getAdapter } from "./agent-adapters.js";
import { fail } from "./errors.js";
import { resolveConfigPath } from "./safe-path.js";

const REQUIRED_CONFIG_KEYS = ["allowedRoot", "registryPath", "logDirectory"];
const OPTIONAL_CONFIG_KEYS = new Set(["notifications", "brain", "adapters"]);
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

function adaptersConfig(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") fail("Configuration adapters must be a JSON object.", "INVALID_CONFIG");
  const entries = {};
  for (const [adapterId, settings] of Object.entries(raw)) {
    if (!ADAPTER_IDS.includes(adapterId) || getAdapter(adapterId) === null) {
      fail(`Configuration adapters contains an unknown adapter: ${adapterId}.`, "INVALID_CONFIG");
    }
    if (!settings || Array.isArray(settings) || typeof settings !== "object") {
      fail(`Configuration adapters.${adapterId} must be a JSON object.`, "INVALID_CONFIG");
    }
    const allowedKeys = ["enabled"];
    const settingKeys = Object.keys(settings);
    if (settingKeys.some((key) => !allowedKeys.includes(key))) {
      fail(`Configuration adapters.${adapterId} contains an unsupported key.`, "INVALID_CONFIG");
    }
    if (typeof settings.enabled !== "boolean") {
      fail(`Configuration adapters.${adapterId}.enabled must be a boolean.`, "INVALID_CONFIG");
    }
    entries[adapterId] = Object.freeze({ enabled: settings.enabled });
  }
  return Object.freeze(entries);
}

function brainConfig(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object" || Object.keys(raw).some((key) => !["provider", "apiKeyEnv", "model"].includes(key))) fail("Configuration brain settings are invalid.", "INVALID_CONFIG");
  const provider = raw.provider === undefined ? "openai" : String(raw.provider).trim().toLowerCase();
  if (!["openai", "gpt"].includes(provider)) fail("Configuration brain provider must be OpenAI/GPT.", "INVALID_CONFIG");
  if (typeof raw.model !== "string" || raw.model.trim() === "") fail("Configuration brain model must be a non-empty string.", "INVALID_CONFIG");
  if (raw.apiKeyEnv !== undefined && raw.apiKeyEnv !== "OPENAI_API_KEY") fail("Configuration brain apiKeyEnv must be OPENAI_API_KEY.", "INVALID_CONFIG");
  if (raw.apiKeyEnv !== undefined && !ENVIRONMENT_NAME.test(raw.apiKeyEnv)) fail("Configuration brain apiKeyEnv must be an environment variable name.", "INVALID_CONFIG");
  return Object.freeze({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", model: raw.model.trim() });
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
  loadLocalEnvironment(path.resolve(".env"));
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
    ...(raw.notifications === undefined ? {} : { notifications: notificationConfig(raw.notifications) }),
    ...(raw.brain === undefined ? {} : { brain: brainConfig(raw.brain) }),
    ...(raw.adapters === undefined ? {} : { adapters: adaptersConfig(raw.adapters) })
  });
}
