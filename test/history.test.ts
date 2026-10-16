import assert from "node:assert/strict";
import test from "node:test";
import {
  compressHistory,
  estimateTokens,
  type HistoryMessage,
  type HistoryStep,
  COMPRESSED_PREFIX,
  MIN_STEPS_BETWEEN,
} from "../src/history.js";

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

const START_SHA = "abc123def456";

/** Pad the task message past MIN_ESTIMATED_TOKENS so the size gate opens. */
const PAD = "x".repeat(30_000);

function freshHistory(task = "Do the thing."): HistoryMessage[] {
  return [{ role: "user", parts: [{ text: `Task: ${task}\n${PAD}` }] }];
}

/**
 * Build a history of N tool-result pairs, all older than RECENT_KEEP so
 * they are eligible for stubbing. The last `recent` messages stay verbatim.
 */
function historyWithSteps(steps: HistoryStep[], recent: number = 0): HistoryMessage[] {
  const history = freshHistory();
  for (const step of steps) {
    history.push({
      role: "model",
      parts: [{ text: JSON.stringify({ tool: step.tool, args: step.args }) }],
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
  // Add `recent` no-op messages so the newest steps fall outside the cutoff.
  for (let i = 0; i < recent; i++) {
    history.push({
      role: "model",
      parts: [{ text: JSON.stringify({ tool: "run_bash", args: {} }) }],
    });
    history.push({
      role: "user",
      step: -1 - i,
      parts: [{ text: "Tool result (ok):\nrecent" }],
    });
  }
  return history;
}

function readStep(
  step: number,
  path: string,
  output: string,
  opts: { ok?: boolean; outputBytes?: number; outputLines?: number } = {},
): HistoryStep {
  return {
    step,
    tool: "read_file",
    args: { path },
    result: {
      ok: opts.ok ?? true,
      output,
      outputBytes: opts.outputBytes,
      outputLines: opts.outputLines,
    },
  };
}

function writeStep(step: number, path: string): HistoryStep {
  return {
    step,
    tool: "request_write",
    args: { path },
    result: { ok: true, output: `wrote ${path}` },
  };
}

function bashStep(
  step: number,
  command: string,
  output: string,
  opts: {
    ok?: boolean;
    exitCode?: number;
    keyLines?: string[];
    keyLinesTotal?: number;
    testSummary?: string;
  } = {},
): HistoryStep {
  return {
    step,
    tool: "run_bash",
    args: { command },
    result: {
      ok: opts.ok ?? true,
      output,
      exitCode: opts.exitCode,
      keyLines: opts.keyLines,
      keyLinesTotal: opts.keyLinesTotal,
      testSummary: opts.testSummary,
    },
  };
}

function commitStep(step: number, message: string): HistoryStep {
  return {
    step,
    tool: "git_commit",
    args: { message },
    result: { ok: true, output: "[main abc123] " + message },
  };
}

// ---------------------------------------------------------------
// Gate tests
// ---------------------------------------------------------------

test("fires on size alone when steps are below the minimum", () => {
  const steps = [
    readStep(1, "src/a.ts", "body\n".repeat(100), {
      outputBytes: 500,
      outputLines: 100,
    }),
  ];
  const history = historyWithSteps(steps, 6);

  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN - 1, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, true);
  const msg = history.find((m) => m.step === 1);
  assert.ok(msg);
  assert.match(msg.parts[0].text, /\[compressed\]/);
});

test("does nothing when neither gate is met", () => {
  const steps = [readStep(1, "src/a.ts", "body")];
  const history: HistoryMessage[] = [
    { role: "user", parts: [{ text: "Task: small." }] },
    {
      role: "model",
      parts: [{ text: JSON.stringify({ tool: "read_file", args: { path: "src/a.ts" } }) }],
    },
    {
      role: "user",
      step: 1,
      parts: [{ text: "Tool result (ok):\nbody" }],
    },
    { role: "model", parts: [{ text: "{}" }] },
    { role: "user", step: 2, parts: [{ text: "Tool result (ok):\nbody" }] },
    { role: "model", parts: [{ text: "{}" }] },
  ];

  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: 0, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, false);
});

test("does nothing when estimated tokens are below the threshold", () => {
  const steps = [readStep(1, "src/a.ts", "body")];
  const history: HistoryMessage[] = [
    { role: "user", parts: [{ text: "Task: small." }] },
    {
      role: "model",
      parts: [{ text: JSON.stringify({ tool: "read_file", args: { path: "src/a.ts" } }) }],
    },
    {
      role: "user",
      step: 1,
      parts: [{ text: "Tool result (ok):\nbody" }],
    },
    { role: "model", parts: [{ text: "{}" }] },
    { role: "user", step: 2, parts: [{ text: "Tool result (ok):\nbody" }] },
    { role: "model", parts: [{ text: "{}" }] },
  ];

  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, false);
});

// ---------------------------------------------------------------
// read_file stubbing
// ---------------------------------------------------------------

