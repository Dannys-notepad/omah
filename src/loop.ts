// src/loop.ts
// The agent loop. Runs until the model calls finish or a budget is hit.
// Uses tools.ts for tool execution and infra.ts for process plumbing.

import { readFileSync } from "node:fs";
import {
  makeProvider,
  classifyError,
  type KeySpec,
  type LLMProvider,
  type LLMMessage,
} from "./llm.js";
import { fingerprint, isPerDayLimit, resetTimeFor } from "./keystate.js";
import {
  parseToolCall,
  TOOL_DEFINITIONS,
  validateNativeToolCall,
  type ParseToolCallResult,
  type ToolCall,
  type ToolName,
} from "./tool-contract.js";
import { compressHistory, MIN_STEPS_BETWEEN } from "./history.js";
import type {
  Conversation,
  ConversationStep,
  Message,
  ToolResult,
  UsageInfo,
  WriteState,
} from "./types.js";
import {
  WALL_CLOCK_MS,
  MAX_CONSECUTIVE_ERRORS,
  MAX_LLM_RETRIES,
  SENTINEL_MORE,
  SENTINEL_END,
  RETRYABLE_KEY_COOLDOWN_MS,
  BASH_HEAD_CHARS,
  BASH_TAIL_CHARS,
} from "./config.js";
import {
  log,
  sleep,
  truncate,
  truncateHeadTail,
  pickKey,
  safePath,
  saveConversation,
} from "./infra.js";
import {
  buildBashDigest,
  handleRawChunk,
  rawWriteRetryInstruction,
  runTool,
  writeAsAgentBytes,
} from "./tools.js";
import {
  usageLog,
  keyStats,
  persistedState,
  recordKeyCall,
  recordKeyRateLimit,
  recordKeyError,
  setLastUsedProvider,
} from "./state.js";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface RunLoopArgs {
  systemPrompt: string;
  task: string;
  resumeText: string;
  conversation: Conversation;
  keys: KeySpec[];
  targetRepo: string;
  branchName: string;
  appToken: string;
  startSha: string;
}

export interface RunLoopResult {
  summary: string;
  status: "done" | "blocked";
  compressionsDone: number;
}

export interface RunLoopOptions {
  maxRuntimeMs?: number;
  callModel?: typeof callModel;
  sharedQuotaProviders?: string[];
  cooldownUntil?: Map<number, number>;
}

class RunBudgetExceededError extends Error {}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RunBudgetExceededError()), Math.max(0, timeoutMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function recordStep(
  conversation: Conversation,
  entry: Omit<ConversationStep, "step" | "at"> & { at?: string },
  digest?: Pick<ToolResult, "exitCode" | "keyLines" | "keyLinesTotal" | "testSummary">,
  measure = false,
): number {
  const stepNumber = conversation.steps.length + 1;
  const record: ConversationStep = {
    ...entry,
    step: stepNumber,
    at: entry.at ?? new Date().toISOString(),
  };
  if (measure) {
    record.result.outputBytes = Buffer.byteLength(entry.result.output, "utf8");
    record.result.outputLines = entry.result.output.split("\n").length;
  }
  if (digest) {
    if (digest.exitCode !== undefined) record.result.exitCode = digest.exitCode;
    if (digest.keyLines && digest.keyLines.length > 0) {
      record.result.keyLines = digest.keyLines;
    }
    if (digest.keyLinesTotal !== undefined) {
      record.result.keyLinesTotal = digest.keyLinesTotal;
    }
    if (digest.testSummary) record.result.testSummary = digest.testSummary;
  }
  conversation.steps.push(record);
  return stepNumber;
}

// ---------------------------------------------------------------
// Scripted responses (hostile test)
// ---------------------------------------------------------------

let scriptedResponses: string[] | null = null;
let scriptedIndex = 0;

function loadScriptedResponses(): string[] {
  const p = process.env.OMAH_SCRIPT!;
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.responses)) {
    throw new Error("OMAH_SCRIPT: missing 'responses' array");
  }
  return parsed.responses.map(String);
}

// ---------------------------------------------------------------
// Model call
// ---------------------------------------------------------------

