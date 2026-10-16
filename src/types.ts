// src/types.ts
// Shared types used across Omah's modules. No runtime code.

import type { ToolName } from "./tool-contract.js";
import type { ReviewIssue } from "./review.js";

export interface Message {
  role: "user" | "model";
  parts: Array<{ text: string }>;
  step?: number;
}

export interface ConversationStep {
  step: number;
  reasoning: string;
  tool: ToolName;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    output: string;
    truncated?: boolean;
    outputBytes?: number;
    outputLines?: number;
    exitCode?: number;
    keyLines?: string[];
    keyLinesTotal?: number;
    testSummary?: string;
  };
  at: string;
}

export interface Conversation {
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
  reviewConcerns?: boolean;
  reviewIssues?: ReviewIssue[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number;
  keyLines?: string[];
  keyLinesTotal?: number;
  testSummary?: string;
}

export interface WriteState {
  path: string;
  chunks: Buffer[];
  bytesTotal: number;
}

export type ChunkErrorCode =
  "TOOL_CALL_GUARD" | "MISSING_SENTINEL" | "CHUNK_TOO_LARGE" | "FILE_TOO_LARGE";

export type ChunkOutcome =
  { kind: "more" } | { kind: "end" } | { kind: "error"; code: ChunkErrorCode; message: string };

export interface UsageInfo {
  input: number;
  output: number;
  thoughts: number;
  ms: number;
  keyIndex: number;
}

export interface KeyStat {
  calls: number;
  rate429: number;
  errors: number;
  lastError?: string;
}

export interface StepUsage {
  step: number;
  input: number;
  output: number;
  thoughts: number;
  ms: number;
  tool: string;
}
