// src/history.ts
// History compression for the Omah agent loop.
//
// Tool results dominate history and are resent on every model call, so input
// tokens grow linearly with step count. This module replaces the *bodies* of
// old tool results with short stubs, keeping message count and role order
// intact so provider alternation rules are never broken.
//
// Design notes:
// - Deterministic. No network. No filesystem. No logging.
// - MUTATES the input history array and its messages in place. The caller
//   passes a working array and gets back the same reference. This is
//   deliberate; copying would double peak memory for no benefit.
// - Only contents change. A message is never removed and roles never swap.
//   The only structural edit is appending the progress ledger to message 0.
// - The most recent RECENT_KEEP messages stay verbatim.
// - read_file results get a re-read escape hatch, and a git hint when the
//   pre-edit body is the only remaining copy.
// - run_bash results prefer the digest recorded on the step at capture time
//   (keyLines, keyLinesTotal, testSummary, exitCode). Older steps recorded
//   before the digest existed fall back to scanning the message text.

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

/**
 * The agent loop's in-memory message shape. Mirrors `Message` in agent.ts,
 * with one extra field: `step`, the recorded step number this message
 * corresponds to. Set by agent.ts; used here to pair messages with steps.
 * Messages without a `step` are skipped by the stubber.
 */
export interface HistoryMessage {
  role: "user" | "model";
  parts: Array<{ text: string }>;
  step?: number;
}

/**
 * Structural equivalent of `ConversationStep` in agent.ts. Declared here
 * rather than imported, to avoid a circular dependency once agent.ts
 * imports from this module. The fields this module reads are a subset of
 * the real type; the extra fields in agent.ts do not affect us.
 */
export interface HistoryStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    output: string;
    /** True byte size of the tool's real output, before truncation. */
    outputBytes?: number;
    /** True line count of the tool's real output, before truncation. */
    outputLines?: number;
    /** Exit code from run_bash, when known. */
    exitCode?: number;
    /** Up to 15 digested interesting lines from a run_bash output. */
    keyLines?: string[];
    /** Total matches before the cap, so the stub can say "+N more". */
    keyLinesTotal?: number;
    /** Final test summary line, when a test command produced one. */
    testSummary?: string;
  };
}

export interface CompressContext {
  /** Commit SHA the workspace was cloned at, for git show hints. */
  startSha: string;
  /** Chars-per-token estimate for the size trigger. */
  charsPerToken?: number;
}

export interface CompressResult {
  /** The history to use for this turn. Same reference as the input. */
  history: HistoryMessage[];
  /** True if the history was rewritten. */
  didCompress: boolean;
}

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

/** Trailing messages kept verbatim. */
export const RECENT_KEEP = 5;

/** Minimum steps between compression passes. */
export const MIN_STEPS_BETWEEN = 6;

/** Estimated-token floor below which compression is skipped. */
export const MIN_ESTIMATED_TOKENS = 4000;

/** Hard cap on compression passes per task. */
export const MAX_COMPRESSIONS = 3;

/** Chars-per-token estimate. Crude but adequate for a trigger. */
const CHARS_PER_TOKEN = 4;

/** Prefix marking an already-stubbed tool result. */
export const COMPRESSED_PREFIX = "[compressed] ";

/** Prefix identifying a raw tool-result message. Must match agent.ts. */
const TOOL_RESULT_PREFIX = "Tool result (";

/** Stub a pre-edit read larger than this immediately. */
const PRE_EDIT_SIZE_LIMIT = 8 * 1024;

/** Stub any other result longer than this. */
const DEFAULT_STUB_LIMIT = 400;

/** Lines kept from the head of a long run_bash result. */
const BASH_HEAD_LINES = 10;

/** Lines kept from the tail of a long run_bash result. */
const BASH_TAIL_LINES = 20;

/** Maximum interesting middle lines to preserve from a bash result. */
const BASH_INTERESTING_LIMIT = 15;

/** Pattern matching lines worth preserving from the middle of bash output. */
const BASH_INTERESTING_PATTERN =
  /fail|error|✗|✕|FAIL|Cannot find|TypeError|ReferenceError|SyntaxError|AssertionError/i;

/** Pattern matching "nothing wrong" lines to exclude from the digest. */
const ZERO_LINE_PATTERN = /\b0\s+(failed|errors?)\b|no errors?/i;

/** Strips ANSI escape sequences before matching. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Steps within which a pre-edit read is considered fresh. */
const FRESH_EDIT_WINDOW = 3;

