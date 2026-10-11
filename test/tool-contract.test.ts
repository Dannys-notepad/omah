import assert from "node:assert/strict";
import test from "node:test";
import {
  parseToolCall,
  TOOL_DEFINITIONS,
  validateNativeToolCall,
  validateToolCall,
} from "../src/tool-contract.js";

test("parses canonical and fenced JSON tool envelopes", () => {
  const envelope = JSON.stringify({
    reasoning: "Inspect the source.",
    tool: "read_file",
    args: { path: "src/main.ts" },
  });

  assert.equal(parseToolCall(envelope, "gemini").kind, "call");
  assert.equal(parseToolCall(`\`\`\`json\n${envelope}\n\`\`\``, "groq").kind, "call");
});

test("accepts Poolside flat and JSON-wrapped XML calls only", () => {
  const flat = '{"reasoning":"run checks","tool":"run_bash","command":"npm test"}';
  const xml = `<tool_call>${JSON.stringify({
    tool: "run_bash",
    args: { command: "npm test" },
  })}</tool_call>`;

  assert.equal(parseToolCall(flat, "poolside").kind, "call");
  assert.equal(parseToolCall(xml, "poolside").kind, "call");
  assert.equal(parseToolCall(flat, "gemini").kind, "invalid");
  assert.equal(parseToolCall(xml, "gemini").kind, "none");
});

test("accepts one Poolside call in prose but rejects ambiguity", () => {
  const call = '{"tool":"read_file","args":{"path":"README.md"}}';
  assert.equal(parseToolCall(`<tool_call>${call}</tool_call>`, "poolside").kind, "call");
  assert.equal(parseToolCall(`Result: ${call}`, "poolside").kind, "call");
  assert.deepEqual(
    parseToolCall(`Example: ${call}\nActual: ${call}`, "poolside"),
    { kind: "invalid", message: "multiple possible tool calls; reply with exactly one" },
  );
  assert.equal(parseToolCall(`Result: ${call}`, "groq").kind, "none");
});

test("rejects missing, wrongly typed, and extra tool arguments", () => {
  assert.equal(validateToolCall("read_file", {}).kind, "invalid");
  assert.equal(validateToolCall("run_bash", { command: 4 }).kind, "invalid");
  assert.equal(
    validateToolCall("read_file", { path: "README.md", extra: true }).kind,
    "invalid",
  );
  assert.equal(
    validateToolCall("finish", { summary: "done", status: "success" }).kind,
    "invalid",
  );
});

test("validates native calls against the same schema", () => {
  assert.equal(
    validateNativeToolCall({
      name: "request_write",
      arguments: { path: "src/new.ts" },
    }).kind,
    "call",
  );
  assert.equal(
    validateNativeToolCall({ name: "finish", arguments: { summary: "done" } }).kind,
    "invalid",
  );
});

test("does not treat raw file content as a tool call", () => {
  assert.equal(
    parseToolCall("const answer = 42;\n<<<OMAH_END>>>", "poolside").kind,
    "none",
  );
  assert.equal(TOOL_DEFINITIONS.length, 5);
  assert.ok(TOOL_DEFINITIONS.every((tool) => tool.parameters.additionalProperties === false));
});