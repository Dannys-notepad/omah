// agent.ts
// The Omah agent loop. Runs inside a GitHub Actions runner.

import { promises as fs, appendFileSync, readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createSign } from "node:crypto";
import path from "node:path";
import os from "node:os";
import ignore from "ignore";
import {
  loadAllKeys,
  makeProvider,
  classifyError,
  type KeySpec,
  type LLMProvider,
  type LLMMessage,
} from "./src/llm.js";
import {
  loadState,
  saveState,
  addRepo,
  fingerprint,
  isPerDayLimit,
  resetTimeFor,
  type State,
} from "./src/keystate.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const WALL_CLOCK_MS = 15 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_LLM_RETRIES = 3;
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_PR_BODY_CHARS = 60_000;
const MAX_BASH_OUT = 1_000_000;

const MAX_CHUNK_BYTES = 200 * 1024;
const MAX_FILE_BYTES = 500 * 1024;

const SENTINEL_MORE = "<<<OMAH_MORE>>>";
const SENTINEL_END = "<<<OMAH_END>>>";

const RETRYABLE_PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;

const TOOL_NAMES = new Set<string>([
  "read_file",
  "request_write",
  "run_bash",
  "git_commit",
  "finish",
]);

const OMAH_ROOT = "/tmp/omah";
const WORKSPACE = path.join(OMAH_ROOT, "workspace");
const SYSTEM_PROMPT_PATH = path.join(process.cwd(), "system.md");
const IGNORE_FILE_PATH = path.join(process.cwd(), ".omahignore.default");
const AGENT_USER = "omah-runner";
const AGENT_HOME = `/home/${AGENT_USER}`;

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

type ToolName =
  | "read_file"
  | "request_write"
  | "run_bash"
  | "git_commit"
  | "finish";

