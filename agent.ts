// agent.ts
// Entry point for Omah. Orchestrates a run: sets up the workspace,
// invokes the agent loop, runs the review gate, pushes a branch, and
// opens a PR.

import { promises as fs, appendFileSync } from "node:fs";
import ignore from "ignore";
import { createSign } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRunEntry, type RunEntry } from "./src/runlog.js";
import { makeProvider, classifyError, type KeySpec } from "./src/llm.js";
import { loadState, saveState, addRepo, fingerprint } from "./src/keystate.js";
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
  scanDiffForIssues,
  truncateDiff,
  type DiffScanResult,
  type ReviewIssue,
} from "./src/review.js";
import {
  WALL_CLOCK_MS,
  MAX_PATCH_BYTES,
  MAX_PR_BODY_CHARS,
  REVIEW_MAX_DIFF_BYTES,
  REVIEW_MAX_FILE_DIFF_BYTES,
  REVIEW_TEST_TIMEOUT_MS,
  REVIEW_MIN_REMAINING_MS,
  REVIEW_FIX_BUDGET_MS,
  REVIEW_MAX_CALLS,
  OMAH_ROOT,
  SYSTEM_PROMPT_PATH,
  REVIEWER_SYSTEM_PROMPT_PATH,
  AGENT_USER,
} from "./src/config.js";
import type { Conversation } from "./src/types.js";
import {
  log,
  requireEnv,
  setOutput,
  shortId,
  slugify,
  newConversation,
  saveConversation,
  loadConversation,
  prepareWorkspaceForAgent,
  configureGitIdentityAsAgent,
  readIgnorePatternsAtStartup,
  readRepoIgnorePatterns,
  applyIgnoreList,
  loadKeys,
  asAgent,
  asOrchestrator,
  asAgentBuffer,
  gitAuthEnv,
} from "./src/infra.js";
import { runLoop, type RunLoopResult } from "./src/loop.js";
import { runBashWithDetach, buildBashDigest } from "./src/tools.js";
import {
  usageLog,
  keyStats,
  persistedState,
  setPersistedState,
  metaToken,
  setMetaToken,
  stateLoadOk,
  setStateLoadOk,
  stateSaved,
  setStateSaved,
  lastUsedProvider,
} from "./src/state.js";

// ---------------------------------------------------------------
// Entry
// ---------------------------------------------------------------

