// outcomes.ts
// Scheduled entry point. Reads runs.json, checks each unresolved run's
// PR, and writes back the outcome: merged, edited, or closed.
//
// "Edited" means the tree that landed on the target branch differs from
// the tree Omah pushed. Comparing trees instead of commits means squash
// and rebase merges are handled correctly.

import { createSign } from "node:crypto";
import { readRunEntries, updateRunOutcomes, type RunEntry, type RunOutcome } from "./src/runlog.js";

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const META_REPO = process.env.OMAH_META_REPO || "";

// ---------------------------------------------------------------
// Entry
// ---------------------------------------------------------------

async function main(): Promise<void> {
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

  const entries = await readRunEntries(metaToken, log);
  if (entries.length === 0) {
    await log("no run entries; nothing to do");
    return;
  }

  const unresolved = entries.filter(
    (e) => !e.outcome && typeof e.prUrl === "string" && e.prUrl.length > 0,
  );
  await log(`${entries.length} entries, ${unresolved.length} unresolved with a PR`);
  if (unresolved.length === 0) {
    await log("nothing to resolve");
    return;
  }

  // One token per distinct target repo, cached.
  const tokensByRepo = new Map<string, string>();
  async function tokenFor(repo: string): Promise<string | null> {
    const cached = tokensByRepo.get(repo);
    if (cached) return cached;
    try {
      const t = await mintToken(appJwt, repo);
      console.log(`::add-mask::${t}`);
      tokensByRepo.set(repo, t);
      return t;
    } catch (err: any) {
      await log(`no token for ${repo}: ${String(err?.message ?? err).slice(0, 120)}`);
      return null;
    }
  }

  const updates = new Map<string, { outcome: RunOutcome; at: string }>();
  const now = new Date().toISOString();

  for (const entry of unresolved) {
    const outcome = await resolveOutcome(entry, tokenFor);
    if (!outcome) continue;
    updates.set(entry.id, { outcome, at: now });
    await log(`run ${entry.id} (${entry.targetRepo}): ${outcome}`);
  }

  if (updates.size === 0) {
    await log("no outcomes determined");
    return;
  }

  const ok = await updateRunOutcomes(updates, metaToken, log);
  if (!ok) {
    process.exitCode = 1;
    await log("update failed");
  }
}

// ---------------------------------------------------------------
// Outcome resolution
// ---------------------------------------------------------------

async function resolveOutcome(
  entry: RunEntry,
  tokenFor: (repo: string) => Promise<string | null>,
): Promise<RunOutcome | null> {
  const prNumber = parsePrNumber(entry.prUrl!);
  if (prNumber === null) {
    await log(`run ${entry.id}: could not parse PR number from ${entry.prUrl}`);
    return null;
  }

  const token = await tokenFor(entry.targetRepo);
  if (!token) return null;

  let pr: any;
  try {
    pr = await ghJson("GET", `/repos/${entry.targetRepo}/pulls/${prNumber}`, token);
  } catch (err: any) {
    await log(`run ${entry.id}: PR lookup failed: ${String(err?.message ?? err).slice(0, 120)}`);
    return null;
  }

  if (!pr || typeof pr !== "object") return null;

  if (pr.state === "open") {
    return null;
  }

  if (pr.merged) {
    return determineMergedOutcome(entry, pr, token);
  }

  // Closed, not merged.
  return "closed";
}

async function determineMergedOutcome(
  entry: RunEntry,
  pr: any,
  token: string,
): Promise<RunOutcome> {
  const mergeSha = pr.merge_commit_sha;
  if (!mergeSha) return "merged";

  if (!entry.pushedTree) {
    // No tree to compare. Assume the push landed as-is.
    return "merged";
  }

  try {
    const commit: any = await ghJson(
      "GET",
      `/repos/${entry.targetRepo}/git/commits/${mergeSha}`,
      token,
    );
    const mergedTree = commit?.tree?.sha;
    if (!mergedTree) return "merged";
    return mergedTree === entry.pushedTree ? "merged" : "edited";
  } catch (err: any) {
    await log(`run ${entry.id}: tree lookup failed: ${String(err?.message ?? err).slice(0, 120)}`);
    return "merged";
  }
}

function parsePrNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:$|[/?#])/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------

async function ghJson(method: string, urlPath: string, token: string): Promise<any> {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`github ${method} ${urlPath}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

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

async function mintToken(jwt: string, repo: string): Promise<string> {
  const [owner, name] = repo.split("/");
  const instRes = await fetch(`https://api.github.com/repos/${owner}/${name}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });
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
        permissions: { contents: "read", pull_requests: "read" },
      }),
    },
  );
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`could not mint token for ${repo}: ${tokenRes.status} ${text.slice(0, 200)}`);
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

async function log(msg: string): Promise<void> {
  console.log(`[outcomes] ${msg}`);
}

// ---------------------------------------------------------------

main().catch((err) => {
  console.error("[outcomes] fatal:", err);
  process.exit(1);
});
