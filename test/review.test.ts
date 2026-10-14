import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFixRoundMessage,
  buildReviewPrompt,
  filesFromDiff,
  formatIssuesTable,
  harnessIssuesFromTests,
  hasActionableIssue,
  mergeIssues,
  parseReviewResponse,
  pickTestCommand,
  readTestScript,
  reviewConcernsStatusLine,
  truncateDiff,
  type ReviewIssue,
} from "../src/review.js";

// ---------------------------------------------------------------
// pickTestCommand
// ---------------------------------------------------------------

test("pickTestCommand finds the most recent test command", () => {
  const steps = [
    { tool: "run_bash", args: { command: "ls -la" } },
    { tool: "run_bash", args: { command: "npm test" } },
    { tool: "run_bash", args: { command: "git status" } },
    { tool: "run_bash", args: { command: "pnpm test --watch=false" } },
  ];
  assert.equal(pickTestCommand(steps, null), "pnpm test --watch=false");
});

test("pickTestCommand falls back to package.json test script", () => {
  const steps = [{ tool: "run_bash", args: { command: "ls -la" } }];
  assert.equal(pickTestCommand(steps, "jest --ci"), "jest --ci");
});

test("pickTestCommand returns null when nothing matches", () => {
  const steps = [{ tool: "run_bash", args: { command: "ls -la" } }];
  assert.equal(pickTestCommand(steps, null), null);
});

test("readTestScript handles absent, empty, and valid cases", () => {
  assert.equal(readTestScript(null), null);
  assert.equal(readTestScript({}), null);
  assert.equal(readTestScript({ scripts: {} }), null);
  assert.equal(readTestScript({ scripts: { test: "" } }), null);
  assert.equal(readTestScript({ scripts: { test: "jest" } }), "jest");
});

// ---------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------

test("buildReviewPrompt includes task, diff, and test summary", () => {
  const prompt = buildReviewPrompt({
    task: "Add retry handling to the fetch call.",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n",
    fileList: ["src/a.ts"],
    testSummary: "12 passed, 0 failed",
    testKeyLines: ["✓ retries on 503"],
    testExitCode: 0,
    testTimedOut: false,
    hadTests: true,
    sameProviderAsWriter: false,
  });
  assert.match(prompt, /Add retry handling/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /12 passed, 0 failed/);
  assert.match(prompt, /retries on 503/);
  assert.doesNotMatch(prompt, /same provider/);
});

test("buildReviewPrompt notes when tests did not run", () => {
  const prompt = buildReviewPrompt({
    task: "x",
    diff: "diff --git a/x b/x\n",
    fileList: ["x"],
    testSummary: null,
    testKeyLines: [],
    testExitCode: null,
    testTimedOut: false,
    hadTests: false,
    sameProviderAsWriter: false,
  });
  assert.match(prompt, /No tests were run/);
});

test("buildReviewPrompt warns about same-provider review", () => {
  const prompt = buildReviewPrompt({
    task: "x",
    diff: "diff --git a/x b/x\n",
    fileList: ["x"],
    testSummary: null,
    testKeyLines: [],
    testExitCode: null,
    testTimedOut: false,
    hadTests: false,
    sameProviderAsWriter: true,
  });
  assert.match(prompt, /same provider/);
});

// ---------------------------------------------------------------
// parseReviewResponse
// ---------------------------------------------------------------

test("parseReviewResponse accepts clean JSON", () => {
  const verdict = parseReviewResponse(
    '{"verdict":"pass","issues":[]}',
  );
  assert.deepEqual(verdict, { verdict: "pass", issues: [] });
});

test("parseReviewResponse accepts fenced JSON", () => {
  const verdict = parseReviewResponse(
    '```json\n{"verdict":"concerns","issues":[{"file":"a.ts","severity":"medium","note":"x"}]}\n```',
  );
  assert.equal(verdict?.verdict, "concerns");
  assert.equal(verdict?.issues.length, 1);
});

test("parseReviewResponse extracts JSON from prose", () => {
  const verdict = parseReviewResponse(
    'Here is my review: {"verdict":"pass","issues":[]} — done.',
  );
  assert.equal(verdict?.verdict, "pass");
});

test("parseReviewResponse returns null on garbage", () => {
  assert.equal(parseReviewResponse("not json"), null);
  assert.equal(parseReviewResponse("{}"), null);
  assert.equal(parseReviewResponse('{"verdict":"maybe","issues":[]}'), null);
});

test("parseReviewResponse caps the issue list", () => {
  const issues = Array.from({ length: 30 }, (_, i) => ({
    file: `f${i}.ts`,
    severity: "low",
    note: "n",
  }));
  const verdict = parseReviewResponse(
    JSON.stringify({ verdict: "concerns", issues }),
  );
  assert.equal(verdict?.issues.length, 10);
});