interface Message {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface ConversationStep {
  step: number;
  reasoning: string;
  tool: ToolName;
  args: Record<string, unknown>;
  result: { ok: boolean; output: string; truncated?: boolean };
  at: string;
}

interface Conversation {
  version: 1;
  taskId: string;
  taskText: string;
  targetRepo: string;
  baseBranch: string;
  branchName: string;
  steps: ConversationStep[];
  finished: boolean;
  summary?: string;
  status?: "done" | "blocked";
  startedAt: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface WriteState {
  path: string;
  chunks: Buffer[];
  bytesTotal: number;
}

type ChunkErrorCode =
  | "TOOL_CALL_GUARD"
  | "MISSING_SENTINEL"
  | "CHUNK_TOO_LARGE"
  | "FILE_TOO_LARGE";

type ChunkOutcome =
  | { kind: "more" }
  | { kind: "end" }
  | { kind: "error"; code: ChunkErrorCode; message: string };

interface UsageInfo {
  input: number;
  output: number;
  thoughts: number;
  ms: number;
  keyIndex: number;
}

interface KeyStat {
  calls: number;
  rate429: number;
  errors: number;
  lastError?: string;
}

interface StepUsage {
  step: number;
  input: number;
  output: number;
  thoughts: number;
  ms: number;
  tool: string;
}

// ---------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------

const usageLog: StepUsage[] = [];
const keyStats: Map<number, KeyStat> = new Map();
const cooldownUntil: Map<number, number> = new Map();

let persistedState: State = {
  keys: { version: 1, updated_at: new Date().toISOString(), keys: {} },
  repos: { version: 1, updated_at: new Date().toISOString(), repos: [] },
};
let metaToken = "";
let stateLoadOk = false;
let stateSaved = false;

function recordKeyCall(keyIndex: number): void {
  const s = keyStats.get(keyIndex) ?? { calls: 0, rate429: 0, errors: 0 };
  s.calls += 1;
  keyStats.set(keyIndex, s);
}

function recordKeyRateLimit(keyIndex: number, message: string): void {
  const s = keyStats.get(keyIndex) ?? { calls: 0, rate429: 0, errors: 0 };
  s.rate429 += 1;
  s.lastError = message.slice(0, 300);
  keyStats.set(keyIndex, s);
}

function recordKeyError(keyIndex: number, message: string): void {
  const s = keyStats.get(keyIndex) ?? { calls: 0, rate429: 0, errors: 0 };
  s.errors += 1;
  s.lastError = message.slice(0, 300);
  keyStats.set(keyIndex, s);
}

// ---------------------------------------------------------------
// Key picker
// ---------------------------------------------------------------

type PickResult =
  | { kind: "ready"; index: number }
  | { kind: "wait"; waitMs: number }
  | { kind: "exhausted" };

function pickKey(keys: KeySpec[], start: number): PickResult {
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length;
    if ((cooldownUntil.get(idx) ?? 0) <= now) {
      return { kind: "ready", index: idx };
    }
  }
  let earliest = Infinity;
  for (const t of cooldownUntil.values()) {
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (!Number.isFinite(earliest)) return { kind: "exhausted" };
  return { kind: "wait", waitMs: Math.max(0, earliest - now) + 500 };
}

// ---------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------

async function asAgent(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(
      "sudo",
      [
        "-u",
        AGENT_USER,
        "env",
        `PATH=${process.env.PATH}`,
        `HOME=${AGENT_HOME}`,
        `XDG_CONFIG_HOME=${AGENT_HOME}/.config`,
        `NPM_CONFIG_CACHE=${AGENT_HOME}/.npm`,
        cmd,
        ...args,
      ],
      {
        cwd: opts.cwd ?? WORKSPACE,
        timeout: opts.timeoutMs ?? 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return normalizeExecError(err);
  }
}

async function asOrchestrator(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return normalizeExecError(err);
  }
}

function normalizeExecError(err: any): ExecResult {
  const stdout = typeof err.stdout === "string" ? err.stdout : "";
  let stderr = typeof err.stderr === "string" ? err.stderr : String(err);
  let code: number;

  if (err.killed) {
    code = 124;
    stderr = stderr || "process killed (timeout)";
  } else if (typeof err.code === "number") {
    code = err.code;
  } else {
    code = 1;
  }

  if (stderr.startsWith("sudo:")) {
    stderr = `sudo failure: ${stderr}`;
  }
  return { stdout, stderr, code };
}

function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

// ---------------------------------------------------------------
// Entry
// ---------------------------------------------------------------

async function main(): Promise<void> {
  const runStarted = Date.now();
  let setupMs = 0;
  let pushMs = 0;

  await fs.mkdir(OMAH_ROOT, { recursive: true, mode: 0o755 });

  const targetRepo = requireEnv("INPUT_REPO");
  const resume = process.env.INPUT_RESUME === "true";

  const appJwt = await signAppJwt(
    requireEnv("APP_ID"),
    requireEnv("APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  );
  const appToken = await mintAppToken(appJwt, targetRepo);
  console.log(`::add-mask::${appToken}`);

  const metaRepo = process.env.OMAH_META_REPO;
  if (metaRepo) {
    try {
      metaToken = await mintAppToken(appJwt, metaRepo);
      console.log(`::add-mask::${metaToken}`);
    } catch (e: any) {
      await log(
        `keystate: no meta token (${e?.message ?? e}); persistence disabled`,
      );
    }
  } else {
    await log("keystate: OMAH_META_REPO not set; persistence disabled");
  }

  if (metaToken) {
    const loaded = await loadState(metaToken, log);
    persistedState = loaded.state;
    stateLoadOk = loaded.ok;
    await log(
      `keystate: loaded ${Object.keys(persistedState.keys.keys).length} keys, ` +
        `${persistedState.repos.repos.length} repos (ok=${stateLoadOk})`,
    );
  }

  // Record this target repo in the state (persisted at save time).
  if (addRepo(persistedState, targetRepo)) {
    await log(`keystate: new target repo "${targetRepo}" will be recorded`);
  }

  const { botId, appSlug } = await resolveAppIdentity(appJwt);
  const botName = `${appSlug}[bot]`;
  const botEmail = `${botId}+${appSlug}[bot]@users.noreply.github.com`;

  const client = githubClient(appToken);
  const repoInfo = await getRepo(client, targetRepo);

  let taskId: string;
  let branchName: string;
  let taskText: string;
  let baseBranch: string;

  if (resume) {
    branchName = requireEnv("INPUT_BRANCH");
    taskId = branchName.split("-").pop() ?? shortId();
    taskText = "";
    baseBranch =
      process.env.INPUT_BASE_BRANCH?.trim() || repoInfo.default_branch;
  } else {
    taskText = requireEnv("INPUT_TASK");
    baseBranch =
      process.env.INPUT_BASE_BRANCH?.trim() || repoInfo.default_branch;
    taskId = shortId();
    const slug = slugify(taskText).slice(0, 40);
    branchName = `omah/${slug}-${taskId}`;
  }

  await log(`task=${taskId} repo=${targetRepo} base=${baseBranch}`);
  await log(`branch=${branchName} resume=${resume}`);
  setOutput("branch", branchName);

  const conversation: Conversation = resume
    ? await loadConversation(targetRepo, branchName, appToken)
    : newConversation(taskId, taskText, targetRepo, baseBranch, branchName);

  if (resume) {
    taskText = conversation.taskText;
    baseBranch = conversation.baseBranch;
  }

  const ignorePatterns = await readIgnorePatternsAtStartup();

  await prepareWorkspaceForAgent(
    targetRepo,
    resume ? branchName : baseBranch,
    baseBranch,
    appToken,
  );

  const repoIgnore = await readRepoIgnorePatterns();
  const mergedPatterns = [...ignorePatterns, ...repoIgnore];

  await applyIgnoreList(mergedPatterns);
  await configureGitIdentityAsAgent(botName, botEmail);

  const { stdout: startShaOut } = await asAgent("git", ["rev-parse", "HEAD"]);
  const startSha = startShaOut.trim();
  await log(`startSha=${startSha}`);

  setupMs = Date.now() - runStarted;

  const systemPrompt = await fs.readFile(SYSTEM_PROMPT_PATH, "utf8");
  let keys = loadKeys();
  const fullKeys = keys;

  const now = Date.now();
  const before = keys.length;
  keys = keys.filter((k) => {
    const fp = fingerprint(k.provider, k.key);
    const entry = persistedState.keys.keys[fp];
    if (!entry) return true;
    if (!entry.reset_at) return true;
    const resetAt = Date.parse(entry.reset_at);
    if (Number.isNaN(resetAt)) return true;
    if (resetAt <= now) return true;
    return false;
  });

  if (keys.length === 0) {
    await log("keystate: all keys marked exhausted; trying anyway");
    keys = fullKeys;
  } else if (keys.length < before) {
    await log(`keystate: skipped ${before - keys.length} exhausted key(s)`);
  }

  await log(
    `loaded ${keys.length} keys: ` +
      keys.map((k, i) => `${i + 1}=${k.provider}`).join(", "),
  );

  const resumeText = process.env.INPUT_RESUME_TEXT?.trim() || "";

  let result: RunLoopResult;
  try {
    result = await runLoop({
      systemPrompt,
      task: taskText,
      resumeText,
      conversation,
      keys,
      targetRepo,
      branchName,
      appToken,
      startSha,
    });
  } finally {
    if (metaToken && stateLoadOk && !stateSaved) {
      stateSaved = true;
      await saveState(persistedState, metaToken, log);
    }
    const llmMs = usageLog.reduce((a, u) => a + u.ms, 0);
    writeRunSummary(
      buildUsageSummary({
        totalMs: Date.now() - runStarted,
        llmMs,
        setupMs,
        pushMs,
        keysTotal: keys.length,
        keySpecs: keys,
      }),
    );
  }

  conversation.finished = true;
  conversation.summary = result.summary;
  conversation.status = result.status;

  await saveConversation(conversation, targetRepo, appToken);

  if (process.env.OMAH_SCRIPT) {
    try {
      await fs.writeFile("/tmp/omah-attack/pkill-ran", "1");
    } catch {}
  }
  await asOrchestrator("sudo", ["pkill", "-9", "-u", AGENT_USER]);

  const pushStart = Date.now();
  const prUrl = await pushPatchAndOpenPR({
    appToken,
    targetRepo,
    baseBranch,
    branchName,
    conversation,
    startSha,
    botName,
    botEmail,
    ignorePatterns: mergedPatterns,
  });
  pushMs = Date.now() - pushStart;

  if (prUrl) {
    setOutput("pr_url", prUrl);
  }
  setOutput("status", result.status);

  await log(`done. pr=${prUrl || "(none)"} status=${result.status}`);
}

// ---------------------------------------------------------------
// The loop
// ---------------------------------------------------------------

interface RunLoopArgs {
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

interface RunLoopResult {
  summary: string;
  status: "done" | "blocked";
}

async function runLoop(args: RunLoopArgs): Promise<RunLoopResult> {
  const startedAt = Date.now();
  const history: Message[] = [];
  let consecutiveErrors = 0;
  let keyIndex = 0;

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
    if (Date.now() - startedAt > WALL_CLOCK_MS) {
      return {
        summary: `Wall-clock budget exceeded after ${args.conversation.steps.length} steps.`,
        status: "blocked",
      };
    }
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      return {
        summary: `Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive tool errors.`,
        status: "blocked",
      };
    }

    const pick = pickKey(args.keys, keyIndex);
    if (pick.kind === "exhausted") {
      return {
        summary: "All LLM keys are exhausted for the day.",
        status: "blocked",
      };
    }
    if (pick.kind === "wait") {
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
    const stepForLog = args.conversation.steps.length + 1;
    try {
      const result = await callModel(
        provider,
        args.systemPrompt,
        history,
        writeState === null,
        keyIndex,
      );
      responseText = result.text;
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
      const kind = classifyError(err);
      const errAny = err as any;

      if (kind === "quota") {
        const ks = args.keys[keyIndex];
        const fp = fingerprint(ks.provider, ks.key);

        if (isPerDayLimit(err)) {
          cooldownUntil.set(keyIndex, Number.POSITIVE_INFINITY);
          persistedState.keys.keys[fp] = {
            status: "exhausted",
            reason: "PerDay",
            reset_at: resetTimeFor(err, ks.provider),
            last_seen: new Date().toISOString(),
          };
          await log(
            `key ${keyIndex + 1} (${ks.provider}) per-day exhausted; persisted`,
          );
        } else {
          const wait = Number(errAny?.retryAfterMs ?? 60_000);
          cooldownUntil.set(keyIndex, Date.now() + wait);
          await log(
            `key ${keyIndex + 1} (${ks.provider}) cooling ${Math.round(wait / 1000)}s (per-minute)`,
          );
        }

        keyIndex = (keyIndex + 1) % args.keys.length;
        continue;
      }

      if (kind === "retryable") {
        const bad = args.keys[keyIndex].provider;
        for (let i = 0; i < args.keys.length; i++) {
          if (args.keys[i].provider === bad) {
            cooldownUntil.set(
              i,
              Date.now() + RETRYABLE_PROVIDER_COOLDOWN_MS,
            );
          }
        }
        await log(
          `provider ${bad} cooling ${Math.round(RETRYABLE_PROVIDER_COOLDOWN_MS / 1000)}s after retryable error`,
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
        await log(
          `provider ${bad} marked dead for this run [${String(errAny?.status ?? "?")}]`,
        );
        keyIndex = (keyIndex + 1) % args.keys.length;
        continue;
      }

      const msg = String(errAny?.message ?? errAny ?? "unknown error").slice(
        0,
        300,
      );
      const statusCode =
        errAny?.status ?? errAny?.code ?? errAny?.response?.status;
      const label = `LLM call failed (status=${statusCode ?? "unknown"})`;
      await log(`blocking: ${label}: ${msg}`);
      return {
        summary: `${label}: ${msg}`,
        status: "blocked",
      };
    }

    if (writeState) {
      const outcome = handleRawChunk(responseText, writeState, writeState.path);

      if (outcome.kind === "error") {
        if (outcome.code === "TOOL_CALL_GUARD") {
          await log(
            `guard: rejected raw write for ${writeState.path} ` +
              `(looks like a tool call)`,
          );
        }
        await log(`write error [${outcome.code}]: ${outcome.message}`);

        history.push({
          role: "model",
          parts: [{ text: "[attempted JSON tool call instead of raw content]" }],
        });
        history.push({
          role: "user",
          parts: [{ text: `Tool result (error):\n${outcome.message}` }],
        });
        args.conversation.steps.push({
          step: args.conversation.steps.length + 1,
          reasoning: pendingWriteReasoning,
          tool: "request_write",
          args: { path: pendingWritePath },
          result: {
            ok: false,
            output: `[${outcome.code}] ${outcome.message}`,
          },
          at: new Date().toISOString(),
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

      args.conversation.steps.push({
        step: stepNo,
        reasoning: pendingWriteReasoning,
        tool: "request_write",
        args: { path: writeState.path },
        result: {
          ok: writeResult.ok,
          output: writeResult.ok
            ? `wrote ${writeState.path} (${contents.length} bytes)`
            : writeResult.output,
        },
        at: new Date().toISOString(),
      });

      history.push({
        role: "model",
        parts: [{ text: `[raw file content for ${writeState.path}]` }],
      });
      history.push({
        role: "user",
        parts: [
          {
            text: writeResult.ok
              ? `Tool result (ok): wrote ${writeState.path} (${contents.length} bytes)`
              : `Tool result (error): ${writeResult.output}`,
          },
        ],
      });

      if (writeResult.ok) consecutiveErrors = 0;
      else consecutiveErrors += 1;

      writeState = null;
      await saveConversation(args.conversation, args.targetRepo, args.appToken);
      continue;
    }

    const parsed = parseModelOutput(responseText);
    if (!parsed) {
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
              "Your previous message did not contain a valid tool call. " +
              "Respond with a single JSON object: " +
              '{"reasoning": "...", "tool": "...", "args": {...}}',
          },
        ],
      });
      continue;
    }

    const step = args.conversation.steps.length + 1;
    await log(`[step ${step}] ${parsed.tool}`);

    if (usageLog.length > 0) {
      const last = usageLog[usageLog.length - 1];
      if (last.tool === "(pending)") last.tool = parsed.tool;
    }

    if (parsed.tool === "finish") {
      const summary = String(parsed.args.summary ?? "");
      const status = parsed.args.status === "blocked" ? "blocked" : "done";
      args.conversation.steps.push({
        step,
        reasoning: parsed.reasoning,
        tool: "finish",
        args: parsed.args,
        result: { ok: true, output: summary },
        at: new Date().toISOString(),
      });
      return { summary, status };
    }

    if (parsed.tool === "request_write") {
      const p = String(parsed.args.path ?? "");
      if (!p) {
        consecutiveErrors += 1;
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
        safePath(p);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        consecutiveErrors += 1;
        history.push({ role: "model", parts: [{ text: responseText }] });
        history.push({
          role: "user",
          parts: [{ text: `Tool result (error): ${msg}` }],
        });
        args.conversation.steps.push({
          step: args.conversation.steps.length + 1,
          reasoning: parsed.reasoning,
          tool: "request_write",
          args: { path: p },
          result: { ok: false, output: msg },
          at: new Date().toISOString(),
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

    const result = await runTool(parsed.tool, parsed.args).catch((e) => ({
      ok: false,
      output: String(e?.message ?? e),
    }));

    args.conversation.steps.push({
      step,
      reasoning: parsed.reasoning,
      tool: parsed.tool,
      args: parsed.args,
      result: {
        ok: result.ok,
        output: truncate(result.output, 2000),
        truncated: result.output.length > 2000,
      },
      at: new Date().toISOString(),
    });

    history.push({ role: "model", parts: [{ text: responseText }] });
    history.push({
      role: "user",
      parts: [
        {
          text: `Tool result (${result.ok ? "ok" : "error"}):\n${truncate(
            result.output,
            4000,
          )}`,
        },
      ],
    });

    if (result.ok) consecutiveErrors = 0;
    else consecutiveErrors += 1;

    await saveConversation(args.conversation, args.targetRepo, args.appToken);
  }
}

// ---------------------------------------------------------------
// Raw-write chunk handling
// ---------------------------------------------------------------

function handleRawChunk(
  raw: string,
  state: WriteState,
  filePath: string,
): ChunkOutcome {
  if (looksLikeToolCall(raw)) {
    return {
      kind: "error",
      code: "TOOL_CALL_GUARD",
      message:
        "Expected raw file contents, got a JSON tool call. " +
        "Call request_write again, then send the raw contents.",
    };
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const last = lines.length ? lines[lines.length - 1].trim() : "";

  let isMore = false;
  if (last === SENTINEL_MORE) {
    isMore = true;
  } else if (last !== SENTINEL_END) {
    return {
      kind: "error",
      code: "MISSING_SENTINEL",
      message:
        `Missing ${SENTINEL_END} line, nothing was written ` +
        `(the reply may have been cut off). Call request_write again ` +
        `and send the file in chunks of ~250 lines.`,
    };
  }
  lines.pop();

  if (
    !/\.mdx?$/i.test(filePath) &&
    lines.length >= 2 &&
    /^```/.test(lines[0].trim()) &&
    lines[lines.length - 1].trim() === "```"
  ) {
    lines.shift();
    lines.pop();
  }

  const body = lines.length ? lines.join("\n") + "\n" : "";
  const buf = Buffer.from(body, "utf8");

  if (buf.length > MAX_CHUNK_BYTES) {
    return {
      kind: "error",
      code: "CHUNK_TOO_LARGE",
      message: `chunk too large (${buf.length} bytes). Split it.`,
    };
  }
  if (state.bytesTotal + buf.length > MAX_FILE_BYTES) {
    return {
      kind: "error",
      code: "FILE_TOO_LARGE",
      message: "file too large. Finish as blocked.",
    };
  }

  state.chunks.push(buf);
  state.bytesTotal += buf.length;
  return isMore ? { kind: "more" } : { kind: "end" };
}

function looksLikeToolCall(raw: string): boolean {
  const parsed = parseModelOutput(raw);
  if (!parsed) return false;
  return TOOL_NAMES.has(parsed.tool);
}

async function writeAsAgentBytes(
  destPath: string,
  contents: Buffer,
): Promise<{ ok: boolean; output: string }> {
  const full = safePath(destPath);
  await asAgent("mkdir", ["-p", path.dirname(full)]);

  return new Promise((resolve) => {
    const child = spawn("sudo", ["-u", AGENT_USER, "tee", full], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ ok: false, output: `tee error: ${err.message}` }),
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output: `wrote ${full}` });
      else resolve({ ok: false, output: `tee exit ${code}: ${stderr}` });
    });
    child.stdin.end(contents);
  });
}

// ---------------------------------------------------------------
// Tools
// ---------------------------------------------------------------

async function runTool(
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  switch (tool) {
    case "read_file": {
      const p = safePath(String(args.path));
      const { stdout, stderr, code } = await asAgent("cat", [p]);
      if (code !== 0) return { ok: false, output: stderr };
      return { ok: true, output: stdout };
    }
    case "run_bash": {
      const cmd = String(args.command ?? "");
      if (!cmd) return { ok: false, output: "empty command" };
      const result = await runBashWithDetach(cmd);
      if (
        result.code === 124 ||
        result.code === 126 ||
        result.code === 127 ||
        result.stderr.startsWith("sudo failure:")
      ) {
        return {
          ok: false,
          output: `tool failure (exit ${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        };
      }
      return {
        ok: true,
        output: `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      };
    }
    case "git_commit": {
      const msg = String(args.message ?? "omah: changes");
      await asAgent("git", ["add", "-A"]);
      const { stdout, stderr, code } = await asAgent("git", [
        "commit",
        "-m",
        msg,
      ]);
      if (code !== 0) return { ok: false, output: stderr };
      return { ok: true, output: stdout };
    }
    default:
      return { ok: false, output: `unknown tool: ${tool}` };
  }
}

async function runBashWithDetach(
  cmd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      "sudo",
      [
        "-u",
        AGENT_USER,
        "env",
        `PATH=${process.env.PATH}`,
        `HOME=${AGENT_HOME}`,
        `XDG_CONFIG_HOME=${AGENT_HOME}/.config`,
        `NPM_CONFIG_CACHE=${AGENT_HOME}/.npm`,
        "bash",
        "-c",
        cmd,
      ],
      { cwd: WORKSPACE, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };

    const timer = setTimeout(async () => {
      child.kill("SIGKILL");
      await asOrchestrator("sudo", ["pkill", "-9", "-u", AGENT_USER]);
      done(124);
    }, 5 * 60 * 1000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_BASH_OUT) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_BASH_OUT) stderr += d.toString();
    });

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      done(1);
    });