async function main(): Promise<void> {
  const runStarted = Date.now();
  let setupMs = 0;
  let reviewMs = 0;
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
      setMetaToken(await mintAppToken(appJwt, metaRepo));
      console.log(`::add-mask::${metaToken}`);
    } catch (e: any) {
      await log(`keystate: no meta token (${e?.message ?? e}); persistence disabled`);
    }
  } else {
    await log("keystate: OMAH_META_REPO not set; persistence disabled");
  }

  if (metaToken) {
    const loaded = await loadState(metaToken, log);
    setPersistedState(loaded.state);
    setStateLoadOk(loaded.ok);
    await log(
      `keystate: loaded ${Object.keys(persistedState.keys.keys).length} keys, ` +
        `${persistedState.repos.repos.length} repos (ok=${stateLoadOk})`,
    );
  }

  if (addRepo(persistedState, targetRepo)) {
    await log(`keystate: new target repo "${targetRepo}" will be recorded`);
  }

  const { appSlug } = await resolveAppIdentity(appJwt);

  const authorName = process.env.AUTHOR_NAME || appSlug;
  const authorEmail = process.env.AUTHOR_EMAIL || `${appSlug}[bot]@users.noreply.github.com`;

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
    baseBranch = process.env.INPUT_BASE_BRANCH?.trim() || repoInfo.default_branch;
  } else {
    taskText = requireEnv("INPUT_TASK");
    baseBranch = process.env.INPUT_BASE_BRANCH?.trim() || repoInfo.default_branch;
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
  await configureGitIdentityAsAgent(authorName, authorEmail);

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
    `loaded ${keys.length} keys: ` + keys.map((k, i) => `${i + 1}=${k.provider}`).join(", "),
  );

  const cooldownUntil = new Map<number, number>();
  let reviewOutcome: "skipped" | "pass" | "concerns" = "skipped";
  let fixRoundRan = false;
  let reviewIssueCount = 0;
  let pushedSha: string | undefined;
  let pushedTree: string | undefined;

  const resumeText = process.env.INPUT_RESUME_TEXT?.trim() || "";

  let result: RunLoopResult;
  try {
    result = await runLoop(
      {
        systemPrompt,
        task: taskText,
        resumeText,
        conversation,
        keys,
        targetRepo,
        branchName,
        appToken,
        startSha,
      },
      { cooldownUntil },
    );
  } finally {
    if (metaToken && stateLoadOk && !stateSaved) {
      setStateSaved(true);
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

  const reviewStart = Date.now();
  if (result.status === "done" && !conversation.reviewConcerns) {
    const outcome = await runReviewGate({
      conversation,
      startSha,
      appToken,
      keys,
      targetRepo,
      branchName,
      runStartedAt: runStarted,
      cooldownUntil,
    });
    if (outcome.ran && outcome.issues.length > 0) {
      conversation.reviewIssues = outcome.issues;
    }

    if (!outcome.ran) {
      reviewOutcome = "skipped";
    } else if (hasActionableIssue(outcome.issues)) {
      reviewOutcome = "concerns";
      reviewIssueCount = outcome.issues.length;
    } else {
      reviewOutcome = "pass";
      reviewIssueCount = outcome.issues.length;
    }
    if (outcome.reenter) fixRoundRan = true;

    if (outcome.reenter) {
      await log("[review] re-entering loop for fix round");
      conversation.reviewConcerns = true;
      await saveConversation(conversation, targetRepo, appToken);
      const fixResult = await runLoop(
        {
          systemPrompt,
          task: conversation.taskText,
          resumeText: outcome.fixMessage,
          conversation,
          keys,
          targetRepo,
          branchName,
          appToken,
          startSha,
        },
        { maxRuntimeMs: REVIEW_FIX_BUDGET_MS, cooldownUntil },
      );
      result = fixResult;
      conversation.summary = fixResult.summary;
      conversation.status = fixResult.status;
      await saveConversation(conversation, targetRepo, appToken);
    } else if (outcome.ran && hasActionableIssue(outcome.issues)) {
      conversation.reviewConcerns = true;
      await saveConversation(conversation, targetRepo, appToken);
    }
  }

  let refuseToPush = false;
  {
    const scanResult = await scanWorkspaceDiffForSecrets(startSha);
    for (const secret of scanResult.secrets) {
      console.log(`::add-mask::${secret}`);
    }
    if (scanResult.secrets.length > 0) {
      const names = scanResult.issues
        .filter((i) => i.severity === "high")
        .map((i) => i.file)
        .join(", ");
      await log(
        `[push] refusing to push: possible secret(s) in ${names}. ` + `Remove them and re-run.`,
      );
      refuseToPush = true;
      result = {
        summary: `Refusing to push: possible secrets remain in ${names}. Remove them and re-run.`,
        status: "blocked",
        compressionsDone: result.compressionsDone,
      };
      conversation.summary = result.summary;
      conversation.status = result.status;
      await saveConversation(conversation, targetRepo, appToken);
    }
  }

  reviewMs = Date.now() - reviewStart;

  if (process.env.OMAH_SCRIPT) {
    try {
      await fs.writeFile("/tmp/omah-attack/pkill-ran", "1");
    } catch {}
  }
  await asOrchestrator("sudo", ["pkill", "-9", "-u", AGENT_USER]);

  let prUrl = "";
  if (refuseToPush) {
    await log("no push: refusing due to secret findings");
    setOutput("status", result.status);
  } else {
    const pushStart = Date.now();
    const pushResult = await pushPatchAndOpenPR({
      appToken,
      targetRepo,
      baseBranch,
      branchName,
      conversation,
      startSha,
      authorName,
      authorEmail,
      ignorePatterns: mergedPatterns,
      reviewConcerns: Boolean(conversation.reviewConcerns),
    });
    pushMs = Date.now() - pushStart;
    prUrl = pushResult.url;
    pushedSha = pushResult.sha;
    pushedTree = pushResult.tree;

    if (prUrl) {
      setOutput("pr_url", prUrl);
    }
    setOutput("status", result.status);
  }

  await log(`done. pr=${prUrl || "(none)"} status=${result.status}`);

  await writeRunEntry({
    conversation,
    result,
    keys,
    reviewOutcome,
    reviewIssueCount,
    fixRoundRan,
    runStarted,
    setupMs,
    reviewMs,
    pushMs,
    prUrl,
    pushedSha,
    pushedTree,
  });
}

// ---------------------------------------------------------------
// Review gate
// ---------------------------------------------------------------

interface ReviewGateArgs {
  conversation: Conversation;
  startSha: string;
  appToken: string;
  keys: KeySpec[];
  targetRepo: string;
  branchName: string;
  runStartedAt: number;
  cooldownUntil: Map<number, number>;
}

interface ReviewGateOutcome {
  ran: boolean;
  reenter: boolean;
  fixMessage: string;
  issues: ReviewIssue[];
}

async function runReviewGate(args: ReviewGateArgs): Promise<ReviewGateOutcome> {
  const skip = async (reason: string): Promise<ReviewGateOutcome> => {
    await log(`[review] skipped: ${reason}`);
    return { ran: false, reenter: false, fixMessage: "", issues: [] };
  };

  let reviewerSystemPrompt: string;
  try {
    reviewerSystemPrompt = await fs.readFile(REVIEWER_SYSTEM_PROMPT_PATH, "utf8");
  } catch (err: any) {
    return skip(
      `reviewer system prompt not readable: ${String(err?.message ?? err).slice(0, 120)}`,
    );
  }

  const remaining = WALL_CLOCK_MS - (Date.now() - args.runStartedAt);
  if (remaining < REVIEW_MIN_REMAINING_MS) {
    return skip(`only ${Math.round(remaining / 1000)}s left`);
  }
  if (args.keys.length === 0) return skip("no keys available");

  const beforePaths = await listChangedPaths();

  const pkg = await readPackageJson();
  const testScript = readTestScript(pkg);
  const command = pickTestCommand(
    args.conversation.steps.map((s) => ({ tool: s.tool, args: s.args })),
    testScript,
  );

  let testExitCode: number | null = null;
  let testTimedOut = false;
  let testSummary: string | null = null;
  let testKeyLines: string[] = [];
  const hadTests = command !== null;

  if (hadTests && command) {
    await log(`[review] running tests: ${command}`);
    const result = await runBashWithDetach(command, REVIEW_TEST_TIMEOUT_MS);
    testExitCode = result.code;
    testTimedOut = result.code === 124;
    if (!testTimedOut) {
      const output = `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      const digest = buildBashDigest(output, result.code);
      testSummary = digest.testSummary ?? null;
      testKeyLines = digest.keyLines ?? [];
    }
    await log(
      `[review] test exit=${testExitCode} timedOut=${testTimedOut} ` +
        `keyLines=${testKeyLines.length}`,
    );
  } else {
    await log("[review] no test command; skipping test run");
  }

  await revertNewChanges(beforePaths);

  const diffResult = await asAgentBuffer("git", [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    args.startSha,
    "--",
  ]);
  if (diffResult.code !== 0) {
    return skip(`diff failed: ${diffResult.stderr.slice(0, 120)}`);
  }
  const rawDiff = diffResult.stdout.toString("utf8");
  const filtered = rawDiff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => !chunk.startsWith("diff --git a/.git/"))
    .join("");
  const diff = truncateDiff(filtered, REVIEW_MAX_FILE_DIFF_BYTES, REVIEW_MAX_DIFF_BYTES);
  const fileList = filesFromDiff(diff);

  await log(
    `[review] diff: ${Buffer.byteLength(diff, "utf8")} bytes, ` +
      `${fileList.length} file(s)${fileList.length > 0 ? ": " + fileList.join(", ") : ""}`,
  );

  if (diff.trim().length === 0) {
    return skip("empty diff");
  }

  const scan = scanDiffForIssues(diff, args.conversation.taskText);
  for (const secret of scan.secrets) {
    console.log(`::add-mask::${secret}`);
  }
  const lowCount = scan.issues.filter((i) => i.severity === "low").length;
  const highCount = scan.issues.filter((i) => i.severity === "high").length;
  await log(`[review] scan: ${highCount} secret(s) redacted, ${lowCount} debug/TODO line(s)`);

  const prompt = buildReviewPrompt({
    task: args.conversation.taskText,
    diff,
    fileList,
    testSummary,
    testKeyLines,
    testExitCode,
    testTimedOut,
    hadTests,
    sameProviderAsWriter: false,
  });

  const call = await callReviewerWithRotation(
    args.keys,
    args.cooldownUntil,
    reviewerSystemPrompt,
    prompt,
  );
  if (!call) return skip("reviewer call failed on all attempted keys");
  const sameProviderAsWriter = lastUsedProvider !== null && call.provider === lastUsedProvider;
  if (sameProviderAsWriter) {
    await log(`[review] warning: reviewed by same provider as writer (${call.provider})`);
  }

  const verdict = parseReviewResponse(call.text);
  if (!verdict) {
    await log("[review] could not parse reviewer response; skipping");
    return skip("could not parse reviewer response");
  }

  const harnessIssues = harnessIssuesFromTests({
    hadTests,
    testTimedOut,
    testExitCode,
  });
  const merged = mergeIssues(verdict.issues, [...harnessIssues, ...scan.issues]);

  await log(
    `[review] verdict=${verdict.verdict} issues=${merged.length} ` +
      `actionable=${hasActionableIssue(merged)}`,
  );

  if (!hasActionableIssue(merged)) {
    return { ran: true, reenter: false, fixMessage: "", issues: merged };
  }

  const remainingForFix = WALL_CLOCK_MS - (Date.now() - args.runStartedAt);
  if (remainingForFix < REVIEW_MIN_REMAINING_MS) {
    await log(
      `[review] concerns found, but only ${Math.round(remainingForFix / 1000)}s left; ` +
        `opening as draft without a fix round`,
    );
    return { ran: true, reenter: false, fixMessage: "", issues: merged };
  }

  return {
    ran: true,
    reenter: true,
    fixMessage: buildFixRoundMessage(merged),
    issues: merged,
  };
}

async function callReviewerWithRotation(
  keys: KeySpec[],
  cooldownUntil: Map<number, number>,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; provider: string } | null> {
  const now = Date.now();
  const isCooled = (index: number) => (cooldownUntil.get(index) ?? 0) > now;

  const different: number[] = [];
  const same: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (isCooled(i)) continue;
    if (lastUsedProvider && keys[i].provider === lastUsedProvider) {
      same.push(i);
    } else {
      different.push(i);
    }
  }
  const ordered = [...different, ...same];

  const attempts = Math.min(ordered.length, REVIEW_MAX_CALLS);
  if (attempts === 0) {
    await log("[review] no uncooled keys available");
    return null;
  }

  for (let i = 0; i < attempts; i++) {
    const keyIndex = ordered[i];
    const spec = keys[keyIndex];
    try {
      const provider = makeProvider(spec);
      const response = await provider.complete(
        {
          systemPrompt,
          history: [{ role: "user", content: userPrompt }],
          jsonMode: true,
        },
        keyIndex,
      );
      await log(`[review] called ${spec.provider} (key ${keyIndex + 1})`);
      return { text: response.text, provider: spec.provider };
    } catch (err: any) {
      const kind = classifyError(err);
      const status = (err as any)?.status ?? "?";
      await log(
        `[review] key ${keyIndex + 1} (${spec.provider}) failed: ${kind} ` +
          `[${status}] ${String(err?.message ?? err).slice(0, 100)}`,
      );
      if (kind === "quota" || kind === "retryable") {
        const wait = Number((err as any)?.retryAfterMs ?? 60_000);
        cooldownUntil.set(keyIndex, Date.now() + wait);
      } else if (kind === "rotate") {
        cooldownUntil.set(keyIndex, Number.POSITIVE_INFINITY);
      }
      continue;
    }
  }
  return null;
}

async function scanWorkspaceDiffForSecrets(startSha: string): Promise<DiffScanResult> {
  const diffResult = await asAgentBuffer("git", [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    startSha,
    "--",
  ]);
  if (diffResult.code !== 0) {
    return { issues: [], secrets: [] };
  }
  const raw = diffResult.stdout.toString("utf8");
  const filtered = raw
    .split(/^(?=diff --git )/m)
    .filter((chunk) => !chunk.startsWith("diff --git a/.git/"))
    .join("");
  return scanDiffForIssues(filtered, "");
}

async function listChangedPaths(): Promise<Set<string>> {
  const { stdout } = await asAgent("git", ["status", "--porcelain"]);
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const p = line.slice(3).trim();
    if (p) paths.add(p);
  }
  return paths;
}

async function revertNewChanges(before: Set<string>): Promise<void> {
  const after = await listChangedPaths();
  const reverted: string[] = [];
  for (const p of after) {
    if (before.has(p)) continue;
    await asAgent("git", ["checkout", "--", p]).catch(() => {});
    await asAgent("rm", ["-f", p]).catch(() => {});
    reverted.push(p);
  }
  if (reverted.length > 0) {
    await log(`[review] reverted ${reverted.length} test side-effect path(s)`);
  }
}

async function readPackageJson(): Promise<unknown> {
  try {
    const { stdout, code } = await asAgent("cat", ["package.json"]);
    if (code !== 0) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Push and PR
// ---------------------------------------------------------------

interface PushArgs {
  appToken: string;
  targetRepo: string;
  baseBranch: string;
  branchName: string;
  conversation: Conversation;
  startSha: string;
  authorName: string;
  authorEmail: string;
  ignorePatterns: string[];
  reviewConcerns: boolean;
}

interface PushResult {
  url: string;
  sha?: string;
  tree?: string;
}

async function pushPatchAndOpenPR(args: PushArgs): Promise<PushResult> {
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

  r = await asOrchestrator("git", ["fetch", "--depth", "1", "origin", args.startSha], {
    cwd: pushClone,
    env: cloneEnv,
  });
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
  const applyResult = await asOrchestrator("git", ["apply", "--index", tmpPatch], {
    cwd: pushClone,
  });
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
      `user.name=${args.authorName}`,
      "-c",
      `user.email=${args.authorEmail}`,
      "commit",
      "-m",
      commitMsg,
    ],
    { cwd: pushClone },
  );
  if (commitResult.code !== 0) {
    throw new Error(`commit failed: ${commitResult.stderr}`);
  }

  const shaResult = await asOrchestrator("git", ["rev-parse", "HEAD"], {
    cwd: pushClone,
  });
  const treeResult = await asOrchestrator("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: pushClone,
  });
  const pushedSha = shaResult.code === 0 ? shaResult.stdout.trim() : undefined;
  const pushedTree = treeResult.code === 0 ? treeResult.stdout.trim() : undefined;

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

  const shouldBeDraft = args.conversation.status === "blocked" || args.reviewConcerns;

  let prUrl: string;
  let prNodeId: string | null = null;
  let prIsDraft = false;

  if (existing.length > 0) {
    const pr = existing[0];
    prNodeId = pr.node_id;
    prIsDraft = Boolean(pr.draft);
    await client("PATCH", `/repos/${owner}/${repo}/pulls/${pr.number}`, {
      title: titleFor(args.conversation, args.reviewConcerns),
      body: bodyFor(args.conversation, args.reviewConcerns),
    });
    prUrl = pr.html_url;
  } else {
    const created: any = await client("POST", `/repos/${owner}/${repo}/pulls`, {
      title: titleFor(args.conversation, args.reviewConcerns),
      head: args.branchName,
      base: args.baseBranch,
      body: bodyFor(args.conversation, args.reviewConcerns),
      draft: shouldBeDraft,
    });
    prUrl = created.html_url;
    prNodeId = created.node_id;
    prIsDraft = Boolean(created.draft);
  }

  if (args.conversation.status === "done" && !args.reviewConcerns && prNodeId && prIsDraft) {
    await markReadyForReview(args.appToken, prNodeId);
  }

  await fs.rm(pushClone, { recursive: true, force: true });
  return { url: prUrl, sha: pushedSha, tree: pushedTree };
}

async function markReadyForReview(token: string, nodeId: string): Promise<void> {
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
    await log(`markReadyForReview: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    return;
  }
  if (json.errors) {
    await log(`markReadyForReview failed: ${JSON.stringify(json.errors).slice(0, 200)}`);
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
): Promise<PushResult> {
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
  return { url: "" };
}

async function writeStepSummary(
  c: Conversation,
  repo: string,
  branch: string,
  reason: string,
): Promise<PushResult> {
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
  return { url: "" };
}

function titleFor(c: Conversation, reviewConcerns: boolean): string {
  let title: string;
  if (reviewConcerns) {
    title = `[Omah] Review concerns: ${c.summary ?? "needs review"}`;
  } else if (c.status === "blocked") {
    title = `[Omah] Blocked: ${c.summary ?? "needs input"}`;
  } else {
    title = `[Omah] ${c.summary ?? "changes"}`;
  }
  return title.slice(0, 250);
}

function sanitize(s: string): string {
  return s.replace(/```/g, "`\u200B``").replace(/@/g, "@\u200B");
}

function bodyFor(c: Conversation, reviewConcerns: boolean): string {
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

  const sections: string[] = [];

  if (reviewConcerns) {
    const issues = c.reviewIssues ?? [];
    const statusLine = reviewConcernsStatusLine({
      fixRoundAttempted: c.reviewConcerns === true,
      issues,
    });
    sections.push(statusLine);
    sections.push("");
    sections.push("## Review findings");
    sections.push("");
    sections.push(formatIssuesTable(issues));
    sections.push("");
  }

  sections.push("## Task");
  sections.push("");
  sections.push(`> ${sanitize(c.taskText)}`);
  sections.push("");
  sections.push("## Summary");
  sections.push("");
  sections.push(sanitize(c.summary ?? "(none)"));
  sections.push("");
  sections.push("## Decision log");
  sections.push("");
  sections.push("<details>");
  sections.push(`<summary>${c.steps.length} steps</summary>`);
  sections.push("");
  sections.push("```");
  sections.push(stepLines.join("\n\n") + omittedLine);
  sections.push("```");
  sections.push("</details>");
  sections.push("");
  sections.push("---");
  sections.push("_Generated by Omah._");

  const body = sections.join("\n");

  if (body.length > MAX_PR_BODY_CHARS) {
    return body.slice(0, MAX_PR_BODY_CHARS - 100) + "\n\n_[truncated — body exceeded size limit]_";
  }
  return body;
}

// ---------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------

async function writeRunEntry(args: {
  conversation: Conversation;
  result: RunLoopResult;
  keys: KeySpec[];
  reviewOutcome: "skipped" | "pass" | "concerns";
  reviewIssueCount: number;
  fixRoundRan: boolean;
  runStarted: number;
  setupMs: number;
  reviewMs: number;
  pushMs: number;
  prUrl: string;
  pushedSha?: string;
  pushedTree?: string;
}): Promise<void> {
  if (!metaToken || !stateLoadOk) {
    await log("runlog: skipping entry (no meta token or state not loaded)");
    return;
  }

  const llmMs = usageLog.reduce((a, u) => a + u.ms, 0);
  const tokensIn = usageLog.reduce((a, u) => a + u.input, 0);
  const tokensOut = usageLog.reduce((a, u) => a + u.output, 0);

  const keyStatsArray = Array.from(keyStats.entries()).map(([index, s]) => ({
    index,
    provider: args.keys[index]?.provider ?? "unknown",
    calls: s.calls,
    rate429: s.rate429,
    errors: s.errors,
  }));

  const entry: RunEntry = {
    id: args.conversation.taskId,
    at: new Date().toISOString(),
    targetRepo: args.conversation.targetRepo,
    task: args.conversation.taskText.slice(0, 500),
    status: args.result.status,
    summary: args.result.summary.slice(0, 500),
    blockedReason: args.result.status === "blocked" ? args.result.summary.slice(0, 300) : undefined,

    steps: args.conversation.steps.length,
    compressions: args.result.compressionsDone,

    reviewOutcome: args.reviewOutcome,
    reviewIssueCount: args.reviewIssueCount,
    fixRoundRan: args.fixRoundRan,

    wallMs: Date.now() - args.runStarted,
    llmMs,
    setupMs: args.setupMs,
    reviewMs: args.reviewMs,
    pushMs: args.pushMs,
    tokensIn,
    tokensOut,

    keyStats: keyStatsArray,

    pushedSha: args.pushedSha,
    pushedTree: args.pushedTree,
    prUrl: args.prUrl || undefined,
  };

  await appendRunEntry(entry, metaToken, log);
}

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
    const err = s.lastError ? s.lastError.replace(/\|/g, "\\|").slice(0, 100) : "";
    lines.push(`| ${i + 1} | ${provider} | ${s.calls} | ${s.rate429} | ${s.errors} | ${err} |`);
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
// GitHub
// ---------------------------------------------------------------

async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(privateKeyPem, "base64url");
  return `${unsigned}.${sig}`;
}

async function mintAppToken(jwt: string, targetRepo: string): Promise<string> {
  const [owner, repo] = targetRepo.split("/");
  const instRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!instRes.ok) {
    throw new Error(`could not find installation for ${targetRepo}: ${instRes.status}`);
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

async function resolveAppIdentity(jwt: string): Promise<{ botId: string; appSlug: string }> {
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
    throw new Error("APP_BOT_ID is required. Set the OMAH_APP_BOT_ID repository variable.");
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error("[omah] fatal:", err);
    if (metaToken && stateLoadOk && !stateSaved) {
      setStateSaved(true);
      try {
        await saveState(persistedState, metaToken, log);
      } catch {}
    }
    process.exit(1);
  });
}
