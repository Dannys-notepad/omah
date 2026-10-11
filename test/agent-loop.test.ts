import assert from "node:assert/strict";
import test from "node:test";
import { runLoop } from "../agent.js";

function createArgs() {
  return {
    systemPrompt: "test prompt",
    task: "test task",
    resumeText: "",
    conversation: {
      version: 1 as const,
      taskId: "test",
      taskText: "test task",
      targetRepo: "owner/repo",
      baseBranch: "main",
      branchName: "omah/test-12345678",
      steps: [],
      finished: false,
      startedAt: new Date().toISOString(),
    },
    keys: [
      {
        provider: "gemini" as const,
        model: "test-model",
        baseURL: null,
        key: "test-key",
      },
    ],
    targetRepo: "owner/repo",
    branchName: "omah/test-12345678",
    appToken: "",
    startSha: "test-sha",
  };
}

function modelResponse(text: string) {
  return {
    text,
    usage: { input: 0, output: 0, thoughts: 0, ms: 0, keyIndex: 0 },
  };
}

test("blocks after three malformed model replies", async () => {
  let calls = 0;
  const result = await runLoop(createArgs(), {
    maxRuntimeMs: 10_000,
    callModel: async () => {
      calls += 1;
      return modelResponse("not valid JSON");
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /3 consecutive tool errors/);
});

test("dispatches one normalized native tool call", async () => {
  const args = createArgs();
  const result = await runLoop(args, {
    maxRuntimeMs: 10_000,
    callModel: async () => ({
      text: "",
      toolCalls: [{
        name: "finish",
        arguments: { summary: "Completed", status: "done" },
      }],
      usage: { input: 0, output: 0, thoughts: 0, ms: 0, keyIndex: 0 },
    }),
  });

  assert.deepEqual(result, { summary: "Completed", status: "done" });
  assert.equal(args.conversation.steps[0].tool, "finish");
});

test("blocks when a provider cooldown exceeds the remaining budget", async () => {
  let calls = 0;
  const rateLimit = Object.assign(new Error("rate limit exceeded"), {
    status: 429,
    retryAfterMs: 30_000,
  });
  const result = await runLoop(createArgs(), {
    maxRuntimeMs: 1_000,
    callModel: async () => {
      calls += 1;
      throw rateLimit;
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /cooldown exceeds the remaining wall-clock budget/);
});

test("blocks when a provider never responds within the run budget", async () => {
  let calls = 0;
  const result = await runLoop(createArgs(), {
    maxRuntimeMs: 25,
    callModel: () => {
      calls += 1;
      return new Promise(() => {});
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /while waiting for an LLM response/);
});