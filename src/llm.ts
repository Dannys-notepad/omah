// llm.ts
// Provider abstraction for the Omah agent loop.

import { GoogleGenAI } from "@google/genai";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  systemPrompt: string;
  history: LLMMessage[];
  jsonMode: boolean;
}

export interface UsageInfo {
  input: number;
  output: number;
  thoughts: number;
  ms: number;
  keyIndex: number;
}

export interface LLMResponse {
  text: string;
  usage: UsageInfo;
  /** Optional diagnostic note from the provider (not shown to the model). */
  note?: string;
}

export interface LLMProvider {
  complete(req: LLMRequest, keyIndex: number): Promise<LLMResponse>;
}

export type LLMErrorKind = "quota" | "rotate" | "retryable" | "fatal";

export interface ProviderSpec {
  name: string;
  envVar: string;
  model: string;
  baseURL: string | null;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    name: "gemini",
    envVar: "GEMINI_KEYS",
    model: "gemini-3.5-flash",
    baseURL: null,
  },
  {
    name: "groq",
    envVar: "GROQ_KEYS",
    model: "openai/gpt-oss-120b",
    baseURL: "https://api.groq.com/openai/v1",
  },
  /*{
    name: "requesty",
    envVar: "REQUESTY_KEYS",
    model: "mistral/leanstral-1-5",
    baseURL: "https://router.requesty.ai/v1",
  },*/
  {
  name: "requesty",
  envVar: "REQUESTY_KEYS",
  model: "google/gemma-4-31b-it",
  baseURL: "https://router.requesty.ai/v1",
},
  {
    name: "mistral",
    envVar: "MISTRAL_KEYS",
    model: "mistral-medium-3.5",
    baseURL: "https://api.mistral.ai/v1",
  },
  {
    name: "nvidia",
    envVar: "NVIDIA_KEYS",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    baseURL: "https://integrate.api.nvidia.com/v1",
  },
];

export interface KeySpec {
  provider: string;
  model: string;
  baseURL: string | null;
  key: string;
}