/** Marker written by truncate() in agent.ts. */
const TRUNCATION_MARKER = /… \[truncated (\d+) chars\]/;

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Decide whether to compress, and if so, do it in place.
 *
 * The caller is responsible for tracking `stepsSinceLastCompress` and
 * `compressionsDone`. This function is pure apart from the in-place
 * mutation of `history`.
 */
export function compressHistory(
  history: HistoryMessage[],
  steps: HistoryStep[],
  context: CompressContext,
  state: { stepsSinceLastCompress: number; compressionsDone: number },
): CompressResult {
  if (history.length === 0) {
    return { history, didCompress: false };
  }
  if (state.compressionsDone >= MAX_COMPRESSIONS) {
    return { history, didCompress: false };
  }
  const estimated = estimateTokens(history, context.charsPerToken);
const stepsGateMet = state.stepsSinceLastCompress >= MIN_STEPS_BETWEEN;
const sizeGateMet = estimated >= MIN_ESTIMATED_TOKENS;
if (!stepsGateMet && !sizeGateMet) {
  return { history, didCompress: false };
}

  const cutoff = history.length - RECENT_KEEP;
  if (cutoff <= 1) {
    return { history, didCompress: false };
  }

  const stepByNumber = indexSteps(steps);

  let didCompress = false;
  for (let i = 1; i < cutoff; i++) {
    const message = history[i];
    if (message.role !== "user") continue;
    if (typeof message.step !== "number") continue;

    const text = message.parts[0]?.text ?? "";
    if (!text.startsWith(TOOL_RESULT_PREFIX)) continue;
    if (text.startsWith(COMPRESSED_PREFIX)) continue;

    const step = stepByNumber.get(message.step);
    if (!step) continue;

    const stub = stubFor(text, step, steps, context, message.step);
    if (stub === null || stub === text) continue;

    message.parts[0].text = stub;
    didCompress = true;
  }

  const ledgerChanged = refreshLedger(history, cutoff, steps);
  if (ledgerChanged) didCompress = true;

  return { history, didCompress };
}

/**
 * Estimate input tokens for a history. Uses chars-per-token; crude but
 * consistent across runs, which is all the trigger needs.
 */
export function estimateTokens(
  history: HistoryMessage[],
  charsPerToken: number = CHARS_PER_TOKEN,
): number {
  let chars = 0;
  for (const message of history) {
    for (const part of message.parts) chars += part.text.length;
  }
  return Math.ceil(chars / charsPerToken);
}

// ---------------------------------------------------------------
// Stubbing dispatch
// ---------------------------------------------------------------

function stubFor(
  text: string,
  step: HistoryStep,
  allSteps: HistoryStep[],
  context: CompressContext,
  stepNumber: number,
): string | null {
  switch (step.tool) {
    case "read_file":
      return readStub(text, step, allSteps, context, stepNumber);
    case "run_bash":
      return bashStub(text, step);
    case "git_commit":
      return commitStub(step);
    case "finish":
      return null;
    case "request_write":
      return genericStub(text);
    default:
      return genericStub(text);
  }
}

// ---------------------------------------------------------------
// read_file
// ---------------------------------------------------------------

function readStub(
  text: string,
  step: HistoryStep,
  allSteps: HistoryStep[],
  context: CompressContext,
  stepNumber: number,
): string | null {
  const path = String(step.args.path ?? "?");
  const { lines, bytes, exact } = sizeOf(step, text);

  const laterWrite = findLaterWrite(allSteps, stepNumber, path);
  const laterRead = findLaterRead(allSteps, stepNumber, path);

  const size =
    exact
      ? `${lines} lines, ${bytes} bytes`
      : lines > 0
        ? `at least ${lines} lines, ${bytes} bytes`
        : "size unknown";

  const base = `${COMPRESSED_PREFIX}read ${path}: ${size}`;

  // Repeated read with no intervening write: superseded by the later read.
  if (laterRead && !laterWrite) {
    return `${base} (superseded by step ${laterRead.step})`;
  }

  // Pre-edit anchor: keep the body while the edit is fresh and small.
  if (laterWrite) {
    const fresh = laterWrite.step - stepNumber <= FRESH_EDIT_WINDOW;
    const small = exact ? bytes <= PRE_EDIT_SIZE_LIMIT : false;
    const healed = isEditHealed(allSteps, laterWrite.step);
    if (fresh && small && !healed) return null;
    return `${base}. Pre-edit body stubbed. Recover with: git show ${context.startSha}:${path}`;
  }

  return `${base}. Re-read with read_file if needed.`;
}

// ---------------------------------------------------------------
// run_bash
// ---------------------------------------------------------------