    child.on("exit", (code, sig) => {
      const finalCode = code ?? (sig ? 137 : 1);
      setTimeout(() => done(finalCode), 300);
    });
  });
}

// ---------------------------------------------------------------
// Ignore list
// ---------------------------------------------------------------

async function readIgnorePatternsAtStartup(): Promise<string[]> {
  const out: string[] = [];
  try {
    const raw = await fs.readFile(IGNORE_FILE_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      out.push(trimmed);
    }
  } catch {}
  return out;
}

async function readRepoIgnorePatterns(): Promise<string[]> {
  const out: string[] = [];
  const p = path.join(WORKSPACE, ".omahignore");
  try {
    const raw = await fs.readFile(p, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      out.push(trimmed);
    }
  } catch {}
  return out;
}

async function applyIgnoreList(patterns: string[]): Promise<void> {
  if (patterns.length === 0) return;
  const ig = ignore().add(patterns);
  const { stdout: trackedOut } = await asAgent("git", ["ls-files", "-z"]);
  const tracked = new Set(trackedOut.split("\0").filter(Boolean));
  const toSkipWorktree: string[] = [];
  for (const rel of tracked) {
    if (ig.ignores(rel)) {
      toSkipWorktree.push(rel);
      await asAgent("rm", ["-f", path.join(WORKSPACE, rel)]);
      await log(`ignore: removed ${rel}`);
    }
  }
  if (toSkipWorktree.length > 0) {
    await asAgent("git", [
      "update-index",
      "--skip-worktree",
      ...toSkipWorktree,
    ]);
  }
}

