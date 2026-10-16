// src/runlog.ts
// Persistent run log. Appends one JSON entry per run to runs.json on
// the omah-runs branch of the meta repo. Keeps the most recent
// MAX_ENTRIES, dropping older ones.
//
// Lives on its own branch because the meta branch is rewritten via
// `git checkout --orphan` on every save, which wipes any file not
// written in the same commit.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const RUNS_BRANCH = "omah-runs";
const RUNS_FILE = "runs.json";
const MAX_ENTRIES = 200;

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface RunKeyStat {
  index: number;
  provider: string;
  calls: number;
  rate429: number;
  errors: number;
}

export type RunReviewOutcome = "skipped" | "pass" | "concerns";
export type RunStatus = "done" | "blocked";
export type RunOutcome = "merged" | "edited" | "closed";

export interface RunEntry {
  id: string;
  at: string;
  targetRepo: string;
  task: string;
  status: RunStatus;
  summary: string;
  blockedReason?: string;

  steps: number;
  compressions: number;

  reviewOutcome: RunReviewOutcome;
  reviewIssueCount: number;
  fixRoundRan: boolean;

  wallMs: number;
  llmMs: number;
  setupMs: number;
  pushMs: number;
  tokensIn: number;
  tokensOut: number;

  keyStats: RunKeyStat[];

  /** Commit and tree SHA of the branch Omah pushed, when a push occurred. */
  pushedSha?: string;
  pushedTree?: string;
  prUrl?: string;

  /** Set later by the outcomes workflow. Absent until the PR resolves. */
  outcome?: RunOutcome;
  outcomeAt?: string;
}

interface RunsFile {
  version: 1;
  updated_at: string;
  runs: RunEntry[];
}

// ---------------------------------------------------------------
// Read
// ---------------------------------------------------------------

