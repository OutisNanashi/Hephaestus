import fs from "node:fs";
import { fail } from "./errors.js";
import { assertRealPathWithinRoot, resolveSafePath } from "./safe-path.js";
import { validateMockDecision } from "./brain.js";

function readMockFixture(allowedRoot, fixturePath, label) {
  const resolvedPath = resolveSafePath(allowedRoot, fixturePath);
  let safePath;
  try {
    safePath = assertRealPathWithinRoot(allowedRoot, resolvedPath);
    if (!fs.statSync(safePath).isFile()) fail(`${label} fixture must be a regular file.`, "INVALID_MOCK_FIXTURE");
    return { path: safePath, content: fs.readFileSync(safePath, "utf8") };
  } catch (error) {
    if (error.code) throw error;
    fail(`${label} fixture could not be read: ${error.message}`, "MOCK_FIXTURE_READ_FAILED");
  }
}

/** Read a local, declared mock fixture. This provider has no network capability. */
export function requestMockDecision(allowedRoot, fixturePath) {
  const fixture = readMockFixture(allowedRoot, fixturePath, "Mock GPT");
  if (fixture.content.trim() === "") fail("Mock GPT response must not be empty.", "EMPTY_MOCK_RESPONSE");
  let response;
  try {
    response = JSON.parse(fixture.content);
  } catch (error) {
    fail(`Mock GPT response contains invalid JSON: ${error.message}`, "INVALID_MOCK_DECISION");
  }
  if (response !== null && typeof response === "object" && response.providerFailure === true) {
    if (typeof response.message !== "string" || response.message.trim() === "" || typeof response.retryable !== "boolean") {
      fail("Mock provider failure response is malformed.", "INVALID_MOCK_DECISION");
    }
    return Object.freeze({ kind: "failure", message: response.message, retryable: response.retryable, fixturePath: fixture.path });
  }
  return Object.freeze({ kind: "decision", decision: validateMockDecision(response), fixturePath: fixture.path });
}

export function loadMockAgentOutput(allowedRoot, fixturePath) {
  const fixture = readMockFixture(allowedRoot, fixturePath, "Mock agent output");
  if (fixture.content.trim() === "") fail("Mock agent output must not be empty.", "EMPTY_MOCK_AGENT_OUTPUT");
  return Object.freeze({ path: fixture.path, content: fixture.content });
}