// ---------------------------------------------------------------
// Workspace preparation
// ---------------------------------------------------------------

async function prepareWorkspaceForAgent(
  targetRepo: string,
  branch: string,
  fallbackBranch: string,
  token: string,
): Promise<void> {
  await fs.rm(WORKSPACE, { recursive: true, force: true });
  await fs.mkdir(WORKSPACE, { recursive: true });

  const env = gitAuthEnv(token);
  const url = `https://github.com/${targetRepo}.git`;

  let cloneResult = await asOrchestrator(
    "git",
    ["clone", "--depth", "50", "--branch", branch, url, "."],
    { cwd: WORKSPACE, env },
  );

  if (cloneResult.code !== 0 && branch !== fallbackBranch) {
    await log(`branch ${branch} not found; falling back to ${fallbackBranch}`);
    await fs.rm(WORKSPACE, { recursive: true, force: true });
    await fs.mkdir(WORKSPACE, { recursive: true });
    cloneResult = await asOrchestrator(
      "git",
      ["clone", "--depth", "50", "--branch", fallbackBranch, url, "."],
      { cwd: WORKSPACE, env },
    );
    if (cloneResult.code === 0) {
      await asOrchestrator("git", ["checkout", "-b", branch], {
        cwd: WORKSPACE,
      });
    }
  }

  if (cloneResult.code !== 0) {
    throw new Error(`clone failed: ${cloneResult.stderr}`);
  }

  await asOrchestrator("sudo", [
    "chown",
    "-R",
    `${AGENT_USER}:${AGENT_USER}`,
    WORKSPACE,
  ]);
  await asOrchestrator("sudo", [
    "git",
    "config",
    "--system",
    "safe.directory",
    WORKSPACE,
  ]);
}