async function callModel(
  provider: LLMProvider,
  systemPrompt: string,
  history: Message[],
  jsonMode: boolean,
  keyIndex: number,
): Promise<{
  text: string;
  toolCalls?: ToolCall[];
  usage: UsageInfo;
  note?: string;
}> {
  if (process.env.OMAH_SCRIPT) {
    if (scriptedResponses === null) {
      try {
        scriptedResponses = loadScriptedResponses();
      } catch (err: any) {
        throw new Error(`OMAH_SCRIPT load failed: ${err?.message ?? err}`);
      }
      await log(`OMAH_SCRIPT: loaded ${scriptedResponses.length} responses`);
    }
    if (scriptedIndex >= scriptedResponses.length) {
      await log("OMAH_SCRIPT: responses exhausted; returning finish(done)");
      return {
        text: JSON.stringify({
          reasoning: "Scripted responses exhausted.",
          tool: "finish",
          args: { summary: "Hostile test script exhausted.", status: "done" },
        }),
        usage: { input: 0, output: 0, thoughts: 0, ms: 0, keyIndex },
      };
    }
    const reply = scriptedResponses[scriptedIndex++];
    await log(`OMAH_SCRIPT: returning response ${scriptedIndex}/${scriptedResponses.length}`);
    return {
      text: reply,
      usage: { input: 0, output: 0, thoughts: 0, ms: 0, keyIndex },
    };
  }

  const llmHistory: LLMMessage[] = history.map((m) => ({
    role: m.role === "model" ? "assistant" : "user",
    content: m.parts[0].text,
  }));

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      const result = await provider.complete(
        {
          systemPrompt,
          history: llmHistory,
          jsonMode,
          ...(jsonMode ? { tools: TOOL_DEFINITIONS } : {}),
        },
        keyIndex,
      );
      recordKeyCall(keyIndex);
      setLastUsedProvider(provider.constructor.name === "GeminiProvider" ? "gemini" : null);
      return {
        text: result.text,
        toolCalls: result.toolCalls,
        usage: result.usage,
        note: result.note,
      };
    } catch (err: any) {
      lastErr = err;
      const kind = classifyError(err);

      if (kind === "quota") {
        const s = keyStats.get(keyIndex);
        if (!s || s.rate429 === 0) {
          await log(`key ${keyIndex + 1} 429 (full message): ${String(err?.message ?? err)}`);
        }
        recordKeyRateLimit(keyIndex, String(err?.message ?? err));
        throw err;
      }

      if (
        (err as any)?.status === 400 &&
        /json_validate_failed|Failed to validate JSON|Failed to generate JSON/i.test(
          String((err as any)?.message ?? ""),
        )
      ) {
        await log(`key ${keyIndex + 1} json validation failure; not retrying`);
        recordKeyError(keyIndex, String(err?.message ?? err));
        throw err;
      }

      if (kind === "fatal" || kind === "rotate") {
        await log(
          `key ${keyIndex + 1} ${kind} error: ${String(err?.message ?? err).slice(0, 500)}`,
        );
        recordKeyError(keyIndex, String(err?.message ?? err));
        throw err;
      }

      const delay = 2000 * Math.pow(2, attempt);
      const statusCode = (err as any)?.status ?? "?";
      const snippet = String((err as any)?.message ?? err).slice(0, 120);
      await log(
        `attempt ${attempt + 1}/${MAX_LLM_RETRIES} failed (status=${statusCode}): ${snippet}`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------
// The loop
// ---------------------------------------------------------------

export async function runLoop(
  args: RunLoopArgs,
  options: RunLoopOptions = {},
): Promise<RunLoopResult> {
  const startedAt = Date.now();
  const maxRuntimeMs = options.maxRuntimeMs ?? WALL_CLOCK_MS;
  const invokeModel = options.callModel ?? callModel;
  const cooldownUntil = options.cooldownUntil ?? new Map<number, number>();
  const sharedQuotaInput =
    options.sharedQuotaProviders ?? process.env.OMAH_SHARED_QUOTA_PROVIDERS ?? "";
  const sharedQuotaList = Array.isArray(sharedQuotaInput)
    ? sharedQuotaInput
    : String(sharedQuotaInput).split(",");
  const sharedQuotaProviders = new Set(
    sharedQuotaList.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );
  const history: Message[] = [];
  let consecutiveErrors = 0;
  let lastFailure = "";
  let keyIndex = 0;

  let lastCompressAtStepCount = args.conversation.steps.length > 0 ? -MIN_STEPS_BETWEEN : 0;
  let compressionsDone = 0;

  let writeState: WriteState | null = null;
  let pendingWriteReasoning = "";
  let pendingWritePath = "";

  if (args.conversation.steps.length > 0) {
    history.push({
      role: "user",
      parts: [{ text: `Task: ${args.conversation.taskText}` }],
    });
    for (const step of args.conversation.steps) {
      history.push({
        role: "model",
        parts: [
          {
            text: JSON.stringify({
              reasoning: step.reasoning,
              tool: step.tool,
              args: step.args,
            }),
          },
        ],
      });
      history.push({
        role: "user",
        step: step.step,
        parts: [
          {
            text: `Tool result (${step.result.ok ? "ok" : "error"}):\n${step.result.output}`,
          },
        ],
      });
    }
    if (args.resumeText && history.length > 0) {
      const last = history[history.length - 1];
      if (last.role === "user") {
        last.parts[0].text += `\n\nFollow-up: ${args.resumeText}`;
      } else {
        history.push({
          role: "user",
          parts: [{ text: `Follow-up: ${args.resumeText}` }],
        });
      }
    }
  } else {
    history.push({
      role: "user",
      parts: [{ text: `Task: ${args.task}` }],
    });
  }

  while (true) {
    if (Date.now() - startedAt >= maxRuntimeMs) {
      return {
        summary: `Wall-clock budget exceeded after ${args.conversation.steps.length} steps.`,
        status: "blocked",
        compressionsDone,
      };
    }
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      return {
        summary:
          `Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive tool errors.` +
          (lastFailure ? ` Last failure: ${lastFailure}` : ""),
        status: "blocked",
        compressionsDone,
      };
    }

    if (!writeState) {
      const stepsSince = args.conversation.steps.length - lastCompressAtStepCount;
      if (compressionsDone < 3) {
        try {
          const compressed = compressHistory(
            history,
            args.conversation.steps,
            { startSha: args.startSha },
            { stepsSinceLastCompress: stepsSince, compressionsDone },
          );
          if (compressed.didCompress) {
            lastCompressAtStepCount = args.conversation.steps.length;
            compressionsDone += 1;
            await log(
              `[compress] pass ${compressionsDone} applied ` +
                `(step ${args.conversation.steps.length}, ${history.length} msgs)`,
            );
          }
        } catch (err: any) {
          await log(`[compress] skipped: ${String(err?.message ?? err).slice(0, 200)}`);
        }
      }
    }

    const pick = pickKey(args.keys, keyIndex, cooldownUntil);
    if (pick.kind === "exhausted") {
      return {
        summary: "All LLM keys are exhausted for the day.",
        status: "blocked",
        compressionsDone,
      };
    }
    if (pick.kind === "wait") {
      const remainingMs = maxRuntimeMs - (Date.now() - startedAt);
      if (pick.waitMs >= remainingMs) {
        return {
          summary:
            `LLM key cooldown exceeds the remaining wall-clock budget after ` +
            `${args.conversation.steps.length} steps.`,
          status: "blocked",
          compressionsDone,
        };
      }
      await log(
        `all keys cooling; sleeping ${Math.round(pick.waitMs / 1000)}s until earliest wake`,
      );
      await sleep(pick.waitMs);
      continue;
    }
    keyIndex = pick.index;

    const keySpec = args.keys[keyIndex];
    const provider: LLMProvider = makeProvider(keySpec);

    let responseText: string;
    let responseNote: string | undefined;
    let responseToolCalls: ToolCall[] | undefined;
    const stepForLog = args.conversation.steps.length + 1;
    const remainingMs = maxRuntimeMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return {
        summary: `Wall-clock budget exceeded after ${args.conversation.steps.length} steps.`,
        status: "blocked",
        compressionsDone,
      };
    }
    try {
      const result: Awaited<ReturnType<typeof invokeModel>> = await withTimeout(
        invokeModel(provider, args.systemPrompt, history, writeState === null, keyIndex),
        remainingMs,
      );
      responseText = result.text;
      responseToolCalls = result.toolCalls;
      if (responseToolCalls?.length === 1) {
        responseText = JSON.stringify({
          reasoning: responseToolCalls[0].reasoning ?? "",
          tool: responseToolCalls[0].name,
          args: responseToolCalls[0].arguments,
        });
      } else if (responseToolCalls && responseToolCalls.length > 1) {
        responseText = "[multiple native tool calls returned]";
      }
      responseNote = result.note;
      usageLog.push({
        step: stepForLog,
        input: result.usage.input,
        output: result.usage.output,
        thoughts: result.usage.thoughts,
        ms: result.usage.ms,
        tool: writeState ? "write_content" : "(pending)",
      });
      await log(
        `[step ${stepForLog}] llm: provider=${keySpec.provider} model=${keySpec.model} ` +
          `in=${result.usage.input} out=${result.usage.output}` +
          (result.usage.thoughts ? ` thoughts=${result.usage.thoughts}` : "") +
          ` ms=${result.usage.ms} key=${keyIndex + 1}` +
          (responseNote ? ` ${responseNote}` : ""),
      );
    } catch (err) {
      if (err instanceof RunBudgetExceededError) {
        return {
          summary:
            `Wall-clock budget exceeded while waiting for an LLM response ` +
            `after ${args.conversation.steps.length} steps.`,
          status: "blocked",
          compressionsDone,
        };
      }
      const kind = classifyError(err);
      const errAny = err as any;

      if (kind === "quota") {
        const ks = args.keys[keyIndex];
        const sharedBucket = sharedQuotaProviders.has(ks.provider.toLowerCase());
        const affectedKeys = sharedBucket
          ? args.keys.flatMap((key, index) => (key.provider === ks.provider ? [index] : []))
          : [keyIndex];

        if (isPerDayLimit(err)) {
          for (const affectedKey of affectedKeys) {
            const affectedSpec = args.keys[affectedKey];
            const fp = fingerprint(affectedSpec.provider, affectedSpec.key);
            cooldownUntil.set(affectedKey, Number.POSITIVE_INFINITY);
            persistedState.keys.keys[fp] = {
              status: "exhausted",
              reason: "PerDay",
              reset_at: resetTimeFor(err, affectedSpec.provider),
              last_seen: new Date().toISOString(),
            };
          }
          await log(
            sharedBucket
              ? `provider ${ks.provider} shared per-day quota exhausted across ${affectedKeys.length} keys; persisted`
              : `key ${keyIndex + 1} (${ks.provider}) per-day exhausted; persisted`,
          );
        } else {
          const wait = Number(errAny?.retryAfterMs ?? 60_000);
          const cooldown = Date.now() + wait;
          for (const affectedKey of affectedKeys) {
            cooldownUntil.set(affectedKey, cooldown);
          }
          await log(
            sharedBucket
              ? `provider ${ks.provider} shared quota cooling ${affectedKeys.length} keys for ${Math.round(wait / 1000)}s`
              : `key ${keyIndex + 1} (${ks.provider}) cooling ${Math.round(wait / 1000)}s (per-minute)`,
          );
        }

        keyIndex = (keyIndex + 1) % args.keys.length;
        continue;
      }

      if (kind === "retryable") {
        const bad = args.keys[keyIndex].provider;
        cooldownUntil.set(keyIndex, Date.now() + RETRYABLE_KEY_COOLDOWN_MS);
        await log(
          `key ${keyIndex + 1} (${bad}) cooling ${Math.round(RETRYABLE_KEY_COOLDOWN_MS / 1000)}s after retryable error`,
        );
        keyIndex = (keyIndex + 1) % args.keys.length;
        continue;
      }

      if (kind === "rotate") {
        const bad = args.keys[keyIndex].provider;
        for (let i = 0; i < args.keys.length; i++) {
          if (args.keys[i].provider === bad) {
            cooldownUntil.set(i, Number.POSITIVE_INFINITY);
          }
        }
        await log(`provider ${bad} marked dead for this run [${String(errAny?.status ?? "?")}]`);
        keyIndex = (keyIndex + 1) % args.keys.length;
        continue;
      }

      const msg = String(errAny?.message ?? errAny ?? "unknown error").slice(0, 300);
      const statusCode = errAny?.status ?? errAny?.code ?? errAny?.response?.status;
      const label = `LLM call failed (status=${statusCode ?? "unknown"})`;
      await log(`blocking: ${label}: ${msg}`);
      return {
        summary: `${label}: ${msg}`,
        status: "blocked",
        compressionsDone,
      };
    }

    if (writeState) {
      const outcome = handleRawChunk(responseText, writeState, writeState.path);

      if (outcome.kind === "error") {
        lastFailure = `${writeState.path} (${outcome.code}): ${outcome.message}`;
        if (outcome.code === "TOOL_CALL_GUARD") {
          await log(
            `guard: rejected raw write for ${writeState.path} ` + `(looks like a tool call)`,
          );
        }
        await log(`write error [${outcome.code}]: ${outcome.message}`);

        history.push({
          role: "model",
          parts: [{ text: "[attempted JSON tool call instead of raw content]" }],
        });
        const writeErrorStep = args.conversation.steps.length + 1;
        history.push({
          role: "user",
          step: writeErrorStep,
          parts: [
            {
              text:
                `Tool result (error):\n${outcome.message}\n\n` +
                rawWriteRetryInstruction(writeState.path, outcome.code, keySpec.provider),
            },
          ],
        });
        recordStep(args.conversation, {
          reasoning: pendingWriteReasoning,
          tool: "request_write",
          args: { path: pendingWritePath },
          result: {
            ok: false,
            output: `[${outcome.code}] ${outcome.message}`,
          },
        });
        writeState = null;
        consecutiveErrors += 1;
        await saveConversation(args.conversation, args.targetRepo, args.appToken);
        continue;
      }

      if (outcome.kind === "more") {
        history.push({
          role: "model",
          parts: [{ text: `[raw file chunk for ${writeState.path}]` }],
        });
        history.push({
          role: "user",
          parts: [
            {
              text:
                "Continue with the next chunk. End the final chunk with a line " +
                `containing only ${SENTINEL_END}. Do not repeat the file header.`,
            },
          ],
        });
        continue;
      }

      const contents = Buffer.concat(writeState.chunks);
      const writeResult = await writeAsAgentBytes(writeState.path, contents);

      const stepNo = args.conversation.steps.length + 1;
      if (writeResult.ok) {
        await log(
          `[step ${stepNo}] request_write ${writeState.path} ` +
            `(${contents.length} bytes, ${writeState.chunks.length} chunk(s))`,
        );
      } else {
        await log(
          `[step ${stepNo}] request_write ${writeState.path} FAILED: ${writeResult.output}`,
        );
      }

      history.push({
        role: "model",
        parts: [{ text: `[raw file content for ${writeState.path}]` }],
      });
      history.push({
        role: "user",
        step: stepNo,
        parts: [
          {
            text: writeResult.ok
              ? `Tool result (ok): wrote ${writeState.path} (${contents.length} bytes)`
              : `Tool result (error): ${writeResult.output}`,
          },
        ],
      });

      recordStep(args.conversation, {
        reasoning: pendingWriteReasoning,
        tool: "request_write",
        args: { path: writeState.path },
        result: {
          ok: writeResult.ok,
          output: writeResult.ok
            ? `wrote ${writeState.path} (${contents.length} bytes)`
            : writeResult.output,
        },
      });

      if (writeResult.ok) {
        consecutiveErrors = 0;
        lastFailure = "";
      } else {
        consecutiveErrors += 1;
        lastFailure = `${writeState.path}: ${writeResult.output}`;
      }

      writeState = null;
      await saveConversation(args.conversation, args.targetRepo, args.appToken);
      continue;
    }

    const parseResult: ParseToolCallResult = responseToolCalls
      ? responseToolCalls.length === 1
        ? validateNativeToolCall(responseToolCalls[0])
        : {
            kind: "invalid" as const,
            message: "multiple native tool calls are unsupported; return one call",
          }
      : parseToolCall(responseText, keySpec.provider);
    if (parseResult.kind !== "call") {
      const parseError =
        parseResult.kind === "invalid"
          ? parseResult.message
          : "reply with exactly one valid tool call";
      lastFailure = `invalid model call from ${keySpec.provider}: ${parseError}`;
      await log(`could not parse model output (${responseText.length} chars):`);
      await log(responseText.slice(0, 2000));
      consecutiveErrors += 1;
      const echoed = responseText.trim() ? responseText : "[empty reply]";
      history.push({ role: "model", parts: [{ text: echoed }] });
      history.push({
        role: "user",
        parts: [
          {
            text:
              `Your previous reply was invalid: ${parseError}. ` +
              "Use exactly one declared function call. If function calling " +
              "is unavailable, use one JSON tool envelope with a valid argument schema.",
          },
        ],
      });
      continue;
    }
    const parsed: {
      reasoning: string;
      tool: ToolName;
      args: Record<string, unknown>;
    } = {
      reasoning: parseResult.call.reasoning ?? "",
      tool: parseResult.call.name as ToolName,
      args: parseResult.call.arguments as Record<string, unknown>,
    };

    const step = args.conversation.steps.length + 1;
    await log(`[step ${step}] ${parsed.tool}`);

    if (usageLog.length > 0) {
      const last = usageLog[usageLog.length - 1];
      if (last.tool === "(pending)") last.tool = parsed.tool;
    }

    if (parsed.tool === "finish") {
      const summary = String(parsed.args.summary ?? "");
      const status = parsed.args.status === "blocked" ? "blocked" : "done";
      recordStep(args.conversation, {
        reasoning: parsed.reasoning,
        tool: "finish",
        args: parsed.args,
        result: { ok: true, output: summary },
      });
      return { summary, status, compressionsDone };
    }

    if (parsed.tool === "request_write") {
      const p = String(parsed.args.path ?? "");
      if (!p) {
        consecutiveErrors += 1;
        lastFailure = "request_write: missing path";
        history.push({ role: "model", parts: [{ text: responseText }] });
        history.push({
          role: "user",
          parts: [
            {
              text:
                "Tool result (error): request_write needs a path. " +
                'Respond with {"reasoning": "...", "tool": "request_write", "args": {"path": "..."}}',
            },
          ],
        });
        continue;
      }

      try {
        // Validate path is inside the workspace.
        safePath(p);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        consecutiveErrors += 1;
        lastFailure = `request_write ${p}: ${msg}`;
        history.push({ role: "model", parts: [{ text: responseText }] });
        const stepNo = args.conversation.steps.length + 1;
        history.push({
          role: "user",
          step: stepNo,
          parts: [{ text: `Tool result (error): ${msg}` }],
        });
        recordStep(args.conversation, {
          reasoning: parsed.reasoning,
          tool: "request_write",
          args: { path: p },
          result: { ok: false, output: msg },
        });
        await saveConversation(args.conversation, args.targetRepo, args.appToken);
        continue;
      }

      pendingWritePath = p;
      pendingWriteReasoning = parsed.reasoning;
      writeState = { path: p, chunks: [], bytesTotal: 0 };

      history.push({ role: "model", parts: [{ text: responseText }] });
      history.push({
        role: "user",
        parts: [
          {
            text:
              `Reply with the raw contents of ${p}. Do not wrap it in JSON, ` +
              `do not add fences, do not add explanation. End with a line ` +
              `containing only ${SENTINEL_END}. If the file is large, split ` +
              `it: end each non-final chunk with ${SENTINEL_MORE} on its own line. ` +
              `Keep each chunk under 250 lines.`,
          },
        ],
      });
      continue;
    }

    const result: ToolResult = await runTool(parsed.tool, parsed.args).catch((e) => ({
      ok: false,
      output: String(e?.message ?? e),
    }));

    const isBash = parsed.tool === "run_bash";
    const historyOutput = isBash
      ? truncateHeadTail(result.output, BASH_HEAD_CHARS, BASH_TAIL_CHARS)
      : truncate(result.output, 4000);

    const stepNo = args.conversation.steps.length + 1;
    recordStep(
      args.conversation,
      {
        reasoning: parsed.reasoning,
        tool: parsed.tool,
        args: parsed.args,
        result: {
          ok: result.ok,
          output: truncate(result.output, 2000),
          truncated: result.output.length > 2000,
        },
      },
      isBash
        ? {
            exitCode: result.exitCode,
            keyLines: result.keyLines,
            keyLinesTotal: result.keyLinesTotal,
            testSummary: result.testSummary,
          }
        : undefined,
      isBash,
    );

    history.push({ role: "model", parts: [{ text: responseText }] });
    history.push({
      role: "user",
      step: stepNo,
      parts: [
        {
          text: `Tool result (${result.ok ? "ok" : "error"}):\n${historyOutput}`,
        },
      ],
    });

    if (result.ok) {
      consecutiveErrors = 0;
      lastFailure = "";
    } else {
      consecutiveErrors += 1;
      lastFailure = `${parsed.tool}: ${truncate(result.output, 300)}`;
    }

    await saveConversation(args.conversation, args.targetRepo, args.appToken);
  }
}
