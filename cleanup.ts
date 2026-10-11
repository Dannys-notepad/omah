// cleanup.ts
// Branch cleanup for Omah. Runs daily on a schedule, or manually via
// workflow_dispatch to wipe every Omah-created branch in scope.

import { promises as fs, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  decideDeletions,
  taskBranchFor,
  type BranchInfo,
  type PrInfo,
  type DeleteDecision,
} from "./src/cleanup-rules.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const META_REPO = process.env.OMAH_META_REPO || "";
const META_BRANCH = "omah-meta";
const REPOS_FILE = "repositories.json";
const OMAH_REPO = META_REPO;

const TASK_PATTERN = /^omah\/[a-z0-9-]+$/;
const STATE_PATTERN = /^omah-state\/omah-[a-z0-9-]+$/;

const DRY_RUN =
  (process.env.DRY_RUN || "").trim().toLowerCase() === "true";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

interface ReposFile {
  version: 1;
  updated_at: string;
  repos: string[];
}

// ---------------------------------------------------------------
// Entry
// ---------------------------------------------------------------

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const manual = eventName === "workflow_dispatch";

  if (!META_REPO) {
    await log("OMAH_META_REPO not set; nothing to do");
    return;
  }

  const appJwt = await signAppJwt(
    requireEnv("APP_ID"),
    requireEnv("APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  );
  const metaToken = await mintToken(appJwt, META_REPO);
  console.log(`::add-mask::${metaToken}`);

  // Manual mode requires the confirm word.
  if (manual) {
    const confirm = (process.env.INPUT_CONFIRM || "").trim();
    if (confirm !== "DELETE") {
      await log(
        `manual trigger requires confirm=DELETE (got "${confirm}"); refusing`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Bail if Omah is running, before doing anything else.
  const actionsToken = process.env.GH_ACTIONS_TOKEN || "";
  if (!actionsToken) {
    await log("GH_ACTIONS_TOKEN not set; cannot verify omah.yml status");
    process.exitCode = 1;
    return;
  }
  if (await isOmahRunning(actionsToken)) {
    await log("omah.yml has an in-progress or queued run; skipping cleanup");
    return;
  }

  const repos = await loadRepoList(metaToken);
  if (repos.length === 0) {
    await log("no repos recorded in repositories.json; nothing to do");
    return;
  }

  // Determine scope.
  let scope: string[];
  if (manual) {
    const requested = (process.env.INPUT_REPO || "").trim();
    if (requested) {
      if (!repos.includes(requested)) {
        await log(`repo "${requested}" is not in repositories.json; refusing`);
        process.exitCode = 1;
        return;
      }
      scope = [requested];
    } else {
      scope = repos;
    }
    await log(
      `MANUAL DELETE-ALL across ${scope.length} repo(s): ${scope.join(", ")}`,
    );
    await log(
      "NOTE: this closes every open Omah PR in scope, including blocked drafts awaiting resume.",
    );
  } else {
    scope = repos;
    await log(
      `scheduled cleanup across ${scope.length} repo(s)` +
        (DRY_RUN ? " (DRY RUN: no deletions will occur)" : ""),
    );
  }

  let hadErrors = false;
  const summary: string[] = [];
  for (const repo of scope) {
    try {
      const result = await processRepo(repo, appJwt, manual);
      summary.push(
        `### ${repo}\n\n- scanned: ${result.scanned}\n- ${DRY_RUN ? "would delete" : "deleted"}: ${result.deleted.length}\n- errors: ${result.errors.length}`,
      );
      for (const d of result.deleted) {
        summary.push(
          `- ${DRY_RUN ? "WOULD DELETE" : "DEL"} ${d.branch} (rule ${d.rule}: ${d.reason})`,
        );
      }
      for (const e of result.errors) {
        summary.push(`- ERR ${e}`);
      }
    } catch (err: any) {
      hadErrors = true;
      await log(
        `repo ${repo} failed: ${String(err?.message ?? err).slice(0, 200)}`,
      );
      summary.push(
        `### ${repo}\n\n- FAILED: ${String(err?.message ?? err).slice(0, 200)}`,
      );
    }
  }

  writeStepSummary(summary.join("\n") + "\n");

  if (hadErrors) process.exitCode = 1;
}

// ---------------------------------------------------------------
// Per-repo processing
// ---------------------------------------------------------------

interface RepoResult {
  scanned: number;
  deleted: DeleteDecision[];
  errors: string[];
}

async function processRepo(
  repo: string,
  appJwt: string,
  manual: boolean,
): Promise<RepoResult> {
  await log(`=== ${repo} ===`);
  const token = await mintToken(appJwt, repo);
  console.log(`::add-mask::${token}`);

  const taskRefs = await listMatchingRefs(repo, "omah/", token);
  const stateRefs = await listMatchingRefs(repo, "omah-state/", token);
  const branches: BranchInfo[] = [...taskRefs, ...stateRefs];
  await log(`branches: ${taskRefs.length} task, ${stateRefs.length} state`);

  let decisions: DeleteDecision[];
  if (manual) {
    decisions = branches.map((b) => ({
      branch: b.name,
      rule: 3 as const,
      reason: "manual wipe",
    }));
  } else {
    const prs = await fetchPrsForBranches(repo, branches, token);
    await log(`PRs: ${prs.length}`);
    await fillLastCommitAt(repo, branches, prs, token);
    decisions = decideDeletions(branches, prs);
  }

  const deleted: DeleteDecision[] = [];
  const errors: string[] = [];
  for (const d of decisions) {
    if (DRY_RUN) {
      deleted.push(d);
      await log(`WOULD DELETE ${d.branch} [rule ${d.rule}] ${d.reason}`);
      continue;
    }
    const ok = await deleteBranch(repo, d.branch, token);
    if (ok) {
      deleted.push(d);
      await log(`DEL ${d.branch} [rule ${d.rule}] ${d.reason}`);
    } else {
      errors.push(`${d.branch}: delete failed`);
      await log(`ERR ${d.branch} delete failed`);
    }
  }

  return { scanned: branches.length, deleted, errors };
}

// ---------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------

function api(path: string): string {
  return `https://api.github.com${path}`;
}

async function ghJson(
  method: string,
  urlPath: string,
  token: string,
): Promise<any> {
  const res = await fetch(api(urlPath), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `github ${method} ${urlPath}: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return res.status === 204 ? null : res.json();
}

/**
 * List refs matching a prefix, using git/matching-refs so we don't page
 * through every branch in the repo.
 * No URL-encoding: the slash in `omah/` is a path separator GitHub
 * expects, and the naming regexes forbid characters that need escaping.
 */
async function listMatchingRefs(
  repo: string,
  prefix: string,
  token: string,
): Promise<BranchInfo[]> {
  const out: BranchInfo[] = [];
  let page = 1;
  while (true) {
    const refs: any[] = await ghJson(
      "GET",
      `/repos/${repo}/git/matching-refs/heads/${prefix}?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(refs) || refs.length === 0) break;
    for (const r of refs) {
      const name = String(r.ref || "").replace(/^refs\/heads\//, "");
      if (!name) continue;
      if (!TASK_PATTERN.test(name) && !STATE_PATTERN.test(name)) continue;
      out.push({ name });
    }
    if (refs.length < 100) break;
    page += 1;
  }
  return out;
}

async function fetchPrsForBranches(
  repo: string,
  branches: BranchInfo[],
  token: string,
): Promise<PrInfo[]> {
  const [owner] = repo.split("/");
  const seen = new Set<string>();
  const out: PrInfo[] = [];
  for (const b of branches) {
    const task = TASK_PATTERN.test(b.name) ? b.name : taskBranchFor(b.name);
    if (!task) continue;
    if (seen.has(task)) continue;
    seen.add(task);

    const prs: any[] = await ghJson(
      "GET",
      `/repos/${repo}/pulls?head=${owner}:${task}&state=all&per_page=10`,
      token,
    );
    for (const p of prs) {
      out.push({
        number: p.number,
        headRef: String(p.head?.ref || ""),
        state: p.state === "closed" ? "closed" : "open",
        merged: Boolean(p.merged_at),
        draft: Boolean(p.draft),
        updatedAt: String(p.updated_at || p.created_at),
      });
    }
  }
  return out;
}

async function fillLastCommitAt(
  repo: string,
  branches: BranchInfo[],
  prs: PrInfo[],
  token: string,
): Promise<void> {
  const prHeads = new Set(prs.map((p) => p.headRef));
  for (const b of branches) {
    const task = TASK_PATTERN.test(b.name) ? b.name : taskBranchFor(b.name);
    if (!task) continue;
    if (prHeads.has(task)) continue; // has a PR; Rule 3 won't fire

    const ref: any = await ghJson(
      "GET",
      `/repos/${repo}/git/ref/heads/${b.name}`,
      token,
    ).catch(() => null);
    const sha = ref?.object?.sha;
    if (!sha) continue;

    const commit: any = await ghJson(
      "GET",
      `/repos/${repo}/git/commits/${sha}`,
      token,
    ).catch(() => null);
    const date = commit?.committer?.date || commit?.author?.date;
    if (date) b.lastCommitAt = String(date);
  }
}

/**
 * Delete a branch, with a hard safety check on the name.
 * Returns true on success, false on any failure.
 * Only a confirmed 404 (branch really gone) counts as success.
 */
async function deleteBranch(
  repo: string,
  branch: string,
  token: string,
): Promise<boolean> {
  if (branch === META_BRANCH) return false;
  if (!TASK_PATTERN.test(branch) && !STATE_PATTERN.test(branch)) return false;

  const res = await fetch(
    api(`/repos/${repo}/git/refs/heads/${branch}`),
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (res.ok || res.status === 204) return true;

  if (res.status === 404) {
    // Verify it's actually gone.
    const check = await fetch(api(`/repos/${repo}/git/ref/heads/${branch}`), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    return check.status === 404;
  }

  if (res.status === 422) return false;

  const text = await res.text();
  await log(`delete ${branch}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return false;
}

async function isOmahRunning(token: string): Promise<boolean> {
  try {
    const inProgress: any = await ghJson(
      "GET",
      `/repos/${OMAH_REPO}/actions/workflows/omah.yml/runs?status=in_progress&per_page=1`,
      token,
    );
    if (
      Array.isArray(inProgress?.workflow_runs) &&
      inProgress.workflow_runs.length > 0
    ) {
      return true;
    }
    const queued: any = await ghJson(
      "GET",
      `/repos/${OMAH_REPO}/actions/workflows/omah.yml/runs?status=queued&per_page=1`,
      token,
    );
    return Array.isArray(queued?.workflow_runs) && queued.workflow_runs.length > 0;
  } catch (err: any) {
    await log(
      `could not check omah.yml status: ${String(err?.message ?? err).slice(0, 200)}`,
    );
    return true; // fail closed
  }
}

// ---------------------------------------------------------------
// repositories.json
// ---------------------------------------------------------------

async function loadRepoList(token: string): Promise<string[]> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omah-cleanup-load-"));
  try {
    const env = gitAuthEnv(token);
    const url = `https://github.com/${META_REPO}.git`;
    const r = await execOrchestrator(
      "git",
      ["clone", "--depth", "1", "--branch", META_BRANCH, url, "."],
      { cwd: tmp, env },
    );
    if (r.code !== 0) {
      await log(
        `repositories.json not found (${r.stderr.split("\n")[0] || "clone failed"})`,
      );
      return [];
    }
    const raw = await fs.readFile(path.join(tmp, REPOS_FILE), "utf8");
    const parsed = JSON.parse(raw) as ReposFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.repos)) {
      await log("repositories.json has unexpected shape; ignoring");
      return [];
    }
    return parsed.repos.filter((r) => typeof r === "string" && r);
  } catch (err: any) {
    await log(
      `repositories.json load failed: ${String(err?.message ?? err).slice(0, 200)}`,
    );
    return [];
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------
// App token / JWT
// ---------------------------------------------------------------

async function signAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(privateKeyPem, "base64url");
  return `${unsigned}.${sig}`;
}

async function mintToken(jwt: string, repo: string): Promise<string> {
  const [owner, name] = repo.split("/");
  const instRes = await fetch(
    `https://api.github.com/repos/${owner}/${name}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!instRes.ok) {
    throw new Error(`no installation for ${repo}: ${instRes.status}`);
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
        repositories: [name],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(
      `could not mint token for ${repo}: ${tokenRes.status} ${text}`,
    );
  }
  const token: any = await tokenRes.json();
  return token.token;
}

// ---------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
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

async function log(msg: string): Promise<void> {
  console.log(`[cleanup] ${msg}`);
}

function writeStepSummary(text: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, text);
  } catch {}
}

// ---------------------------------------------------------------

main().catch(async (err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});