test("stubs an old read_file with the recorded size", () => {
  const output = "line\n".repeat(100);
  const steps = [readStep(1, "src/a.ts", output, { outputBytes: 500, outputLines: 100 })];
  const history = historyWithSteps(steps, 6);

  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, true);
  const msg = history.find((m) => m.step === 1);
  assert.ok(msg);
  assert.match(msg.parts[0].text, /\[compressed\] read src\/a\.ts/);
  assert.match(msg.parts[0].text, /100 lines, 500 bytes/);
  assert.match(msg.parts[0].text, /Re-read with read_file/);
});

test("keeps a fresh pre-edit read verbatim", () => {
  const output = "export const a = 1;\n";
  const steps: HistoryStep[] = [
    readStep(1, "src/a.ts", output, { outputBytes: 20, outputLines: 1 }),
    writeStep(2, "src/a.ts"),
  ];
  const history = historyWithSteps(steps, 6);

  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  const readMsg = history.find((m) => m.step === 1);
  assert.ok(readMsg);
  assert.equal(readMsg.parts[0].text.includes("export const a = 1;"), true);
});

test("stubs a healed pre-edit read with a git show hint", () => {
  const output = "export const a = 1;\n".repeat(50);
  const steps: HistoryStep[] = [
    readStep(1, "src/a.ts", output, { outputBytes: 1000, outputLines: 50 }),
    writeStep(2, "src/a.ts"),
    commitStep(3, "omah: fix"),
  ];
  const history = historyWithSteps(steps, 6);

  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, true);
  const readMsg = history.find((m) => m.step === 1);
  assert.ok(readMsg);
  assert.match(readMsg.parts[0].text, /git show abc123def456:src\/a\.ts/);
});

// ---------------------------------------------------------------
// run_bash stubbing
// ---------------------------------------------------------------

test("preserves the recorded key lines for a long run_bash", () => {
  const head = Array.from({ length: 15 }, (_, i) => `head ${i}`).join("\n");
  const tail = Array.from({ length: 25 }, (_, i) => `tail ${i}`).join("\n");
  const output = `${head}\n${tail}`;
  const steps = [
    bashStep(1, "pnpm test", output, {
      exitCode: 1,
      keyLines: ["✗ login.test.ts > rejects bad password", "AssertionError: expected 401"],
      keyLinesTotal: 2,
    }),
  ];
  const history = historyWithSteps(steps, 6);

  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, true);
  const msg = history.find((m) => m.step === 1);
  assert.ok(msg);
  assert.match(msg.parts[0].text, /exit 1/);
  assert.match(msg.parts[0].text, /login\.test\.ts > rejects bad password/);
  assert.match(msg.parts[0].text, /AssertionError/);
});

test("prints (+N more matching lines) when the digest was capped", () => {
  const head = Array.from({ length: 15 }, (_, i) => `head ${i}`).join("\n");
  const tail = Array.from({ length: 25 }, (_, i) => `tail ${i}`).join("\n");
  const output = `${head}\n${tail}`;
  const steps = [
    bashStep(1, "pnpm test", output, {
      keyLines: ["fail one", "fail two", "fail three"],
      keyLinesTotal: 20,
    }),
  ];
  const history = historyWithSteps(steps, 6);

  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  const msg = history.find((m) => m.step === 1);
  assert.ok(msg);
  assert.match(msg.parts[0].text, /\+17 more matching lines/);
});

// ---------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------

test("appends a ledger to the task message without clobbering it", () => {
  const steps: HistoryStep[] = [
    readStep(1, "src/a.ts", "body\n".repeat(50), { outputBytes: 300, outputLines: 50 }),
    writeStep(2, "src/b.ts"),
    commitStep(3, "omah: add b"),
  ];
  const history = historyWithSteps(steps, 6);
  const originalTask = history[0].parts[0].text;

  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  const head = history[0].parts[0].text;
  assert.match(head, /^Task: Do the thing\./);
  assert.equal(head.includes(originalTask.split("\n\nProgress so far:")[0]), true);
  assert.match(head, /Progress so far: read src\/a\.ts; wrote src\/b\.ts; committed "omah: add b"/);
});

test("refreshes the ledger on a second pass instead of duplicating it", () => {
  const steps: HistoryStep[] = [
    readStep(1, "src/a.ts", "body\n".repeat(50), { outputBytes: 300, outputLines: 50 }),
    writeStep(2, "src/b.ts"),
  ];
  const history = historyWithSteps(steps, 6);

  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );
  const afterFirst = history[0].parts[0].text;
  const countFirst = (afterFirst.match(/Progress so far:/g) ?? []).length;
  assert.equal(countFirst, 1);

  // Add another step and compress again.
  steps.push(commitStep(3, "omah: add b"));
  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 1 },
  );

  const afterSecond = history[0].parts[0].text;
  const countSecond = (afterSecond.match(/Progress so far:/g) ?? []).length;
  assert.equal(countSecond, 1);
  assert.match(afterSecond, /committed "omah: add b"/);
});

// ---------------------------------------------------------------
// Safety
// ---------------------------------------------------------------

