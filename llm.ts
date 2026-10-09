// llm.ts
// Provider abstraction for the Omah agent loop.

import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

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
}

export interface LLMProvider {
  complete(req: LLMRequest, keyIndex: number): Promise<LLMResponse>;
}

export type LLMErrorKind = "quota" | "rotate" | "retryable" | "fatal";

// ---------------------------------------------------------------
// Provider specs
// ---------------------------------------------------------------

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
    name: "nvidia",
    envVar: "NVIDIA_KEYS",
    model: "deepseek-ai/deepseek-v4-pro",
    baseURL: "https://integrate.api.nvidia.com/v1",
  },
  {
    name: "mistral",
    envVar: "MISTRAL_KEYS",
    model: "mistral-medium-3.5",
    baseURL: "https://api.mistral.ai/v1",
  },
  {
    name: "opencode",
    envVar: "OPENCODE_KEYS",
    model: "nemotron-3.5-lightning-free",
    baseURL: "https://opencode.ai/inference/openai/v1",
  },
];

// ---------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------

export interface KeySpec {
  provider: string;
  model: string;
  baseURL: string | null;
  key: string;
}

export function loadAllKeys(
  log?: (msg: string) => Promise<void>,
): KeySpec[] {
  const out: KeySpec[] = [];
  for (const spec of PROVIDERS) {
    const raw = process.env[spec.envVar];
    if (!raw) {
      if (log)
        void log(`provider ${spec.name}: no ${spec.envVar} set, skipping`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (log)
        void log(`provider ${spec.name}: ${spec.envVar} is not valid JSON`);
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      if (log)
        void log(
          `provider ${spec.name}: ${spec.envVar} is not a non-empty array`,
        );
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

// ---------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------

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
        ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    });
    const elapsed = Date.now() - started;

    const um: any = (response as any).usageMetadata ?? {};
    const rawText = response.text ?? "";
    return {
      text: stripThinking(rawText),
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

// ---------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------

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

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
    };
    if (req.jsonMode) {
      body.response_format = { type: "json_object" };
    }

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
      });
    } catch (err: any) {
      throw new Error(`fetch failed: ${err?.message ?? err}`);
    }

    if (!res.ok) {
      const text = await res.text();
      // Some models reject response_format. Retry once without it.
      if (
        req.jsonMode &&
        (res.status === 400 || res.status === 422) &&
        /response_format|json_object/i.test(text)
      ) {
        return this.complete({ ...req, jsonMode: false }, keyIndex);
      }
      throw makeHttpError(res.status, text);
    }

    const json: any = await res.json();
    const elapsed = Date.now() - started;
    const choice = json?.choices?.[0];
    const rawText = choice?.message?.content ?? "";
    const usage = json?.usage ?? {};

    return {
      text: stripThinking(rawText),
      usage: {
        input: Number(usage.prompt_tokens ?? 0),
        output: Number(usage.completion_tokens ?? 0),
        thoughts: Number(
          usage.completion_tokens_details?.reasoning_tokens ?? 0,
        ),
        ms: elapsed,
        keyIndex,
      },
    };
  }
}

// ---------------------------------------------------------------
// Factory
// ---------------------------------------------------------------

export function makeProvider(spec: KeySpec): LLMProvider {
  if (spec.provider === "gemini" || spec.baseURL === null) {
    return new GeminiProvider(spec.key, spec.model);
  }
  return new OpenAICompatibleProvider(spec.baseURL, spec.model, spec.key);
}

// ---------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------

function makeHttpError(status: number, body: string): Error {
  const err = new Error(`HTTP ${status}: ${body.slice(0, 400)}`) as Error & {
    status?: number;
  };
  err.status = status;
  return err;
}

/**
 * Strip reasoning blocks some providers emit inline.
 * Applies to DeepSeek (<think>...</think>) and Nemotron variants.
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function classifyError(err: unknown): LLMErrorKind {
  const e = err as any;

  // Trust the HTTP status when present. Do NOT use e.code — Node sets it
  // to strings like ECONNRESET or ETIMEDOUT for network errors.
  const status = Number(e?.status ?? e?.response?.status) || undefined;
  if (status) {
    if (status === 429) return "quota";
    if (status === 401 || status === 403 || status === 404) return "rotate";
    if (status >= 500) return "retryable";
    return "fatal";
  }

  // No HTTP status. Classify by message.
  const msg = String(e?.message ?? e ?? "");
  if (/\b429\b|quota exceeded|rate limit exceeded/i.test(msg)) return "quota";
  if (/\b40[134]\b/i.test(msg)) return "rotate";
  if (
    /\b50[0234]\b|UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(
      msg,
    )
  ) {
    return "retryable";
  }
  if (
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(
      msg,
    )
  ) {
    return "retryable";
  }

  return "fatal";
}