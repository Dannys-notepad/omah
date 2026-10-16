import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGeminiResponse, OpenAICompatibleProvider } from "../src/llm.js";
import { TOOL_DEFINITIONS } from "../src/tool-contract.js";

const provider = new OpenAICompatibleProvider(
  "https://provider.example/v1",
  "test-model",
  "test-key",
);

test("prefers Gemini function calls without reading the text getter", () => {
  const response: Record<string, unknown> = {
    functionCalls: [{ name: "read_file", args: { path: "README.md" } }],
  };
  Object.defineProperty(response, "text", {
    get() {
      throw new Error("text getter should not be read for function calls");
    },
  });

  assert.deepEqual(normalizeGeminiResponse(response), {
    text: "",
    toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }],
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("sends native function schemas and normalizes returned calls", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "run_bash",
                  arguments: '{"command":"npm test"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
  }) as typeof fetch;

  try {
    const result = await provider.complete(
      {
        systemPrompt: "Use a declared function.",
        history: [{ role: "user", content: "Run tests." }],
        jsonMode: true,
        tools: TOOL_DEFINITIONS,
      },
      0,
    );

    assert.equal(requestBody?.tool_choice, "required");
    assert.equal(requestBody?.tools.length, TOOL_DEFINITIONS.length);
    assert.equal(requestBody?.tools[0].type, "function");
    assert.deepEqual(result.toolCalls, [
      {
        name: "run_bash",
        arguments: { command: "npm test" },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries once in text mode only when tool calls are unsupported", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return response({ error: { message: "tool_choice is unsupported" } }, 400);
    }
    return response({
      choices: [
        { message: { content: '{"tool":"finish","args":{"summary":"ok","status":"done"}}' } },
      ],
      usage: {},
    });
  }) as typeof fetch;

  try {
    const result = await provider.complete(
      {
        systemPrompt: "Use a function, or a JSON envelope when tools are unavailable.",
        history: [{ role: "user", content: "Finish." }],
        jsonMode: true,
        tools: TOOL_DEFINITIONS,
      },
      0,
    );

    assert.equal(requestBodies.length, 2);
    assert.ok(requestBodies[0].tools);
    assert.equal("tools" in requestBodies[1], false);
    assert.equal("tool_choice" in requestBodies[1], false);
    assert.match(result.note ?? "", /retried with JSON text mode/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not send tools on raw file-content turns", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({ choices: [{ message: { content: "file bytes" } }], usage: {} });
  }) as typeof fetch;

  try {
    await provider.complete(
      {
        systemPrompt: "Return raw file bytes.",
        history: [{ role: "user", content: "Write file." }],
        jsonMode: false,
      },
      0,
    );
    assert.equal("tools" in (requestBody ?? {}), false);
    assert.equal("tool_choice" in (requestBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