export async function readRunEntries(
  token: string,
  log: (msg: string) => Promise<void>,
): Promise<RunEntry[]> {
  const repo = process.env.OMAH_META_REPO;
  if (!repo) {
    await log("runlog: OMAH_META_REPO not set; no entries");
    return [];
  }
  if (!token) {
    await log("runlog: no token; no entries");
    return [];
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-runs-load-"));
  try {
    const env = gitAuthEnv(token);
    const url = `https://github.com/${repo}.git`;
    const r = await execOrchestrator(
      "git",
      ["clone", "--depth", "1", "--branch", RUNS_BRANCH, url, "."],
      { cwd: tmp, env },
    );
    if (r.code !== 0) {
      const stderr = r.stderr || "";
      if (/Remote branch .* not found|Could not find remote branch/i.test(stderr)) {
        return [];
      }
      await log(`runlog: load failed (${stderr.split("\n")[0] || "unknown"})`);
      return [];
    }
    const raw = await fs.readFile(path.join(tmp, RUNS_FILE), "utf8");
    const parsed = JSON.parse(raw) as RunsFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) {
      await log("runlog: runs.json has unexpected shape; ignoring");
      return [];
    }
    return parsed.runs;
  } catch (err: any) {
    await log(`runlog: load failed: ${String(err?.message ?? err).slice(0, 200)}`);
    return [];
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------
// Write
// ---------------------------------------------------------------

export async function appendRunEntry(
  entry: RunEntry,
  token: string,
  log: (msg: string) => Promise<void>,
): Promise<boolean> {
  const repo = process.env.OMAH_META_REPO;
  if (!repo) {
    await log("runlog: OMAH_META_REPO not set; skipping append");
    return false;
  }
  if (!token) {
    await log("runlog: no token; skipping append");
    return false;
  }

  const existing = await readRunEntries(token, log);
  const next: RunEntry[] = [...existing, entry];
  while (next.length > MAX_ENTRIES) next.shift();

  const file: RunsFile = {
    version: 1,
    updated_at: new Date().toISOString(),
    runs: next,
  };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-runs-save-"));
  try {
    const env = gitAuthEnv(token);
    const url = `https://github.com/${repo}.git`;

    let r = await execOrchestrator("git", ["init"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`init: ${r.stderr}`);

    r = await execOrchestrator("git", ["remote", "add", "origin", url], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`remote add: ${r.stderr}`);

    r = await execOrchestrator("git", ["checkout", "--orphan", RUNS_BRANCH], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`checkout: ${r.stderr}`);

    await fs.writeFile(path.join(tmp, RUNS_FILE), JSON.stringify(file, null, 2));

    r = await execOrchestrator("git", ["add", RUNS_FILE], { cwd: tmp });
    if (r.code !== 0) throw new Error(`add: ${r.stderr}`);

    r = await execOrchestrator(
      "git",
      [
        "-c",
        "user.name=omah[bot]",
        "-c",
        "user.email=omah[bot]@users.noreply.github.com",
        "commit",
        "-m",
        "omah: run log",
      ],
      { cwd: tmp },
    );
    if (r.code !== 0) throw new Error(`commit: ${r.stderr}`);

    r = await execOrchestrator(
      "git",
      ["push", "--force", "origin", `HEAD:refs/heads/${RUNS_BRANCH}`],
      { cwd: tmp, env },
    );
    if (r.code !== 0) throw new Error(`push: ${r.stderr}`);

    await log(`runlog: appended entry (${next.length} total)`);
    return true;
  } catch (err: any) {
    await log(`runlog: append failed: ${String(err?.message ?? err).slice(0, 200)}`);
    return false;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Replace the outcomes of matching entries and write back. Used by the
 * outcomes workflow. Takes a map of task id -> outcome and timestamp.
 */
export async function updateRunOutcomes(
  updates: Map<string, { outcome: RunOutcome; at: string }>,
  token: string,
  log: (msg: string) => Promise<void>,
): Promise<boolean> {
  const repo = process.env.OMAH_META_REPO;
  if (!repo) return false;
  if (!token) return false;
  if (updates.size === 0) return true;

  const existing = await readRunEntries(token, log);
  if (existing.length === 0) return true;

  let changed = 0;
  for (const entry of existing) {
    const update = updates.get(entry.id);
    if (!update) continue;
    if (entry.outcome === update.outcome) continue;
    entry.outcome = update.outcome;
    entry.outcomeAt = update.at;
    changed += 1;
  }
  if (changed === 0) {
    await log("runlog: no outcome changes");
    return true;
  }

  const file: RunsFile = {
    version: 1,
    updated_at: new Date().toISOString(),
    runs: existing,
  };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-runs-update-"));
  try {
    const env = gitAuthEnv(token);
    const url = `https://github.com/${repo}.git`;

    let r = await execOrchestrator("git", ["init"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`init: ${r.stderr}`);

    r = await execOrchestrator("git", ["remote", "add", "origin", url], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`remote add: ${r.stderr}`);

    r = await execOrchestrator("git", ["checkout", "--orphan", RUNS_BRANCH], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`checkout: ${r.stderr}`);

    await fs.writeFile(path.join(tmp, RUNS_FILE), JSON.stringify(file, null, 2));

    r = await execOrchestrator("git", ["add", RUNS_FILE], { cwd: tmp });
    if (r.code !== 0) throw new Error(`add: ${r.stderr}`);

    r = await execOrchestrator(
      "git",
      [
        "-c",
        "user.name=omah[bot]",
        "-c",
        "user.email=omah[bot]@users.noreply.github.com",
        "commit",
        "-m",
        "omah: update run outcomes",
      ],
      { cwd: tmp },
    );
    if (r.code !== 0) throw new Error(`commit: ${r.stderr}`);

    r = await execOrchestrator(
      "git",
      ["push", "--force", "origin", `HEAD:refs/heads/${RUNS_BRANCH}`],
      { cwd: tmp, env },
    );
    if (r.code !== 0) throw new Error(`push: ${r.stderr}`);

    await log(`runlog: updated ${changed} outcome(s)`);
    return true;
  } catch (err: any) {
    await log(`runlog: update failed: ${String(err?.message ?? err).slice(0, 200)}`);
    return false;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------
// Internal
// ---------------------------------------------------------------

function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function execOrchestrator(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : String(err),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}