export function loadAllKeys(
  log?: (msg: string) => Promise<void>,
): KeySpec[] {
  const disabled = new Set(
    (process.env.OMAH_DISABLED_PROVIDERS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const out: KeySpec[] = [];
  for (const spec of PROVIDERS) {
    if (disabled.has(spec.name)) {
      if (log) void log(`provider ${spec.name}: disabled`);
      continue;
    }
    const raw = process.env[spec.envVar];
    if (!raw) {
      if (log) void log(`provider ${spec.name}: no ${spec.envVar} set, skipping`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (log) void log(`provider ${spec.name}: ${spec.envVar} is not valid JSON`);
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      if (log)
        void log(`provider ${spec.name}: ${spec.envVar} is not a non-empty array`);
      continue;
    }
    for (const k of parsed) {
      if (typeof k !== "string" || !k) continue;
      out.push({
        provider: spec.name,
        model: spec.model,
        baseURL: spec.baseURL,
        key: k,
      });
    }
  }
  if (out.length === 0) {
    throw new Error(
      "no LLM keys loaded — set at least one of " +
        PROVIDERS.map((p) => p.envVar).join(", "),
    );
  }
  return out;
}

const MAX_OUTPUT_TOKENS = 16384;
const FETCH_TIMEOUT_MS = 120_000;

export class GeminiProvider implements LLMProvider {
  constructor(private key: string, private model: string) {}

  async complete(req: LLMRequest, keyIndex: number): Promise<LLMResponse> {
    const ai = new GoogleGenAI({ apiKey: this.key });
    const started = Date.now();
    const response = await ai.models.generateContent({
      model: this.model,
      contents: req.history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: req.systemPrompt,
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    });
    const elapsed = Date.now() - started;

    const um: any = (response as any).usageMetadata ?? {};
    const rawText = response.text ?? "";
    return {
      text: stripLeadingThinking(rawText),
      usage: {
        input: Number(um.promptTokenCount ?? 0),
        output: Number(um.candidatesTokenCount ?? 0),
        thoughts: Number(um.thoughtsTokenCount ?? 0),
        ms: elapsed,
        keyIndex,
      },
    };
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private baseURL: string,
    private model: string,
    private key: string,
  ) {}

  async complete(req: LLMRequest, keyIndex: number): Promise<LLMResponse> {
    const started = Date.now();
    const messages = [
      { role: "system", content: req.systemPrompt },
      ...req.history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // Note: no response_format. Some OpenAI-compatible endpoints inject
    // their own JSON-mode instructions into the prompt, which produces
    // empty or malformed output with reasoning models. The parser in
    // agent.ts strips code fences and handles plain text.
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new Error(`fetch failed: ${err?.message ?? err}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw makeHttpError(res.status, text, res.headers);
    }

    const json: any = await res.json();
const elapsed = Date.now() - started;
const choice = json?.choices?.[0];
const message = choice?.message ?? {};
const finish = choice?.finish_reason;

let rawText = String(message.content ?? "");
// Some OpenAI-compatible providers (notably Groq with gpt-oss models)
// return the useful text in `reasoning` and leave `content` empty.
// Only use reasoning on JSON-mode turns — never on raw file writes,
// where reasoning text would corrupt the file — and never when the
// reply was cut off.
if (
  !rawText.trim() &&
  req.jsonMode &&
  finish !== "length" &&
  message.reasoning
) {
  rawText = String(message.reasoning);
}

const usage = json?.usage ?? {};

    return {
      text: stripLeadingThinking(rawText),
      usage: {
        input: Number(usage.prompt_tokens ?? 0),
        output: Number(usage.completion_tokens ?? 0),
        thoughts: Number(
          usage.completion_tokens_details?.reasoning_tokens ?? 0,
        ),
        ms: elapsed,
        keyIndex,
      },
      //note,
    };
  }
}

export function makeProvider(spec: KeySpec): LLMProvider {
  if (spec.provider === "gemini" || spec.baseURL === null) {
    return new GeminiProvider(spec.key, spec.model);
  }
  return new OpenAICompatibleProvider(spec.baseURL, spec.model, spec.key);
}

interface LLMHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

function makeHttpError(
  status: number,
  body: string,
  headers?: Headers,
): LLMHttpError {
  const err = new Error(
    `HTTP ${status}: ${body.slice(0, 400)}`,
  ) as LLMHttpError;
  err.status = status;

  if (headers) {
    const ra = headers.get("retry-after");
    if (ra) {
      const seconds = Number(ra);
      if (!Number.isNaN(seconds)) err.retryAfterMs = seconds * 1000;
      else {
        const date = Date.parse(ra);
        if (!Number.isNaN(date))
          err.retryAfterMs = Math.max(0, date - Date.now());
      }
    }
  }
  if (!err.retryAfterMs) {
    const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
    if (m) err.retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
  }
  if (!err.retryAfterMs) {
    const m = body.match(/"retry_after"\s*:\s*(\d+)/i);
    if (m) err.retryAfterMs = Number(m[1]) * 1000;
  }

  return err;
}

function stripLeadingThinking(text: string): string {
  const m = text.match(/^\s*<think>[\s\S]*?<\/think>\s*/i);
  return m ? text.slice(m[0].length) : text;
}

export function classifyError(err: unknown): LLMErrorKind {
  const e = err as any;
  const status = Number(e?.status ?? e?.response?.status) || undefined;
  if (status) {
    if (status === 429) return "quota";
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      return "rotate";
    }
    if (status === 413) return "rotate";
    if (status === 400 || status === 422) return "rotate";
    if (status >= 500) return "retryable";
    return "fatal";
  }

  const msg = String(e?.message ?? e ?? "");
  if (/\b429\b|quota exceeded|rate limit exceeded/i.test(msg)) return "quota";
  if (/\b41[03]\b|\b40[134]\b/i.test(msg)) return "rotate";
  if (
    /\b50[0234]\b|UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(
      msg,
    )
  ) {
    return "retryable";
  }
  if (
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|aborted|timeout/i.test(
      msg,
    )
  ) {
    return "retryable";
  }
  return "fatal";
}


