import { validateOpenAIDecision } from "./brain.js";
import { fail } from "./errors.js";
import { redactSecrets } from "./notification.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 800;
const MAX_RATE_LIMIT_RETRIES = 2;

function text(value, label, code) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required.`, code);
  return value.trim();
}

/** Request a JSON-only coding decision; this function never writes project files. */
function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 2_000) : 250 * (2 ** attempt);
}

function outputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim() !== "") return payload.output_text;
  if (!Array.isArray(payload?.output)) return null;
  const parts = [];
  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === "string" && content.text.trim() !== "") parts.push(content.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

const DECISION_JSON_SUFFIX = "\n\nRespond with ONLY one valid JSON object with exactly these keys: nextAction, rationale, allowedFiles, requiredTests, stopConditions, and optionally loopSignal. No markdown, no code fences, no commentary.";

// Tolerate models that wrap JSON in ```json fences or add surrounding prose; validation itself is never relaxed.
function extractJsonText(raw) {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  if (fence) text = fence[1].trim();
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first !== -1 && last > first ? text.slice(first, last + 1) : text;
}

// Returns a validated object or null; null means "invalid, worth one stricter retry". Never accepts malformed output.
function parseWith(validate, rawText) {
  if (typeof rawText !== "string" || rawText.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch {
    return null;
  }
  try {
    return validate(parsed);
  } catch {
    return null;
  }
}

/** Request a JSON-only coding decision; this function never writes project files. */
async function requestOutputText({ key, model, prompt, fetchImpl, sleepImpl }) {
  let response;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: prompt, max_output_tokens: MAX_OUTPUT_TOKENS })
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      fail(`OpenAI request failed: ${redactSecrets(reason)}`, "OPENAI_PROVIDER_FAILED");
    }
    if (response?.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) break;
    await sleepImpl(retryDelay(response, attempt));
  }
  if (response?.status === 429) fail("OpenAI request rate limited after bounded retries.", "OPENAI_RATE_LIMITED");
  if (!response?.ok) fail(`OpenAI request failed with status ${response?.status ?? "unknown"}.`, "OPENAI_PROVIDER_FAILED");
  try {
    return outputText(await response.json());
  } catch {
    fail("OpenAI response was not valid JSON.", "OPENAI_PROVIDER_FAILED");
  }
}

/** Request one strictly validated JSON object from OpenAI, with a single stricter retry. */
export async function requestOpenAIStructured({ apiKey, model, input, validate, strictSuffix = DECISION_JSON_SUFFIX, failureCode = "INVALID_OPENAI_DECISION", fetchImpl = globalThis.fetch, sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) }) {
  const key = text(apiKey, "OpenAI API key", "OPENAI_API_KEY_MISSING");
  const selectedModel = text(model, "OpenAI model", "INVALID_OPENAI_CONFIG");
  const prompt = text(input, "OpenAI input", "INVALID_OPENAI_INPUT");
  if (typeof fetchImpl !== "function") fail("OpenAI fetch implementation is unavailable.", "OPENAI_PROVIDER_FAILED");
  if (typeof validate !== "function") fail("OpenAI structured request requires a validator.", "OPENAI_PROVIDER_FAILED");

  const first = parseWith(validate, await requestOutputText({ key, model: selectedModel, prompt, fetchImpl, sleepImpl }));
  if (first !== null) return first;
  // One narrow retry with a stricter JSON-only instruction; validation stays strict, malformed output is still rejected.
  const retry = parseWith(validate, await requestOutputText({ key, model: selectedModel, prompt: `${prompt}${strictSuffix}`, fetchImpl, sleepImpl }));
  if (retry !== null) return retry;
  fail("OpenAI response text was not valid JSON for this request.", failureCode);
}

export async function requestOpenAIDecision(options) {
  return requestOpenAIStructured({ ...options, validate: validateOpenAIDecision, failureCode: "INVALID_OPENAI_DECISION" });
}
