// src/review.ts
// Review gate for the Omah agent loop.
//
// Pure functions only. No network, no filesystem, no logging. The caller
// (agent.ts) gathers the inputs, calls these, and handles side effects.
//
// The gate has one job: give an independent reviewer enough context to
// judge whether the agent's patch actually did the task, without giving
// it the agent's history, reasoning, or tool access. Everything it returns
// is data. Nothing here is executed, and nothing here can block a push
// on its own.

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface ReviewIssue {
  file: string;
  severity: "low" | "medium" | "high";
  note: string;
}

export interface ReviewVerdict {
  verdict: "pass" | "concerns";
  issues: ReviewIssue[];
}

export interface ReviewInputs {
  task: string;
  diff: string;
  fileList: string[];
  testSummary: string | null;
  testKeyLines: string[];
  testExitCode: number | null;
  testTimedOut: boolean;
  hadTests: boolean;
  sameProviderAsWriter: boolean;
}

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

/** Cap the reviewer's issue list so a verbose reviewer can't flood a PR body. */
export const REVIEW_MAX_ISSUES = 10;

/** Per-issue note cap, in characters. */
const REVIEW_NOTE_CHARS = 280;

/** Test command pattern. Matches the loop's isTestCommand in history.ts. */
const TEST_COMMAND_PATTERN = /\b(test|vitest|jest|pytest|npm test|pnpm test|yarn test)\b/i;

/** Severities that warrant a fix round. */
const ACTIONABLE_SEVERITIES: ReadonlySet<ReviewIssue["severity"]> = new Set(["medium", "high"]);

// ---------------------------------------------------------------
// Test command selection
// ---------------------------------------------------------------

/**
 * Pick the test command for the fresh review run. Prefers the most recent
 * test command the agent ran; falls back to the package.json test script.
 * Strips shell chaining from the picked command so a run like
 * `pnpm test && git status && git diff` yields just `pnpm test`.
 */
export function pickTestCommand(
  steps: Array<{ tool: string; args: Record<string, unknown> }>,
  packageJsonTestScript: string | null,
): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.tool !== "run_bash") continue;
    const command = String(step.args.command ?? "");
    const stripped = extractTestCommand(command);
    if (stripped) return stripped;
  }
  if (packageJsonTestScript && packageJsonTestScript.trim()) {
    return packageJsonTestScript.trim();
  }
  return null;
}

/**
 * Extract just the test command from a possibly-chained shell command.
 * Splits on `&&`, `||`, `;`, and `|`, finds the first segment that
 * matches the test pattern, and keeps any leading `cd` segments so the
 * test runs in the right directory. Returns null if no segment matches.
 */
function extractTestCommand(command: string): string | null {
  const parts = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  let testIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (TEST_COMMAND_PATTERN.test(parts[i])) {
      testIndex = i;
      break;
    }
  }
  if (testIndex < 0) return null;

  const leading: string[] = [];
  for (let i = 0; i < testIndex; i++) {
    if (/^cd\s/.test(parts[i])) leading.push(parts[i]);
  }
  return [...leading, parts[testIndex]].join(" && ");
}

/**
 * Read the package.json "scripts.test" value from a parsed object.
 * Returns null when absent, empty, or malformed.
 */
export function readTestScript(pkg: unknown): string | null {
  if (!pkg || typeof pkg !== "object") return null;
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const test = (scripts as { test?: unknown }).test;
  if (typeof test !== "string" || !test.trim()) return null;
  return test;
}

// ---------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------

/**
 * Assemble the reviewer's user message. Data only: task, files, test
 * digest, diff. The rubric lives in review-system.md and is passed as
 * the system prompt by the caller.
 */
