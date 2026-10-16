export type ToolName = "read_file" | "request_write" | "run_bash" | "git_commit" | "finish";

export interface ToolCall {
  name: string;
  arguments: unknown;
  reasoning?: string;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string"; enum?: string[] }>;
    required: string[];
    additionalProperties: false;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file from the repository workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "request_write",
    description: "Request to write a file; the next response is raw file content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_bash",
    description: "Run a shell command in the repository workspace.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "git_commit",
    description: "Commit all current changes in the repository workspace.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "Finish the task with a summary and terminal status.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        status: { type: "string", enum: ["done", "blocked"] },
      },
      required: ["summary", "status"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export type ParseToolCallResult =
  { kind: "call"; call: ToolCall } | { kind: "invalid"; message: string } | { kind: "none" };

export function validateToolCall(name: string, args: unknown): ParseToolCallResult {
  const definition = TOOL_BY_NAME.get(name as ToolName);
  if (!definition) return { kind: "invalid", message: `unknown tool: ${name}` };
  if (!isRecord(args)) {
    return { kind: "invalid", message: `${name} arguments must be an object` };
  }

  const allowed = new Set(Object.keys(definition.parameters.properties));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return { kind: "invalid", message: `${name} has unexpected argument: ${key}` };
    }
  }
  for (const key of definition.parameters.required) {
    if (!(key in args)) {
      return { kind: "invalid", message: `${name} is missing required argument: ${key}` };
    }
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) {
      return { kind: "invalid", message: `${name}.${key} must be a non-empty string` };
    }
    const property = definition.parameters.properties[key];
    if (property.enum && !property.enum.includes(value)) {
      return {
        kind: "invalid",
        message: `${name}.${key} must be one of: ${property.enum.join(", ")}`,
      };
    }
  }

  return {
    kind: "call",
    call: { name, arguments: args },
  };
}

export function parseToolCall(text: string, provider: string): ParseToolCallResult {
  const raw = stripWholeCodeFence(text.trim());
  const direct = parseEnvelope(raw, provider === "poolside");
  if (direct.kind !== "none") return direct;

  if (provider === "poolside") {
    const xml = raw.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
    if (xml) {
      const wrapped = parseEnvelope(xml[1].trim(), true);
      if (wrapped.kind !== "none") return wrapped;
      return {
        kind: "invalid",
        message: "Poolside tool_call wrapper must contain one JSON tool envelope",
      };
    }
  }

  if (provider !== "poolside") return { kind: "none" };

  const candidates: Array<{ start: number; end: number; result: ParseToolCallResult }> = [];
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{") continue;
    const end = matchBrace(raw, start);
    if (end < 0) continue;
    const result = parseEnvelope(raw.slice(start, end + 1), true);
    if (result.kind !== "none") candidates.push({ start, end, result });
  }

  if (candidates.length > 1) {
    return { kind: "invalid", message: "multiple possible tool calls; reply with exactly one" };
  }
  return candidates[0]?.result ?? { kind: "none" };
}

export function validateNativeToolCall(call: ToolCall): ParseToolCallResult {
  const result = validateToolCall(call.name, call.arguments);
  if (result.kind !== "call") return result;
  return {
    kind: "call",
    call: { ...result.call, reasoning: call.reasoning ?? "" },
  };
}

function parseEnvelope(text: string, allowFlat: boolean): ParseToolCallResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { kind: "none" };
  }
  if (!isRecord(envelope) || typeof envelope.tool !== "string") {
    return { kind: "none" };
  }
  if ("reasoning" in envelope && typeof envelope.reasoning !== "string") {
    return { kind: "invalid", message: "reasoning must be a string" };
  }

  let args: unknown;
  if ("args" in envelope) {
    const unexpected = Object.keys(envelope).filter(
      (key) => !["reasoning", "tool", "args"].includes(key),
    );
    if (unexpected.length > 0) {
      return { kind: "invalid", message: `unexpected envelope field: ${unexpected[0]}` };
    }
    args = envelope.args;
  } else {
    if (!allowFlat) {
      return { kind: "invalid", message: "flat tool envelopes are supported only for Poolside" };
    }
    const { tool, reasoning: _reasoning, ...flatArgs } = envelope;
    args = flatArgs;
  }

  const result = validateToolCall(envelope.tool, args);
  if (result.kind !== "call") return result;
  return {
    kind: "call",
    call: { ...result.call, reasoning: envelope.reasoning ?? "" },
  };
}

function stripWholeCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}