async function configureGitIdentityAsAgent(
  name: string,
  email: string,
): Promise<void> {
  await asAgent("git", ["config", "user.name", name]);
  await asAgent("git", ["config", "user.email", email]);
}

function safePath(input: string): string {
  const cleaned = input.replace(/^\/+/, "");
  const full = path.resolve(WORKSPACE, cleaned);
  if (!full.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${input}`);
  }
  return full;
}

// ---------------------------------------------------------------
// Patch generation, application, and push
// ---------------------------------------------------------------

interface PushArgs {
  appToken: string;
  targetRepo: string;
  baseBranch: string;
  branchName: string;
  conversation: Conversation;
  startSha: string;
  botName: string;
  botEmail: string;
  ignorePatterns: string[];
}

async function pushPatchAndOpenPR(args: PushArgs): Promise<string> {
  await asAgent("git", ["add", "-A"]);

  const patchResult = await asAgentBuffer("git", [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    args.startSha,
    "--",
  ]);
  if (patchResult.code !== 0) {
    throw new Error(`diff failed: ${patchResult.stderr}`);
  }
  const patch = patchResult.stdout;

  if (patch.byteLength > MAX_PATCH_BYTES) {
    return await failStep(
      args.conversation,
      args.targetRepo,
      args.branchName,
      `patch too large (${patch.byteLength} bytes)`,
    );
  }

  if (patch.byteLength === 0) {
    await log("no changes; skipping push");
    return await writeStepSummary(
      args.conversation,
      args.targetRepo,
      args.branchName,
      "no changes",
    );
  }

  const { stdout: namesOut } = await asAgent("git", [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    args.startSha,
    "--",
  ]);
  const names = namesOut.split("\0").filter(Boolean);

  const ig = ignore().add(args.ignorePatterns);
  for (const name of names) {
    if (name.startsWith(".git/") || name === ".git") {
      return await failStep(
        args.conversation,
        args.targetRepo,
        args.branchName,
        `forbidden path: ${name}`,
      );
    }
    if (name.startsWith(".github/") || name === ".github") {
      return await failStep(
        args.conversation,
        args.targetRepo,
        args.branchName,
        `forbidden path: ${name}`,
      );
    }
    if (ig.ignores(name)) {
      return await failStep(
        args.conversation,
        args.targetRepo,
        args.branchName,
        `ignored path in patch: ${name}`,
      );
    }
  }

  const { stdout: rawOut } = await asAgent("git", [
    "diff",
    "--cached",
    "-r",
    "--raw",
    "--no-renames",
    args.startSha,
    "--",
  ]);
  for (const line of rawOut.split("\n")) {
    const m = line.match(/^:(\d{6}) (\d{6}) /);
    if (m && (m[1] === "160000" || m[2] === "160000")) {
      return await failStep(
        args.conversation,
        args.targetRepo,
        args.branchName,
        "submodule changes not supported",
      );
    }
  }

  const pushClone = await fs.mkdtemp(path.join(OMAH_ROOT, "push-"));
  const cloneEnv = gitAuthEnv(args.appToken);
  const url = `https://github.com/${args.targetRepo}.git`;

  let r = await asOrchestrator("git", ["init"], { cwd: pushClone });
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);

  r = await asOrchestrator("git", ["remote", "add", "origin", url], {
    cwd: pushClone,
  });
  if (r.code !== 0) throw new Error(`remote add failed: ${r.stderr}`);

  r = await asOrchestrator(
    "git",
    ["fetch", "--depth", "1", "origin", args.startSha],
    { cwd: pushClone, env: cloneEnv },
  );
  if (r.code !== 0) throw new Error(`fetch failed: ${r.stderr}`);

  r = await asOrchestrator("git", ["checkout", args.startSha], {
    cwd: pushClone,
  });
  if (r.code !== 0) throw new Error(`checkout failed: ${r.stderr}`);

  r = await asOrchestrator("git", ["checkout", "-b", args.branchName], {
    cwd: pushClone,
  });
  if (r.code !== 0) throw new Error(`checkout -b failed: ${r.stderr}`);

  const tmpPatch = path.join(pushClone, "omah-patch.diff");
  await fs.writeFile(tmpPatch, patch);
  const applyResult = await asOrchestrator(
    "git",
    ["apply", "--index", tmpPatch],
    { cwd: pushClone },
  );
  await fs.rm(tmpPatch, { force: true });

  if (applyResult.code !== 0) {
    await fs.rm(pushClone, { recursive: true, force: true });
    return await failStep(
      args.conversation,
      args.targetRepo,
      args.branchName,
      `patch failed to apply: ${applyResult.stderr}`,
    );
  }

  const commitMsg = args.conversation.summary ?? "omah: changes";
  const commitResult = await asOrchestrator(
    "git",
    [
      "-c",
      `user.name=${args.botName}`,
      "-c",
      `user.email=${args.botEmail}`,
      "commit",
      "-m",
      commitMsg,
    ],
    { cwd: pushClone },
  );
  if (commitResult.code !== 0) {
    throw new Error(`commit failed: ${commitResult.stderr}`);
  }

  const pushResult = await asOrchestrator(
    "git",
    ["push", "-u", "origin", `HEAD:refs/heads/${args.branchName}`],
    { cwd: pushClone, env: cloneEnv },
  );
  if (pushResult.code !== 0) {
    throw new Error(`push failed: ${pushResult.stderr}`);
  }

  const client = githubClient(args.appToken);
  const [owner, repo] = args.targetRepo.split("/");

  const existing: any[] = await client(
    "GET",
    `/repos/${owner}/${repo}/pulls?head=${owner}:${args.branchName}&state=open`,
  );

  let prUrl: string;
  let prNodeId: string | null = null;
  let prIsDraft = false;

  if (existing.length > 0) {
    const pr = existing[0];
    prNodeId = pr.node_id;
    prIsDraft = Boolean(pr.draft);
    await client("PATCH", `/repos/${owner}/${repo}/pulls/${pr.number}`, {
      title: titleFor(args.conversation),
      body: bodyFor(args.conversation),
    });
    prUrl = pr.html_url;
  } else {
    const created: any = await client("POST", `/repos/${owner}/${repo}/pulls`, {
      title: titleFor(args.conversation),
      head: args.branchName,
      base: args.baseBranch,
      body: bodyFor(args.conversation),
      draft: args.conversation.status === "blocked",
    });
    prUrl = created.html_url;
    prNodeId = created.node_id;
    prIsDraft = Boolean(created.draft);
  }

  if (args.conversation.status === "done" && prNodeId && prIsDraft) {
    await markReadyForReview(args.appToken, prNodeId);
  }

  await fs.rm(pushClone, { recursive: true, force: true });
  return prUrl;
}

