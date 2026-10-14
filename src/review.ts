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
const TEST_COMMAND_PATTERN =
  /\b(test|vitest|jest|pytest|npm test|pnpm test|yarn test)\b/i;

/** Severities that warrant a fix round. */
const ACTIONABLE_SEVERITIES: ReadonlySet<ReviewIssue["severity"]> = new Set([
  "medium",
  "high",
]);

// ---------------------------------------------------------------
// Test command selection
// ---------------------------------------------------------------

/**
 * Pick the test command for the fresh review run. Prefers the most recent
 * test command the agent ran; falls back to the package.json test script.
 * Returns null when neither exists.
 */
export function pickTestCommand(
  steps: Array<{ tool: string; args: Record<string, unknown> }>,
  packageJsonTestScript: string | null,
): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.tool !== "run_bash") continue;
    const command = String(step.args.command ?? "");
    if (TEST_COMMAND_PATTERN.test(command)) return command;
  }
  if (packageJsonTestScript && packageJsonTestScript.trim()) {
    return packageJsonTestScript;
  }
  return null;
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
 * Build the reviewer prompt. The reviewer sees the task, the diff, the
 * fresh test digest, and the file list. Nothing else.
 */
export function buildReviewPrompt(inputs: ReviewInputs): string {
  const lines: string[] = [];

  lines.push("You are reviewing a code change produced by another agent.");
  lines.push("");
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
  lines.push("");
  lines.push("## Your job");
  lines.push("");
  lines.push("Judge only these four things:");
  lines.push("");
  lines.push("1. Correctness: does the diff do what the task asked?");
  lines.push("2. Scope creep: does it change anything the task did not ask for?");
  lines.push("3. Tests: were missing or failing tests added or fixed?");
  lines.push("4. Leftover debug code: console.log, TODO, commented-out blocks,");
  lines.push("   hardcoded credentials, test-only branches.");
  lines.push("");
  lines.push("Ignore style, naming, formatting, and architectural preferences.");
  lines.push("Do not suggest improvements. Do not re-implement the task.");
  lines.push("");
  lines.push("Severity guide:");
  lines.push("- high: the change is wrong, incomplete, or breaks behavior.");
  lines.push("- medium: a real problem the task implies, but not a break.");
  lines.push("- low: worth noting, not worth a fix round.");
  lines.push("");
  lines.push('When you are unsure, return "pass". A false concern costs the');
  lines.push("user a fix round. A missed concern costs nothing extra.");
  lines.push("");
  lines.push("## Response format");
  lines.push("");
  lines.push("Respond with strict JSON only. No prose, no fences. Exactly:");
  lines.push("");
  lines.push("{");
  lines.push('  "verdict": "pass" | "concerns",');
  lines.push('  "issues": [');
  lines.push('    { "file": "path/to/file", "severity": "low"|"medium"|"high",');
  lines.push('      "note": "one to three sentences" }');
  lines.push("  ]");
  lines.push("}");
  lines.push("");
  lines.push('Return "pass" with an empty issues array when nothing is wrong.');

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
  const actionable = issues.filter((i) =>
    ACTIONABLE_SEVERITIES.has(i.severity),
  );
  const lines: string[] = [];
  lines.push("A reviewer found issues with your previous change:");
  lines.push("");
  for (const issue of actionable) {
    lines.push(`- [${issue.severity}] ${issue.file}: ${issue.note}`);
  }
  lines.push("");
  lines.push("Address only these issues. Do not make unrelated changes.");
  lines.push("When done, call finish again.");
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
  const count = args.issues.filter((i) =>
    ACTIONABLE_SEVERITIES.has(i.severity),
  ).length;
  const noun = count === 1 ? "issue" : "issues";
  const fix = args.fixRoundAttempted
    ? "fix round attempted"
    : "fix round skipped (budget)";
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
export function truncateDiff(
  diff: string,
  perFileBytes: number,
  totalBytes: number,
): string {
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