test("skips messages without a step number", () => {
  const steps = [readStep(1, "src/a.ts", "body\n".repeat(50))];
  const history = historyWithSteps(steps, 6);
  // Add a stray user message with no step.
  const stray: HistoryMessage = {
    role: "user",
    parts: [{ text: "Tool result (ok):\nstray" }],
  };
  history.splice(1, 0, stray);

  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  assert.equal(stray.parts[0].text, "Tool result (ok):\nstray");
});

test("leaves already-compressed messages alone", () => {
  const steps = [readStep(1, "src/a.ts", "body\n".repeat(50))];
  const history = historyWithSteps(steps, 6);
  const already = `${COMPRESSED_PREFIX}read src/a.ts: 50 lines, 300 bytes. Re-read with read_file if needed.`;
  const msg = history.find((m) => m.step === 1);
  assert.ok(msg);
  msg.parts[0].text = already;

  compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: MIN_STEPS_BETWEEN, compressionsDone: 0 },
  );

  assert.equal(msg.parts[0].text, already);
});

test("estimateTokens uses chars-per-token", () => {
  const history: HistoryMessage[] = [{ role: "user", parts: [{ text: "abcd".repeat(250) }] }];
  assert.equal(estimateTokens(history), 250);
});

// ---------------------------------------------------------------
// Realistic history reproduction
// ---------------------------------------------------------------

test("compresses a realistic 14-step history and preserves anchors", () => {
  // Mirrors the shape of a real run: an initial listing, a few small
  // reads, two medium reads, one large read, and a bash call with a
  // digest. Not every step is unique; the loop tends to repeat small
  // lookups and re-run commands after edits.
  const readmeBody = "Zorx CLI\n\nA smart CLI tool for rapid project scaffolding...\n".repeat(60);
  const lockBody = "lockfileVersion: '9.0'\npackages:\n".repeat(200);
  const reviewBody = "# Code Review: Zorx CLI\n\n".repeat(400);

  const steps: HistoryStep[] = [
    bashStep(1, "ls -la", "total 144\ndrwxr-xr-x .git\n-rw-r--r-- README.md\n", {
      exitCode: 0,
    }),
    bashStep(2, "find . -maxdepth 1 -type f", "./README.md\n./package.json\n", {
      exitCode: 0,
    }),
    readStep(3, ".gitignore", "node_modules/*\n", { outputBytes: 14, outputLines: 0 }),
    readStep(4, "README.md", readmeBody, {
      outputBytes: readmeBody.length,
      outputLines: readmeBody.split("\n").length,
    }),
    readStep(5, "package.json", '{\n  "name": "zorx-cli"\n}\n', {
      outputBytes: 30,
      outputLines: 3,
    }),
    readStep(6, "pnpm-lock.yaml", lockBody, {
      outputBytes: lockBody.length,
      outputLines: lockBody.split("\n").length,
    }),
    readStep(7, "review.md", reviewBody, {
      outputBytes: reviewBody.length,
      outputLines: reviewBody.split("\n").length,
    }),
    bashStep(
      8,
      "wc -l .gitignore README.md package.json pnpm-lock.yaml review.md",
      "     0 .gitignore\n   196 README.md\n    55 package.json\n  2918 pnpm-lock.yaml\n   165 review.md\n",
      { exitCode: 0 },
    ),
    bashStep(
      9,
      "pnpm test",
      "PASS src/a.test.js\nFAIL src/b.test.js\n  ✗ rejects bad input\n1 failed, 3 passed\n",
      {
        exitCode: 1,
        keyLines: ["✗ rejects bad input"],
        keyLinesTotal: 1,
        testSummary: "1 failed, 3 passed",
      },
    ),
    writeStep(10, "SMOKE.md"),
    commitStep(11, "Add SMOKE.md"),
    bashStep(12, "git log --oneline -3", "31769b7 Add SMOKE.md\n", { exitCode: 0 }),
    bashStep(13, "git status", "nothing to commit, working tree clean\n", { exitCode: 0 }),
    readStep(14, "SMOKE.md", "| file | lines |\n| README.md | 196 |\n", {
      outputBytes: 40,
      outputLines: 2,
    }),
  ];

  const history = historyWithSteps(steps, 5);
  const before = estimateTokens(history);

  // At the top of the loop after 14 steps, the gate is wide open.
  const result = compressHistory(
    history,
    steps,
    { startSha: START_SHA },
    { stepsSinceLastCompress: 14, compressionsDone: 0 },
  );

  assert.equal(result.didCompress, true);

  const after = estimateTokens(history);
  assert.ok(after < before * 0.75, `expected at least 25% reduction, got ${before} -> ${after}`);

  // Anchors the model needs after compression.
  const allText = history.map((m) => m.parts[0].text).join("\n");
  assert.match(allText, /pnpm-lock\.yaml/);
  assert.match(allText, /review\.md/);
  assert.match(allText, /SMOKE\.md/);
  assert.match(allText, /last test: 1 failed, 3 passed/);
});