function bashStub(text: string, step: HistoryStep): string | null {
  const body = stripToolResultPrefix(text);
  const lines = body.split("\n");
  if (lines.length <= BASH_HEAD_LINES + BASH_TAIL_LINES) return null;

  const head = lines.slice(0, BASH_HEAD_LINES);
  const tail = lines.slice(-BASH_TAIL_LINES);

  // Prefer the digest recorded at capture time. Fall back to scanning the
  // message text for steps recorded before the digest existed.
  let keyLines: string[];
  let keyLinesTotal: number;
  if (step.result.keyLines && step.result.keyLines.length > 0) {
    keyLines = step.result.keyLines;
    keyLinesTotal = step.result.keyLinesTotal ?? keyLines.length;
  } else {
    const scanned = scanForKeyLines(lines.slice(BASH_HEAD_LINES, -BASH_TAIL_LINES));
    keyLines = scanned.lines;
    keyLinesTotal = scanned.total;
  }

  // De-duplicate against head and tail so the same line is not shown twice.
  const shown = new Set([...head, ...tail]);
  const uniqueKey = keyLines.filter((line) => !shown.has(line));

  const status = step.result.ok ? "ok" : "error";
  const exitLabel =
    step.result.exitCode !== undefined ? `exit ${step.result.exitCode} ` : "";
  const header = `${TOOL_RESULT_PREFIX}${status}): ${exitLabel}`.trimEnd();

  const parts: string[] = [...head];

  if (uniqueKey.length > 0) {
    const extra = Math.max(0, keyLinesTotal - keyLines.length);
    const moreLabel = extra > 0 ? ` (+${extra} more matching lines)` : "";
    parts.push(`[… key lines from the middle, ${keyLinesTotal} total${moreLabel} …]`);
    parts.push(...uniqueKey);
  } else {
    const omitted = lines.length - head.length - tail.length;
    parts.push(`[… ${omitted} lines omitted …]`);
  }

  parts.push(...tail);
  const compact = [header, ...parts].join("\n");

  return compact === text ? null : compact;
}

function scanForKeyLines(lines: string[]): {
  lines: string[];
  total: number;
} {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const cleaned = raw.replace(ANSI_PATTERN, "");
    const line = cleaned.trim();
    if (!line) continue;
    if (!BASH_INTERESTING_PATTERN.test(line)) continue;
    if (ZERO_LINE_PATTERN.test(line)) continue;
    const cut = line.slice(0, 200);
    if (seen.has(cut)) continue;
    seen.add(cut);
    out.push(cut);
  }
  return { lines: out.slice(0, BASH_INTERESTING_LIMIT), total: out.length };
}

// ---------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------

function commitStub(step: HistoryStep): string | null {
  const message = String(step.args.message ?? "");
  if (!message) return null;
  return `${COMPRESSED_PREFIX}git_commit: ${message}`;
}

// ---------------------------------------------------------------
// generic
// ---------------------------------------------------------------

function genericStub(text: string): string | null {
  if (text.length <= DEFAULT_STUB_LIMIT) return null;
  return (
    text.slice(0, DEFAULT_STUB_LIMIT) +
    `\n[truncated ${text.length - DEFAULT_STUB_LIMIT} chars]`
  );
}

// ---------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------

/**
 * Real size of a tool's output. Prefers fields recorded by agent.ts
 * before truncation; falls back to parsing the truncation marker; then
 * to the visible text length.
 */
function sizeOf(
  step: HistoryStep,
  text: string,
): { lines: number; bytes: number; exact: boolean } {
  if (
    typeof step.result.outputBytes === "number" &&
    typeof step.result.outputLines === "number"
  ) {
    return {
      lines: step.result.outputLines,
      bytes: step.result.outputBytes,
      exact: true,
    };
  }

  const marker = text.match(TRUNCATION_MARKER);
  if (marker) {
    const hidden = Number(marker[1]);
    if (Number.isFinite(hidden) && hidden > 0) {
      const visible = Buffer.byteLength(text, "utf8");
      const body = stripToolResultPrefix(text);
      return {
        lines: body.split("\n").length,
        bytes: visible + hidden,
        exact: false,
      };
    }
  }

  const body = stripToolResultPrefix(text);
  return {
    lines: body.split("\n").length,
    bytes: Buffer.byteLength(body, "utf8"),
    exact: true,
  };
}

// ---------------------------------------------------------------
// Progress ledger
// ---------------------------------------------------------------

/**
 * Append or refresh the progress ledger on message 0. The task text is
 * always preserved; the ledger is a suffix after a blank line.
 * Returns true if the message changed.
 */