export function buildReviewPrompt(inputs: ReviewInputs): string {
  const lines: string[] = [];

  lines.push("## Task");
  lines.push("");
  lines.push(inputs.task.trim());
  lines.push("");
  lines.push("## Files changed");
  lines.push("");
  if (inputs.fileList.length === 0) {
    lines.push("(none)");
  } else {
    for (const file of inputs.fileList) lines.push(`- ${file}`);
  }
  lines.push("");
  lines.push("## Test results");
  lines.push("");
  if (!inputs.hadTests) {
    lines.push("No tests were run. The repository has no test command.");
  } else if (inputs.testTimedOut) {
    lines.push("The test run timed out before completing.");
  } else {
    if (inputs.testExitCode !== null) {
      lines.push(`Exit code: ${inputs.testExitCode}`);
    }
    if (inputs.testSummary) {
      lines.push(`Summary: ${inputs.testSummary}`);
    }
    if (inputs.testKeyLines.length > 0) {
      lines.push("");
      lines.push("Key lines:");
      for (const line of inputs.testKeyLines) lines.push(`  ${line}`);
    }
    if (!inputs.testSummary && inputs.testKeyLines.length === 0) {
      lines.push("(no summary or key lines available)");
    }
  }
  if (inputs.sameProviderAsWriter) {
    lines.push("");
    lines.push("Note: this review is running on the same provider that wrote");
    lines.push("the change. That makes it a weaker check.");
  }
  lines.push("");
  lines.push("## Diff");
  lines.push("");
  lines.push("```diff");
  lines.push(inputs.diff.trim() || "(empty)");
  lines.push("```");

  return lines.join("\n");
}

// ---------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------

/**
 * Parse the reviewer's response. Tolerates whole-response code fences
 * and prose that contains exactly one JSON object. Returns null on any
 * failure so the caller can skip the gate cleanly.
 */
export function parseReviewResponse(text: string): ReviewVerdict | null {
  const stripped = stripWholeCodeFence(text.trim());
  const candidate = extractFirstJsonObject(stripped);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const verdict = obj.verdict;
  if (verdict !== "pass" && verdict !== "concerns") return null;

  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: ReviewIssue[] = [];
  for (const raw of rawIssues) {
    if (!raw || typeof raw !== "object") continue;
    const issue = raw as Record<string, unknown>;
    const file = typeof issue.file === "string" ? issue.file.trim() : "";
    const severity = issue.severity;
    const note = typeof issue.note === "string" ? issue.note.trim() : "";
    if (!file || !note) continue;
    if (severity !== "low" && severity !== "medium" && severity !== "high") {
      continue;
    }
    issues.push({
      file,
      severity,
      note: note.slice(0, REVIEW_NOTE_CHARS),
    });
    if (issues.length >= REVIEW_MAX_ISSUES) break;
  }

  if (verdict === "pass" && issues.length > 0) {
    // Reviewer contradicted itself. Trust the issues.
    return { verdict: "concerns", issues };
  }
  return { verdict, issues };
}

// ---------------------------------------------------------------
// Harness-owned issues
// ---------------------------------------------------------------

/**
 * Merge harness-observed issues with the reviewer's. Harness issues are
 * authoritative: a failing test or a timeout is high-severity no matter
 * what the reviewer said. Deduplicates by file+note prefix.
 */