async function asAgentBuffer(
  cmd: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let killed = false;

    const child = spawn(
      "sudo",
      [
        "-u",
        AGENT_USER,
        "env",
        `PATH=${process.env.PATH}`,
        `HOME=${AGENT_HOME}`,
        `XDG_CONFIG_HOME=${AGENT_HOME}/.config`,
        `NPM_CONFIG_CACHE=${AGENT_HOME}/.npm`,
        cmd,
        ...args,
      ],
      { cwd: WORKSPACE },
    );

    child.stdout.on("data", (d: Buffer) => {
      total += d.length;
      if (total > MAX_PATCH_BYTES) {
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(d);
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ stdout: Buffer.alloc(0), stderr: err.message, code: 1 }),
    );
    child.on("close", (code) => {
      if (killed) {
        resolve({
          stdout: Buffer.concat(chunks),
          stderr: stderr + "\n(killed: output exceeded cap)",
          code: 124,
        });
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? 1 });
    });
  });
}

async function markReadyForReview(
  token: string,
  nodeId: string,
): Promise<void> {
  const query = `
    mutation {
      markPullRequestReadyForReview(input: { pullRequestId: "${nodeId}" }) {
        pullRequest { isDraft }
      }
    }
  `;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    await log(
      `markReadyForReview: non-JSON response (${res.status}): ${text.slice(0, 200)}`,
    );
    return;
  }
  if (json.errors) {
    await log(
      `markReadyForReview failed: ${JSON.stringify(json.errors).slice(0, 200)}`,
    );
    return;
  }
  if (json?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft) {
    await log("PR is still a draft after mutation");
  } else {
    await log("PR marked ready for review");
  }
}

async function failStep(
  c: Conversation,
  repo: string,
  branch: string,
  reason: string,
): Promise<string> {
  const summary = [
    `## Omah — failed to push`,
    ``,
    `**Repo:** ${repo}`,
    `**Branch:** ${branch}`,
    `**Reason:** ${reason}`,
    `**Task:** ${c.taskText}`,
    ``,
    `_No PR was created. This run exits non-zero; check the log._`,
  ].join("\n");
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, summary + "\n");
  process.exitCode = 1;
  return "";
}

async function writeStepSummary(
  c: Conversation,
  repo: string,
  branch: string,
  reason: string,
): Promise<string> {
  const summary = [
    `## Omah — no PR (benign)`,
    ``,
    `**Repo:** ${repo}`,
    `**Branch:** ${branch}`,
    `**Reason:** ${reason}`,
    `**Task:** ${c.taskText}`,
    ``,
    `_No changes were pushed._`,
  ].join("\n");
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, summary + "\n");
  return "";
}

