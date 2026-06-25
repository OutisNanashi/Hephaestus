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

/** Request a JSON-only coding decision; this function never writes project files. */
export async function requestOpenAIDecision({ apiKey, model, input, fetchImpl = globalThis.fetch, sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) }) {
  const key = text(apiKey, "OpenAI API key", "OPENAI_API_KEY_MISSING");
  const selectedModel = text(model, "OpenAI model", "INVALID_OPENAI_CONFIG");
  const prompt = text(input, "OpenAI input", "INVALID_OPENAI_INPUT");
  if (typeof fetchImpl !== "function") fail("OpenAI fetch implementation is unavailable.", "OPENAI_PROVIDER_FAILED");
  let response;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: selectedModel, input: prompt, max_output_tokens: MAX_OUTPUT_TOKENS })
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
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("OpenAI response was not valid JSON.", "OPENAI_PROVIDER_FAILED");
  }
  const output = outputText(payload);
  if (typeof output !== "string" || output.trim() === "") fail("OpenAI response did not contain text output.", "INVALID_OPENAI_DECISION");
  try {
    return validateOpenAIDecision(JSON.parse(output));
  } catch (error) {
    if (error?.code) throw error;
    fail("OpenAI response text was not valid decision JSON.", "INVALID_OPENAI_DECISION");
  }
}