export function mergeIssues(
  reviewerIssues: ReviewIssue[],
  harnessIssues: ReviewIssue[],
): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: ReviewIssue) => {
    const key = `${issue.file}\u0000${issue.note.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(issue);
  };
  for (const issue of harnessIssues) push(issue);
  for (const issue of reviewerIssues) push(issue);
  return out.slice(0, REVIEW_MAX_ISSUES);
}

/**
 * True when at least one issue warrants a fix round. Low issues alone
 * do not.
 */
export function hasActionableIssue(issues: ReviewIssue[]): boolean {
  for (const issue of issues) {
    if (ACTIONABLE_SEVERITIES.has(issue.severity)) return true;
  }
  return false;
}

/**
 * Build the harness-owned issues from the fresh test run. Failing tests
 * after the agent said "done" are high. A timeout is high.
 */
export function harnessIssuesFromTests(args: {
  hadTests: boolean;
  testTimedOut: boolean;
  testExitCode: number | null;
}): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  if (args.testTimedOut) {
    issues.push({
      file: "(test run)",
      severity: "high",
      note: "The test run did not complete within the review budget.",
    });
    return issues;
  }

  if (args.hadTests && args.testExitCode !== null && args.testExitCode !== 0) {
    issues.push({
      file: "(tests)",
      severity: "high",
      note: `The test suite exited with code ${args.testExitCode} after the agent reported done.`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------
// Fix-round message
// ---------------------------------------------------------------

/**
 * Build the follow-up text passed into the loop on a fix round. Lists
 * the actionable issues and nothing else.
 */
export function buildFixRoundMessage(issues: ReviewIssue[]): string {
  const actionable = issues.filter((i) => ACTIONABLE_SEVERITIES.has(i.severity));
  const lines: string[] = [];
  lines.push("A reviewer found issues with your previous change:");
  lines.push("");
  for (const issue of actionable) {
    lines.push(`- [${issue.severity}] ${issue.file}: ${issue.note}`);
  }
  lines.push("");
  lines.push("Address only these issues. Do not make unrelated changes.");
  lines.push("");
  lines.push(
    "When done, call finish again with a summary that describes the " +
      "complete task, not just this fix. The summary becomes the PR title " +
      "and body, so it must cover the original change and this fix.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------
// PR body helpers
// ---------------------------------------------------------------

/**
 * One-line status for the top of a concerns PR.
 */
export function reviewConcernsStatusLine(args: {
  fixRoundAttempted: boolean;
  issues: ReviewIssue[];
}): string {
  const count = args.issues.filter((i) => ACTIONABLE_SEVERITIES.has(i.severity)).length;
  const noun = count === 1 ? "issue" : "issues";
  const fix = args.fixRoundAttempted ? "fix round attempted" : "fix round skipped (budget)";
  return `Draft: review found ${count} ${noun}; ${fix}.`;
}

/**
 * Markdown table of findings for the PR body.
 */
export function formatIssuesTable(issues: ReviewIssue[]): string {
  if (issues.length === 0) return "_No issues recorded._";
  const lines: string[] = [];
  lines.push("| file | severity | note |");
  lines.push("|---|---|---|");
  for (const issue of issues) {
    const file = issue.file.replace(/\|/g, "\\|");
    const note = issue.note.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${file} | ${issue.severity} | ${note} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------
// Diff handling
// ---------------------------------------------------------------

/**
 * Truncate a diff per file, then overall. Per-file caps keep one huge
 * generated file from crowding out the real changes.
 */
export function truncateDiff(diff: string, perFileBytes: number, totalBytes: number): string {
  const chunks = diff.split(/^(?=diff --git )/m);
  const truncated = chunks.map((chunk) => {
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (bytes <= perFileBytes) return chunk;
    const marker = `\n… [file diff truncated: ${bytes - perFileBytes} bytes omitted] …\n`;
    const keep = Math.max(0, perFileBytes - marker.length);
    return chunk.slice(0, keep) + marker;
  });
  const joined = truncated.join("");
  const joinedBytes = Buffer.byteLength(joined, "utf8");
  if (joinedBytes > totalBytes) {
    const marker = `\n… [diff truncated: ${joinedBytes - totalBytes} bytes omitted] …\n`;
    const keep = Math.max(0, totalBytes - marker.length);
    return joined.slice(0, keep) + marker;
  }
  return joined;
}

/**
 * Extract the changed file paths from a diff. Returns them in the order
 * they appear, deduplicated.
 */
export function filesFromDiff(diff: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(diff)) !== null) {
    const path = match[2];
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function stripWholeCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

/**
 * Return the first balanced JSON object in the text, or null. Handles
 * a response like `Here is the review: { ... }` without requiring a
 * JSON-only reply.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Harness-owned diff scan
// ---------------------------------------------------------------

export interface DiffScanResult {
  issues: ReviewIssue[];
  /** Raw secret values. The caller must log ::add-mask:: for each. */
  secrets: string[];
}

const NOISE_PATH_PATTERNS: RegExp[] = [
  /\.md$/i,
  /\.txt$/i,
  /\.rst$/i,
  /\.adoc$/i,
  /(?:^|\/)(?:node_modules|dist|build|vendor|coverage)\//i,
  /(?:^|\/)__snapshots__\//i,
  /(?:^|\/)fixtures?\//i,
  /\.snap$/i,
  /\.snapshot$/i,
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i,
];

const TEST_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)__tests__\//i,
  /(?:^|\/)tests?\//i,
  /\.test\.[a-z]+$/i,
  /\.spec\.[a-z]+$/i,
];

const CLI_PATH_PATTERNS: RegExp[] = [/(?:^|\/)bin\//i, /\.cli\.[a-z]+$/i];

const CONSOLE_PATTERN = /\bconsole\.(log|debug|trace|dir)\s*\(/;
const DEBUGGER_PATTERN = /(^|[^.\w])debugger(\s*;)?\s*$/;
const TODO_PATTERN = /\b(TODO|FIXME|XXX)\b/;

const SECRET_FORMATS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[a-zA-Z0-9]{36}\b/,
  /\bghs_[a-zA-Z0-9]{36}\b/,
  /\bgho_[a-zA-Z0-9]{36}\b/,
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bsk_live_[a-zA-Z0-9]{20,}\b/,
  /\bxox[bpoas]-[a-zA-Z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const SECRET_NAME_HINT =
  /(?<![A-Za-z0-9])(?:key|token|secret|password|passwd|credential)s?(?![A-Za-z0-9])/i;
const PLACEHOLDER_PREFIX =
  /^(?:your|my|the|example|sample|test|dummy|fake|placeholder|changeme|xxx)/i;

/**
 * Deterministic scan of a diff for debug code and secrets. Debug findings
 * are low severity and do not trigger a fix round. Secret findings are
 * high severity and do. The caller must log ::add-mask:: for every value
 * in `secrets` before anything else touches the log.
 */
export function scanDiffForIssues(diff: string, taskText: string): DiffScanResult {
  const issues: ReviewIssue[] = [];
  const secrets: string[] = [];
  const taskLower = taskText.toLowerCase();

  let currentFile = "";
  const lines = diff.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    const headerMatch = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (headerMatch) {
      currentFile = headerMatch[1];
      continue;
    }

    if (!raw.startsWith("+")) continue;
    if (raw.startsWith("+++")) continue;
    if (!currentFile) continue;

    if (isNoisePath(currentFile)) continue;

    const content = raw.slice(1);
    const lineNo = estimateLineNumber(lines, i);
    const fileIsTest = TEST_PATH_PATTERNS.some((p) => p.test(currentFile));
    const fileIsCli = CLI_PATH_PATTERNS.some((p) => p.test(currentFile));
    const fileInTask = pathMentionedInTask(currentFile, taskLower);

    if (!fileIsTest) {
      if (CONSOLE_PATTERN.test(content) && !fileInTask && !fileIsCli) {
        issues.push({
          file: currentFile,
          severity: "low",
          note: `Added console.* at line ${lineNo}. Remove before merge.`,
        });
      }
      if (DEBUGGER_PATTERN.test(content)) {
        issues.push({
          file: currentFile,
          severity: "low",
          note: `Added debugger statement at line ${lineNo}. Remove before merge.`,
        });
      }
      if (TODO_PATTERN.test(content)) {
        issues.push({
          file: currentFile,
          severity: "low",
          note: `Added TODO/FIXME/XXX marker at line ${lineNo}.`,
        });
      }
    }

    const secret = looksLikeSecret(content);
    if (secret) {
      secrets.push(secret);
      const label = redactLabel(content);
      issues.push({
        file: currentFile,
        severity: "high",
        note: `Possible secret at line ${lineNo}: ${label}. Remove before merge.`,
      });
    }
  }

  return { issues, secrets };
}

function isNoisePath(path: string): boolean {
  return NOISE_PATH_PATTERNS.some((re) => re.test(path));
}

function pathMentionedInTask(path: string, taskLower: string): boolean {
  if (taskLower.includes(path.toLowerCase())) return true;
  const base = path.split("/").pop() ?? "";
  if (base && taskLower.includes(base.toLowerCase())) return true;
  return false;
}

function estimateLineNumber(lines: string[], index: number): number {
  for (let i = index; i >= 0; i--) {
    const h = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!h) continue;
    const start = Number(h[1]);
    let count = 0;
    for (let j = i + 1; j <= index; j++) {
      const l = lines[j];
      if (l.startsWith("+") || l.startsWith(" ")) count++;
    }
    return start + Math.max(0, count - 1);
  }
  return 0;
}

function looksLikeSecret(line: string): string | null {
  for (const re of SECRET_FORMATS) {
    const m = line.match(re);
    if (m) return m[0];
  }
  if (!SECRET_NAME_HINT.test(line)) return null;
  const literalRe = /["']([^"'\s]{20,})["']/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(line)) !== null) {
    const value = m[1];
    if (/^[0-9a-fA-F]+$/.test(value)) continue;
    if (PLACEHOLDER_PREFIX.test(value)) continue;
    return value;
  }
  return null;
}

function redactLabel(line: string): string {
  const nameMatch = line.match(/([A-Za-z_][A-Za-z0-9_]{0,30})\s*[:=]\s*["']/);
  const name = nameMatch ? nameMatch[1] : "value";
  return `${name}=…[redacted]`;
}