function titleFor(c: Conversation): string {
  const title =
    c.status === "blocked"
      ? `[Omah] Blocked: ${c.summary ?? "needs input"}`
      : `[Omah] ${c.summary ?? "changes"}`;
  return title.slice(0, 250);
}

function sanitize(s: string): string {
  return s.replace(/```/g, "`\u200B``").replace(/@/g, "@\u200B");
}

function bodyFor(c: Conversation): string {
  const MAX_STEPS = 200;
  const stepsToShow = c.steps.slice(0, MAX_STEPS);
  const omitted = c.steps.length - stepsToShow.length;

  const stepLines = stepsToShow.map((s) => {
    const argsJson = sanitize(JSON.stringify(s.args).slice(0, 200));
    const out = sanitize(s.result.output.slice(0, 200).replace(/\n/g, " "));
    const reasoning = sanitize(s.reasoning || "(no reasoning)");
    return `${s.step}. 💭 ${reasoning}\n   🔧 ${s.tool}(${argsJson})\n   ${
      s.result.ok ? "✅" : "❌"
    } ${out}`;
  });

  const omittedLine = omitted > 0 ? `\n\n… ${omitted} more steps omitted.` : "";

  const body = [
    `## Task`,
    ``,
    `> ${sanitize(c.taskText)}`,
    ``,
    `## Summary`,
    ``,
    sanitize(c.summary ?? "(none)"),
    ``,
    `## Decision log`,
    ``,
    `<details>`,
    `<summary>${c.steps.length} steps</summary>`,
    ``,
    "```",
    stepLines.join("\n\n") + omittedLine,
    "```",
    `</details>`,
    ``,
    `---`,
    `_Generated by Omah._`,
  ].join("\n");

  if (body.length > MAX_PR_BODY_CHARS) {
    return (
      body.slice(0, MAX_PR_BODY_CHARS - 100) +
      "\n\n_[truncated — body exceeded size limit]_"
    );
  }
  return body;
}

// ---------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------

function newConversation(
  taskId: string,
  taskText: string,
  targetRepo: string,
  baseBranch: string,
  branchName: string,
): Conversation {
  return {
    version: 1,
    taskId,
    taskText,
    targetRepo,
    baseBranch,
    branchName,
    steps: [],
    finished: false,
    startedAt: new Date().toISOString(),
  };
}

async function saveConversation(
  c: Conversation,
  targetRepo: string,
  token: string,
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-state-"));
  try {
    let r = await asOrchestrator("git", ["init"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`state init failed: ${r.stderr}`);

    r = await asOrchestrator(
      "git",
      ["remote", "add", "origin", `https://github.com/${targetRepo}.git`],
      { cwd: tmp },
    );
    if (r.code !== 0) throw new Error(`state remote add failed: ${r.stderr}`);

    const stateBranch = `omah-state/${c.branchName.replace(/\//g, "-")}`;
    r = await asOrchestrator("git", ["checkout", "--orphan", stateBranch], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`state checkout failed: ${r.stderr}`);

    await fs.writeFile(
      path.join(tmp, "conversation.json"),
      JSON.stringify(c, null, 2),
    );
    r = await asOrchestrator("git", ["add", "conversation.json"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`state add failed: ${r.stderr}`);

    r = await asOrchestrator(
      "git",
      [
        "-c",
        "user.name=omah[bot]",
        "-c",
        "user.email=omah[bot]@users.noreply.github.com",
        "commit",
        "-m",
        "omah: state",
      ],
      { cwd: tmp },
    );
    if (r.code !== 0 && !r.stdout.includes("nothing to commit")) {
      await log(`state commit warning: ${r.stderr}`);
    }

    r = await asOrchestrator(
      "git",
      ["push", "-f", "origin", `HEAD:refs/heads/${stateBranch}`],
      { cwd: tmp, env: gitAuthEnv(token) },
    );
    if (r.code !== 0) throw new Error(`state push failed: ${r.stderr}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function loadConversation(
  targetRepo: string,
  branchName: string,
  token: string,
): Promise<Conversation> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-load-"));
  try {
    const stateBranch = `omah-state/${branchName.replace(/\//g, "-")}`;
    const r = await asOrchestrator(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        stateBranch,
        `https://github.com/${targetRepo}.git`,
        ".",
      ],
      { cwd: tmp, env: gitAuthEnv(token) },
    );
    if (r.code !== 0) {
      throw new Error(`could not load conversation: ${r.stderr}`);
    }
    const raw = await fs.readFile(path.join(tmp, "conversation.json"), "utf8");
    return JSON.parse(raw) as Conversation;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------
// LLM (delegated to src/llm.ts)
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

async function callModel(
  provider: LLMProvider,
  systemPrompt: string,
  history: Message[],
  jsonMode: boolean,
  keyIndex: number,
): Promise<{ text: string; usage: UsageInfo; note?: string }> {
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
    await log(
      `OMAH_SCRIPT: returning response ${scriptedIndex}/${scriptedResponses.length}`,
    );
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
        { systemPrompt, history: llmHistory, jsonMode },
        keyIndex,
      );
      recordKeyCall(keyIndex);
      return {
        text: result.text,
        usage: result.usage,
        note: result.note,
      };
    } catch (err: any) {
      lastErr = err;
      const kind = classifyError(err);

      if (kind === "quota") {
        const s = keyStats.get(keyIndex);
        if (!s || s.rate429 === 0) {
          await log(
            `key ${keyIndex + 1} 429 (full message): ${String(err?.message ?? err)}`,
          );
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
        await log(
          `key ${keyIndex + 1} json validation failure; not retrying`,
        );
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
// Usage summary
// ---------------------------------------------------------------

function buildUsageSummary(args: {
  totalMs: number;
  llmMs: number;
  setupMs: number;
  pushMs: number;
  keysTotal: number;
  keySpecs: KeySpec[];
}): string {
  const steps = usageLog.length;
  const sumIn = usageLog.reduce((a, u) => a + u.input, 0);
  const sumOut = usageLog.reduce((a, u) => a + u.output, 0);
  const sumThoughts = usageLog.reduce((a, u) => a + u.thoughts, 0);

  const lines: string[] = [];
  lines.push("## Omah run diagnostics");
  lines.push("");
  lines.push(`- Steps: ${steps}`);
  lines.push(`- LLM calls: ${steps}`);
  lines.push(
    `- Tokens: input=${sumIn.toLocaleString()} output=${sumOut.toLocaleString()}` +
      (sumThoughts ? ` thoughts=${sumThoughts.toLocaleString()}` : ""),
  );
  lines.push(
    `- Wall time: total=${Math.round(args.totalMs / 1000)}s ` +
      `llm=${Math.round(args.llmMs / 1000)}s ` +
      `setup=${Math.round(args.setupMs / 1000)}s ` +
      `push=${Math.round(args.pushMs / 1000)}s`,
  );
  const toolMs = args.totalMs - args.llmMs - args.setupMs - args.pushMs;
  lines.push(`- Tool time: ${Math.round(toolMs / 1000)}s`);

  lines.push("");
  lines.push("### Per key");
  lines.push("");
  lines.push("| key | provider | calls | 429 | errors | last error |");
  lines.push("|---|---|---|---|---|---|");
  for (let i = 0; i < args.keysTotal; i++) {
    const s = keyStats.get(i) ?? { calls: 0, rate429: 0, errors: 0 };
    const spec = args.keySpecs[i];
    const provider = spec?.provider ?? "?";
    const err = s.lastError
      ? s.lastError.replace(/\|/g, "\\|").slice(0, 100)
      : "";
    lines.push(
      `| ${i + 1} | ${provider} | ${s.calls} | ${s.rate429} | ${s.errors} | ${err} |`,
    );
  }

  lines.push("");
  lines.push("### Input tokens per step");
  lines.push("");
  lines.push("| step | tool | input | output | thoughts | ms |");
  lines.push("|---|---|---|---|---|---|");
  for (const u of usageLog) {
    lines.push(
      `| ${u.step} | ${u.tool} | ${u.input} | ${u.output} | ${u.thoughts || ""} | ${u.ms} |`,
    );
  }

  return lines.join("\n");
}

function writeRunSummary(text: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, text + "\n");
  } catch {}
}

// ---------------------------------------------------------------
// Model output parsing
// ---------------------------------------------------------------

interface ParsedOutput {
  reasoning: string;
  tool: ToolName;
  args: Record<string, unknown>;
}

function parseModelOutput(text: string): ParsedOutput | null {
  let raw = text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const direct = tryParse(raw);
  if (direct) return direct;

  return extractToolCall(raw);
}

function extractToolCall(text: string): ParsedOutput | null {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") starts.push(i);
  }
  for (let k = starts.length - 1; k >= 0; k--) {
    const end = matchBrace(text, starts[k]);
    if (end === -1) continue;
    const p = tryParse(text.slice(starts[k], end + 1));
    if (p) return p;
  }
  return null;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function tryParse(s: string): ParsedOutput | null {
  try {
    const obj = JSON.parse(s);
    if (typeof obj?.tool !== "string") return null;

    // Standard: { reasoning, tool, args }
    if (typeof obj?.args === "object" && obj.args !== null) {
      return {
        reasoning: String(obj.reasoning ?? ""),
        tool: obj.tool as ToolName,
        args: obj.args as Record<string, unknown>,
      };
    }

    // Poolside-flat: { reasoning, tool, command } or similar.
    // Everything except reasoning and tool becomes args.
    const { reasoning, tool, ...rest } = obj;
    if (Object.keys(rest).length === 0) return null;
    return {
      reasoning: String(reasoning ?? ""),
      tool: tool as ToolName,
      args: rest,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------

async function signAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(privateKeyPem, "base64url");
  return `${unsigned}.${sig}`;
}

async function mintAppToken(jwt: string, targetRepo: string): Promise<string> {
  const [owner, repo] = targetRepo.split("/");
  const instRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!instRes.ok) {
    throw new Error(
      `could not find installation for ${targetRepo}: ${instRes.status}`,
    );
  }
  const inst: any = await instRes.json();

  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${inst.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`could not mint token: ${tokenRes.status} ${text}`);
  }
  const token: any = await tokenRes.json();
  return token.token;
}

async function resolveAppIdentity(
  jwt: string,
): Promise<{ botId: string; appSlug: string }> {
  const res = await fetch("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`could not fetch app info: ${res.status}`);
  const info: any = await res.json();
  const appSlug: string = info.slug;

  const botId = process.env.APP_BOT_ID;
  if (!botId) {
    throw new Error(
      "APP_BOT_ID is required. Set the OMAH_APP_BOT_ID repository variable.",
    );
  }
  return { botId, appSlug };
}

function githubClient(token: string) {
  return async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`https://api.github.com${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`github ${method} ${urlPath}: ${res.status} ${text}`);
    }
    return res.status === 204 ? null : res.json();
  };
}

async function getRepo(client: any, fullName: string) {
  return client("GET", `/repos/${fullName}`);
}

// ---------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function loadKeys(): KeySpec[] {
  const specs = loadAllKeys(async (msg) => {
    await log(msg);
  });
  for (const k of specs) {
    console.log(`::add-mask::${k.key}`);
  }

  const preferred = (process.env.INPUT_PROVIDER || "default")
    .trim()
    .toLowerCase();
  if (preferred && preferred !== "default") {
    const first = specs.filter((k) => k.provider === preferred);
    const rest = specs.filter((k) => k.provider !== preferred);
    if (first.length === 0) {
      console.warn(
        `[omah] preference "${preferred}" matched no keys; using default order`,
      );
      return specs;
    }
    return [...first, ...rest];
  }
  return specs;
}

function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${key}=${value}\n`);
  } else {
    console.log(`::set-output name=${key}::${value}`);
  }
}

async function log(msg: string): Promise<void> {
  console.log(`[omah] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n
    ? s
    : s.slice(0, n) + `\n… [truncated ${s.length - n} chars]`;
}

function shortId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

// ---------------------------------------------------------------

main().catch(async (err) => {
  console.error("[omah] fatal:", err);
  if (metaToken && stateLoadOk && !stateSaved) {
    stateSaved = true;
    try {
      await saveState(persistedState, metaToken, log);
    } catch {}
  }
  process.exit(1);
});