test("parseReviewResponse drops invalid issues and keeps valid ones", () => {
  const verdict = parseReviewResponse(
    JSON.stringify({
      verdict: "concerns",
      issues: [
        { file: "", severity: "high", note: "x" },
        { file: "a.ts", severity: "wrong", note: "x" },
        { file: "b.ts", severity: "low", note: "y" },
      ],
    }),
  );
  assert.equal(verdict?.issues.length, 1);
  assert.equal(verdict?.issues[0].file, "b.ts");
});

test("parseReviewResponse upgrades pass to concerns when issues exist", () => {
  const verdict = parseReviewResponse(
    JSON.stringify({
      verdict: "pass",
      issues: [{ file: "a.ts", severity: "high", note: "x" }],
    }),
  );
  assert.equal(verdict?.verdict, "concerns");
});

// ---------------------------------------------------------------
// mergeIssues and hasActionableIssue
// ---------------------------------------------------------------

test("mergeIssues prioritizes harness issues and dedupes", () => {
  const harness: ReviewIssue[] = [
    { file: "(tests)", severity: "high", note: "exit 1" },
  ];
  const reviewer: ReviewIssue[] = [
    { file: "(tests)", severity: "low", note: "exit 1" },
    { file: "a.ts", severity: "medium", note: "scope" },
  ];
  const merged = mergeIssues(reviewer, harness);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].severity, "high");
});

test("hasActionableIssue ignores low-only sets", () => {
  assert.equal(
    hasActionableIssue([{ file: "a", severity: "low", note: "x" }]),
    false,
  );
  assert.equal(
    hasActionableIssue([{ file: "a", severity: "medium", note: "x" }]),
    true,
  );
  assert.equal(hasActionableIssue([]), false);
});

// ---------------------------------------------------------------
// harnessIssuesFromTests
// ---------------------------------------------------------------

test("harnessIssuesFromTests flags a failing test run as high", () => {
  const issues = harnessIssuesFromTests({
    hadTests: true,
    testTimedOut: false,
    testExitCode: 1,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "high");
});

test("harnessIssuesFromTests flags a timeout as high", () => {
  const issues = harnessIssuesFromTests({
    hadTests: true,
    testTimedOut: true,
    testExitCode: 124,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "high");
});

test("harnessIssuesFromTests returns nothing on passing tests", () => {
  const issues = harnessIssuesFromTests({
    hadTests: true,
    testTimedOut: false,
    testExitCode: 0,
  });
  assert.equal(issues.length, 0);
});

test("harnessIssuesFromTests returns nothing when no tests exist", () => {
  const issues = harnessIssuesFromTests({
    hadTests: false,
    testTimedOut: false,
    testExitCode: null,
  });
  assert.equal(issues.length, 0);
});

// ---------------------------------------------------------------
// buildFixRoundMessage
// ---------------------------------------------------------------

test("buildFixRoundMessage lists only actionable issues", () => {
  const message = buildFixRoundMessage([
    { file: "a.ts", severity: "low", note: "style" },
    { file: "b.ts", severity: "medium", note: "scope" },
    { file: "c.ts", severity: "high", note: "wrong" },
  ]);
  assert.match(message, /b\.ts/);
  assert.match(message, /c\.ts/);
  assert.doesNotMatch(message, /style/);
});

// ---------------------------------------------------------------
// PR body helpers
// ---------------------------------------------------------------

test("reviewConcernsStatusLine says fix attempted or skipped", () => {
  const issues: ReviewIssue[] = [
    { file: "a", severity: "high", note: "x" },
    { file: "b", severity: "low", note: "y" },
  ];
  assert.match(
    reviewConcernsStatusLine({ fixRoundAttempted: true, issues }),
    /1 issue; fix round attempted/,
  );
  assert.match(
    reviewConcernsStatusLine({ fixRoundAttempted: false, issues }),
    /fix round skipped/,
  );
});

test("formatIssuesTable escapes pipes and newlines", () => {
  const table = formatIssuesTable([
    { file: "a|b.ts", severity: "high", note: "line1\nline2" },
  ]);
  assert.match(table, /a\\\|b\.ts/);
  assert.match(table, /line1 line2/);
});

// ---------------------------------------------------------------
// truncateDiff and filesFromDiff
// ---------------------------------------------------------------

test("truncateDiff keeps short diffs intact", () => {
  const diff = "diff --git a/a b/a\n+1\n";
  assert.equal(truncateDiff(diff, 1000, 5000), diff);
});

test("truncateDiff truncates per file", () => {
  const big = "x".repeat(500);
  const diff =
    `diff --git a/a b/a\n${big}\n` +
    `diff --git a/b b/b\nsmall\n`;
  const out = truncateDiff(diff, 100, 5000);
  assert.match(out, /file diff truncated/);
  assert.match(out, /diff --git a\/b b\/b/);
});

test("filesFromDiff extracts unique paths in order", () => {
  const diff =
    "diff --git a/x.ts b/x.ts\n" +
    "index 1..2 100644\n" +
    "diff --git a/y/z.ts b/y/z.ts\n" +
    "index 3..4 100644\n" +
    "diff --git a/x.ts b/x.ts\n";
  assert.deepEqual(filesFromDiff(diff), ["x.ts", "y/z.ts"]);
});