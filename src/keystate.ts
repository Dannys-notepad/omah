// keystate.ts
// Best-effort persistence of key exhaustion state across runs.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const META_BRANCH = "omah-meta";
const KEYS_FILE = "keys.json";
const META_REPO_ENV = "OMAH_META_REPO";
const MAX_UNKNOWN_COOLDOWN_MS = 2 * 60 * 60 * 1000;

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

export function fingerprint(provider: string, key: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${provider}:${h}`;
}

export interface LoadResult {
  state: KeysFile;
  ok: boolean;
}

function emptyState(): KeysFile {
  return { version: 1, updated_at: new Date().toISOString(), keys: {} };
}

export async function loadKeyState(
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
      // Only a genuinely-missing remote branch means "empty but authoritative".
      // Do not match generic "repository ... not found" (auth failures).
      if (/Remote branch .* not found|Could not find remote branch/i.test(stderr)) {
        await log("keystate: no existing state (branch absent)");
        return { state: emptyState(), ok: true };
      }
      await log(
        `keystate: load failed (${stderr.split("\n")[0] || "unknown"})`,
      );
      return { state: emptyState(), ok: false };
    }
    const raw = await fs.readFile(path.join(tmp, KEYS_FILE), "utf8");
    let parsed: KeysFile;
    try {
      parsed = JSON.parse(raw) as KeysFile;
    } catch (err: any) {
      await log(`keystate: file is not valid JSON: ${err?.message ?? err}`);
      return { state: emptyState(), ok: false };
    }
    if (parsed?.version !== 1 || typeof parsed.keys !== "object") {
      await log("keystate: unexpected file shape; ignoring");
      return { state: emptyState(), ok: false };
    }
    return { state: parsed, ok: true };
  } catch (err: any) {
    await log(`keystate: load failed: ${String(err?.message ?? err).slice(0, 200)}`);
    return { state: emptyState(), ok: false };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function saveKeyState(
  state: KeysFile,
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
  for (const [fp, entry] of Object.entries(state.keys)) {
    if (!entry.reset_at) continue;
    const resetAt = Date.parse(entry.reset_at);
    if (!Number.isNaN(resetAt) && resetAt <= now) {
      delete state.keys[fp];
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

    state.updated_at = new Date().toISOString();
    await fs.writeFile(
      path.join(tmp, KEYS_FILE),
      JSON.stringify(state, null, 2),
    );
    r = await execOrchestrator("git", ["add", KEYS_FILE], { cwd: tmp });
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
        "omah: key state",
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
    await log(
      `keystate: save failed: ${String(err?.message ?? err).slice(0, 200)}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

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
    Date.UTC(
      pacific.getUTCFullYear(),
      pacific.getUTCMonth(),
      pacific.getUTCDate() + 1,
      0,
      0,
      0,
    ) -
    offsetHours * 3600 * 1000;
  return nextMidnightUtc;
}

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