function refreshLedger(
  history: HistoryMessage[],
  cutoff: number,
  steps: HistoryStep[],
): boolean {
  const ledger = buildLedger(steps);
  if (!ledger) return false;

  const head = history[0];
  if (!head || head.role !== "user") return false;

  const current = head.parts[0]?.text ?? "";
  const marker = "\n\nProgress so far:";
  const index = current.indexOf(marker);

  const next =
    index >= 0
      ? current.slice(0, index) + "\n\n" + ledger
      : current + "\n\n" + ledger;

  if (next === current) return false;
  head.parts[0].text = next;
  return true;
}

function buildLedger(steps: HistoryStep[]): string {
  if (steps.length === 0) return "";

  const read = new Set<string>();
  const wrote = new Set<string>();
  const commits: string[] = [];
  let lastTest: string | null = null;

  for (const step of steps) {
    if (step.tool === "read_file" && step.result.ok) {
      read.add(String(step.args.path ?? "?"));
    } else if (step.tool === "request_write" && step.result.ok) {
      wrote.add(String(step.args.path ?? "?"));
    } else if (step.tool === "git_commit" && step.result.ok) {
      commits.push(String(step.args.message ?? ""));
    } else if (
      step.tool === "run_bash" &&
      step.result.ok &&
      isTestCommand(String(step.args.command ?? ""))
    ) {
      // Prefer the stored test summary; fall back to scanning the output.
      lastTest =
        step.result.testSummary ??
        summariseTestOutput(step.result.output);
    }
  }

  const parts: string[] = [];
  if (read.size) parts.push(`read ${[...read].join(", ")}`);
  if (wrote.size) parts.push(`wrote ${[...wrote].join(", ")}`);
  if (commits.length)
    parts.push(`committed ${commits.map((c) => `"${c}"`).join(", ")}`);
  if (lastTest) parts.push(`last test: ${lastTest}`);

  return parts.length ? `Progress so far: ${parts.join("; ")}` : "";
}

function summariseTestOutput(output: string): string {
  const lines = output.split("\n");
  const summary =
    lines.find((line) => /\b\d+\s+(passed|failed|suites?|tests?)\b/i.test(line)) ??
    lines.find((line) => /\b(pass|fail|error)\b/i.test(line)) ??
    lines[lines.length - 1] ??
    "";
  return summary.trim().slice(0, 120);
}

// ---------------------------------------------------------------
// Step lookup
// ---------------------------------------------------------------

function indexSteps(steps: HistoryStep[]): Map<number, HistoryStep> {
  const map = new Map<number, HistoryStep>();
  for (const step of steps) map.set(step.step, step);
  return map;
}

function findLaterWrite(
  steps: HistoryStep[],
  afterStep: number,
  path: string,
): HistoryStep | null {
  for (const step of steps) {
    if (
      step.step > afterStep &&
      step.tool === "request_write" &&
      step.result.ok &&
      String(step.args.path ?? "") === path
    ) {
      return step;
    }
  }
  return null;
}

function findLaterRead(
  steps: HistoryStep[],
  afterStep: number,
  path: string,
): HistoryStep | null {
  for (const step of steps) {
    if (
      step.step > afterStep &&
      step.tool === "read_file" &&
      String(step.args.path ?? "") === path
    ) {
      return step;
    }
  }
  return null;
}

function isEditHealed(steps: HistoryStep[], afterStep: number): boolean {
  for (const step of steps) {
    if (step.step <= afterStep) continue;
    if (step.tool === "git_commit" && step.result.ok) return true;
    if (
      step.tool === "run_bash" &&
      step.result.ok &&
      isTestCommand(String(step.args.command ?? ""))
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

function isTestCommand(command: string): boolean {
  return /\b(test|vitest|jest|pytest|npm test|pnpm test|yarn test)\b/i.test(
    command,
  );
}

function stripToolResultPrefix(text: string): string {
  if (!text.startsWith(TOOL_RESULT_PREFIX)) return text;
  const colon = text.indexOf(":");
  return colon >= 0 ? text.slice(colon + 1).replace(/^\s/, "") : text;
}

// ---------------------------------------------------------------
// TODO: parse-failure and retry-noise stubbing
//
// Parse-failure messages begin with "Your previous reply was invalid:" and
// retry instructions begin with "Tool result (error):" plus a hint. Both are
// large and never compressed today. Deferred until the diagnostics show the
// real cost on a representative week of runs. If added, this should be a
// dedicated rule keyed on the message prefix, not on the step record, since
// parse failures do not produce a step.
// ---------------------------------------------------------------