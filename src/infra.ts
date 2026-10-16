// src/infra.ts
// Low-level plumbing: process spawning, workspace preparation,
// conversation persistence, key picking, and small helpers.
// Nothing in here knows about the agent loop or the review gate.

import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { appendFileSync } from "node:fs";
import ignore from "ignore";
import { loadAllKeys, type KeySpec } from "./llm.js";
import type { Conversation, ExecResult } from "./types.js";
import {
  AGENT_USER,
  AGENT_HOME,
  WORKSPACE,
  //OMAH_ROOT,
  IGNORE_FILE_PATH,
  MAX_PATCH_BYTES,
} from "./config.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------
// Logging and small utilities
// ---------------------------------------------------------------

export async function log(msg: string): Promise<void> {
  console.log(`[omah] ${msg}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… [truncated ${s.length - n} chars]`;
}

export function truncateHeadTail(s: string, headChars: number, tailChars: number): string {
  if (s.length <= headChars + tailChars) return s;
  const omitted = s.length - headChars - tailChars;
  return s.slice(0, headChars) + `\n… [truncated ${omitted} chars]\n` + s.slice(-tailChars);
}

export function shortId(): string {
  return Math.random().toString(16).slice(2, 10);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

export function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${key}=${value}\n`);
  } else {
    console.log(`::set-output name=${key}::${value}`);
  }
}

// ---------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------

export async function asAgent(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(
      "sudo",
      [
        "-u",
        AGENT_USER,
        "env",
        `PATH=${process.env.PATH}`,
        `HOME=${AGENT_HOME}`,
        `XDG_CONFIG_HOME=${AGENT_HOME}/.config`,
        `NPM_CONFIG_CACHE=${AGENT_HOME}/.npm`,
        cmd,
        ...args,
      ],
      {
        cwd: opts.cwd ?? WORKSPACE,
        timeout: opts.timeoutMs ?? 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return normalizeExecError(err);
  }
}

export async function asOrchestrator(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return normalizeExecError(err);
  }
}

export function normalizeExecError(err: any): ExecResult {
  const stdout = typeof err.stdout === "string" ? err.stdout : "";
  let stderr = typeof err.stderr === "string" ? err.stderr : String(err);
  let code: number;

  if (err.killed) {
    code = 124;
    stderr = stderr || "process killed (timeout)";
  } else if (typeof err.code === "number") {
    code = err.code;
  } else {
    code = 1;
  }

  if (stderr.startsWith("sudo:")) {
    stderr = `sudo failure: ${stderr}`;
  }
  return { stdout, stderr, code };
}

export async function asAgentBuffer(
  cmd: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let killed = false;

    const child = spawn(
      "sudo",
      [
        "-u",
        AGENT_USER,
        "env",
        `PATH=${process.env.PATH}`,
        `HOME=${AGENT_HOME}`,
        `XDG_CONFIG_HOME=${AGENT_HOME}/.config`,
        `NPM_CONFIG_CACHE=${AGENT_HOME}/.npm`,
        cmd,
        ...args,
      ],
      { cwd: WORKSPACE },
    );

    child.stdout.on("data", (d: Buffer) => {
      total += d.length;
      if (total > MAX_PATCH_BYTES) {
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(d);
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ stdout: Buffer.alloc(0), stderr: err.message, code: 1 }));
    child.on("close", (code) => {
      if (killed) {
        resolve({
          stdout: Buffer.concat(chunks),
          stderr: stderr + "\n(killed: output exceeded cap)",
          code: 124,
        });
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? 1 });
    });
  });
}

export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

// ---------------------------------------------------------------
// Key picker
// ---------------------------------------------------------------

export type PickResult =
  { kind: "ready"; index: number } | { kind: "wait"; waitMs: number } | { kind: "exhausted" };

export function pickKey(
  keys: KeySpec[],
  start: number,
  cooldownUntil: Map<number, number>,
): PickResult {
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length;
    if ((cooldownUntil.get(idx) ?? 0) <= now) {
      return { kind: "ready", index: idx };
    }
  }
  let earliest = Infinity;
  for (const t of cooldownUntil.values()) {
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (!Number.isFinite(earliest)) return { kind: "exhausted" };
  return { kind: "wait", waitMs: Math.max(0, earliest - now) + 500 };
}

export function loadKeys(): KeySpec[] {
  const specs = loadAllKeys(async (msg) => {
    await log(msg);
  });
  for (const k of specs) {
    console.log(`::add-mask::${k.key}`);
  }

  const preferred = (process.env.INPUT_PROVIDER || "default").trim().toLowerCase();
  if (preferred && preferred !== "default") {
    const first = specs.filter((k) => k.provider === preferred);
    const rest = specs.filter((k) => k.provider !== preferred);
    if (first.length === 0) {
      console.warn(`[omah] preference "${preferred}" matched no keys; using default order`);
      return specs;
    }
    return [...first, ...rest];
  }
  return specs;
}

// ---------------------------------------------------------------
// Workspace preparation
// ---------------------------------------------------------------

export async function prepareWorkspaceForAgent(
  targetRepo: string,
  branch: string,
  fallbackBranch: string,
  token: string,
): Promise<void> {
  await fs.rm(WORKSPACE, { recursive: true, force: true });
  await fs.mkdir(WORKSPACE, { recursive: true });

  const env = gitAuthEnv(token);
  const url = `https://github.com/${targetRepo}.git`;

  let cloneResult = await asOrchestrator(
    "git",
    ["clone", "--depth", "50", "--branch", branch, url, "."],
    { cwd: WORKSPACE, env },
  );

  if (cloneResult.code !== 0 && branch !== fallbackBranch) {
    await log(`branch ${branch} not found; falling back to ${fallbackBranch}`);
    await fs.rm(WORKSPACE, { recursive: true, force: true });
    await fs.mkdir(WORKSPACE, { recursive: true });
    cloneResult = await asOrchestrator(
      "git",
      ["clone", "--depth", "50", "--branch", fallbackBranch, url, "."],
      { cwd: WORKSPACE, env },
    );
    if (cloneResult.code === 0) {
      await asOrchestrator("git", ["checkout", "-b", branch], {
        cwd: WORKSPACE,
      });
    }
  }

  if (cloneResult.code !== 0) {
    throw new Error(`clone failed: ${cloneResult.stderr}`);
  }

  await asOrchestrator("sudo", ["chown", "-R", `${AGENT_USER}:${AGENT_USER}`, WORKSPACE]);
  await asOrchestrator("sudo", ["git", "config", "--system", "safe.directory", WORKSPACE]);
}

export async function configureGitIdentityAsAgent(name: string, email: string): Promise<void> {
  await asAgent("git", ["config", "user.name", name]);
  await asAgent("git", ["config", "user.email", email]);
}

export function safePath(input: string): string {
  const cleaned = input.replace(/^\/+/, "");
  const full = path.resolve(WORKSPACE, cleaned);
  if (!full.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${input}`);
  }
  return full;
}

// ---------------------------------------------------------------
// Ignore list
// ---------------------------------------------------------------

export async function readIgnorePatternsAtStartup(): Promise<string[]> {
  const out: string[] = [];
  try {
    const raw = await fs.readFile(IGNORE_FILE_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      out.push(trimmed);
    }
  } catch {}
  return out;
}

export async function readRepoIgnorePatterns(): Promise<string[]> {
  const out: string[] = [];
  const p = path.join(WORKSPACE, ".omahignore");
  try {
    const raw = await fs.readFile(p, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      out.push(trimmed);
    }
  } catch {}
  return out;
}

export async function applyIgnoreList(patterns: string[]): Promise<void> {
  if (patterns.length === 0) return;
  const ig = ignore().add(patterns);
  const { stdout: trackedOut } = await asAgent("git", ["ls-files", "-z"]);
  const tracked = new Set(trackedOut.split("\0").filter(Boolean));
  const toSkipWorktree: string[] = [];
  for (const rel of tracked) {
    if (ig.ignores(rel)) {
      toSkipWorktree.push(rel);
      await asAgent("rm", ["-f", path.join(WORKSPACE, rel)]);
      await log(`ignore: removed ${rel}`);
    }
  }
  if (toSkipWorktree.length > 0) {
    await asAgent("git", ["update-index", "--skip-worktree", ...toSkipWorktree]);
  }
}

// ---------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------

export function newConversation(
  taskId: string,
  taskText: string,
  targetRepo: string,
  baseBranch: string,
  branchName: string,
): Conversation {
  return {
    version: 1,
    taskId,
    taskText,
    targetRepo,
    baseBranch,
    branchName,
    steps: [],
    finished: false,
    startedAt: new Date().toISOString(),
  };
}

export async function saveConversation(
  c: Conversation,
  targetRepo: string,
  token: string,
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-state-"));
  try {
    let r = await asOrchestrator("git", ["init"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`state init failed: ${r.stderr}`);

    r = await asOrchestrator(
      "git",
      ["remote", "add", "origin", `https://github.com/${targetRepo}.git`],
      { cwd: tmp },
    );
    if (r.code !== 0) throw new Error(`state remote add failed: ${r.stderr}`);

    const stateBranch = `omah-state/${c.branchName.replace(/\//g, "-")}`;
    r = await asOrchestrator("git", ["checkout", "--orphan", stateBranch], {
      cwd: tmp,
    });
    if (r.code !== 0) throw new Error(`state checkout failed: ${r.stderr}`);

    await fs.writeFile(path.join(tmp, "conversation.json"), JSON.stringify(c, null, 2));
    r = await asOrchestrator("git", ["add", "conversation.json"], { cwd: tmp });
    if (r.code !== 0) throw new Error(`state add failed: ${r.stderr}`);

    r = await asOrchestrator(
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
    if (r.code !== 0 && !r.stdout.includes("nothing to commit")) {
      await log(`state commit warning: ${r.stderr}`);
    }

    r = await asOrchestrator("git", ["push", "-f", "origin", `HEAD:refs/heads/${stateBranch}`], {
      cwd: tmp,
      env: gitAuthEnv(token),
    });
    if (r.code !== 0) throw new Error(`state push failed: ${r.stderr}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function loadConversation(
  targetRepo: string,
  branchName: string,
  token: string,
): Promise<Conversation> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-load-"));
  try {
    const stateBranch = `omah-state/${branchName.replace(/\//g, "-")}`;
    const r = await asOrchestrator(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        stateBranch,
        `https://github.com/${targetRepo}.git`,
        ".",
      ],
      { cwd: tmp, env: gitAuthEnv(token) },
    );
    if (r.code !== 0) {
      throw new Error(`could not load conversation: ${r.stderr}`);
    }
    const raw = await fs.readFile(path.join(tmp, "conversation.json"), "utf8");
    return JSON.parse(raw) as Conversation;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
