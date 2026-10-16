// keystate.ts
// Persistence for key exhaustion state AND the list of target repos,
// both stored on the omah-meta orphan branch.
//
// The two files live on the same branch and are written in one commit,
// because a fresh orphan commit replaces the entire tree. Saving them
// separately would wipe one when writing the other.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const META_BRANCH = "omah-meta";
const KEYS_FILE = "keys.json";
const REPOS_FILE = "repositories.json";
const META_REPO_ENV = "OMAH_META_REPO";
const MAX_UNKNOWN_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface KeyState {
  status: "exhausted";
  reason: "PerDay";
  reset_at: string;
  last_seen: string;
}

export interface KeysFile {
  version: 1;
  updated_at: string;
  keys: Record<string, KeyState>;
}

export interface ReposFile {
  version: 1;
  updated_at: string;
  repos: string[];
}

export interface State {
  keys: KeysFile;
  repos: ReposFile;
}

export interface LoadResult {
  state: State;
  ok: boolean;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

export function fingerprint(provider: string, key: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${provider}:${h}`;
}

function emptyState(): State {
  return {
    keys: { version: 1, updated_at: new Date().toISOString(), keys: {} },
    repos: { version: 1, updated_at: new Date().toISOString(), repos: [] },
  };
}

/**
 * Add a repo to the state list if it isn't already present.
 * Mutates state.repos.repos in place. Returns true if added.
 */
export function addRepo(state: State, repo: string): boolean {
  if (!repo || typeof repo !== "string") return false;
  if (state.repos.repos.includes(repo)) return false;
  state.repos.repos.push(repo);
  return true;
}

// ---------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------

export async function loadState(
  token: string,
  log: (msg: string) => Promise<void>,
): Promise<LoadResult> {
  const repo = process.env[META_REPO_ENV];
  if (!repo) {
    await log("keystate: OMAH_META_REPO not set; skipping state load");
    return { state: emptyState(), ok: false };
  }
  if (!token) {
    await log("keystate: no token; skipping state load");
    return { state: emptyState(), ok: false };
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-meta-load-"));
  try {
    const env = gitAuthEnv(token);
    const url = `https://github.com/${repo}.git`;
    const r = await execOrchestrator(
      "git",
      ["clone", "--depth", "1", "--branch", META_BRANCH, url, "."],
      { cwd: tmp, env },
    );
    if (r.code !== 0) {
      const stderr = r.stderr || "";
      if (/Remote branch .* not found|Could not find remote branch/i.test(stderr)) {
        await log("keystate: no existing state (branch absent)");
        return { state: emptyState(), ok: true };
      }
      await log(`keystate: load failed (${stderr.split("\n")[0] || "unknown"})`);
      return { state: emptyState(), ok: false };
    }

    let keys: KeysFile = emptyState().keys;
    let repos: ReposFile = emptyState().repos;

    try {
      const raw = await fs.readFile(path.join(tmp, KEYS_FILE), "utf8");
      const parsed = JSON.parse(raw) as KeysFile;
      if (parsed?.version === 1 && typeof parsed.keys === "object") {
        keys = parsed;
      } else {
        await log("keystate: keys.json has unexpected shape; ignoring");
      }
    } catch (err: any) {
      if ((err as any)?.code !== "ENOENT") {
        await log(`keystate: keys.json read failed: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }

    try {
      const raw = await fs.readFile(path.join(tmp, REPOS_FILE), "utf8");
      const parsed = JSON.parse(raw) as ReposFile;
      if (parsed?.version === 1 && Array.isArray(parsed.repos)) {
        repos = parsed;
      } else {
        await log("keystate: repositories.json has unexpected shape; ignoring");
      }
    } catch (err: any) {
      if ((err as any)?.code !== "ENOENT") {
        await log(
          `keystate: repositories.json read failed: ${String(err?.message ?? err).slice(0, 200)}`,
        );
      }
    }

    return { state: { keys, repos }, ok: true };
  } catch (err: any) {
    await log(`keystate: load failed: ${String(err?.message ?? err).slice(0, 200)}`);
    return { state: emptyState(), ok: false };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function saveState(
  state: State,
  token: string,
  log: (msg: string) => Promise<void>,
): Promise<void> {
  const repo = process.env[META_REPO_ENV];
  if (!repo) {
    await log("keystate: OMAH_META_REPO not set; skipping state save");
    return;
  }
  if (!token) {
    await log("keystate: no token; skipping state save");
    return;
  }

  const now = Date.now();
  for (const [fp, entry] of Object.entries(state.keys.keys)) {
    if (!entry.reset_at) continue;
    const resetAt = Date.parse(entry.reset_at);
    if (!Number.isNaN(resetAt) && resetAt <= now) {
      delete state.keys.keys[fp];
    }
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-meta-save-"));
  try {
    const env = gitAuthEnv(token);
    const url = `https://github.com/${repo}.git`;

    let r = await execOrchestrator("git", ["init"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`init: ${r.stderr}`);

    r = await execOrchestrator("git", ["remote", "add", "origin", url], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`remote add: ${r.stderr}`);

    r = await execOrchestrator("git", ["checkout", "--orphan", META_BRANCH], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`checkout: ${r.stderr}`);

    state.keys.updated_at = new Date().toISOString();
    state.repos.updated_at = new Date().toISOString();

    await fs.writeFile(path.join(tmp, KEYS_FILE), JSON.stringify(state.keys, null, 2));
    await fs.writeFile(path.join(tmp, REPOS_FILE), JSON.stringify(state.repos, null, 2));

    r = await execOrchestrator("git", ["add", KEYS_FILE, REPOS_FILE], {
      cwd: tmp,
    });
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
        "omah: state",
      ],
      { cwd: tmp },
    );
    if (r.code !== 0) throw new Error(`commit: ${r.stderr}`);

    r = await execOrchestrator(
      "git",
      ["push", "--force", "origin", `HEAD:refs/heads/${META_BRANCH}`],
      { cwd: tmp, env },
    );
    if (r.code !== 0) throw new Error(`push: ${r.stderr}`);

    await log("keystate: saved");
  } catch (err: any) {
    await log(`keystate: save failed: ${String(err?.message ?? err).slice(0, 200)}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------
// Reset time
// ---------------------------------------------------------------

export function isPerDayLimit(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return /PerDay|per[- ]day|daily quota/i.test(msg);
}

export function resetTimeFor(err: unknown, provider: string): string {
  const now = Date.now();
  const retryAfterMs = Number((err as any)?.retryAfterMs ?? 0);

  if (provider === "gemini") {
    return new Date(nextPacificMidnightMs()).toISOString();
  }
  if (retryAfterMs > 0 && retryAfterMs <= MAX_UNKNOWN_COOLDOWN_MS) {
    return new Date(now + retryAfterMs).toISOString();
  }
  return new Date(now + MAX_UNKNOWN_COOLDOWN_MS).toISOString();
}

function nextPacificMidnightMs(): number {
  const now = new Date();
  const month = now.getUTCMonth();
  const offsetHours = month >= 2 && month <= 10 ? -7 : -8;
  const pacific = new Date(now.getTime() + offsetHours * 3600 * 1000);
  const nextMidnightUtc =
    Date.UTC(pacific.getUTCFullYear(), pacific.getUTCMonth(), pacific.getUTCDate() + 1, 0, 0, 0) -
    offsetHours * 3600 * 1000;
  return nextMidnightUtc;
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
