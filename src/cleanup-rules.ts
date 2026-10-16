// cleanup-rules.ts
// Pure decision function for the cleanup workflow. No I/O, no logging,
// no network. Given a repo's branches and PRs, returns the list of
// branch names to delete.

// Time windows, in milliseconds. Tunable.
export const RULES = {
  /** Orphan branches with no PR are deleted after this age. */
  ORPHAN_AGE_MS: 2 * 24 * 60 * 60 * 1000,
  /** Open non-draft PRs are considered abandoned after this age. */
  OPEN_PR_AGE_MS: 2 * 24 * 60 * 60 * 1000,
  /** Blocked draft PRs lose their resume option after this age. */
  DRAFT_PR_AGE_MS: 5 * 24 * 60 * 60 * 1000,
};

export interface BranchInfo {
  name: string;
  lastCommitAt?: string;
}

export interface PrInfo {
  number: number;
  headRef: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  updatedAt: string;
}

export interface DeleteDecision {
  branch: string;
  rule: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

/**
 * Given branches and PRs for a single repo, decide which branches to
 * delete. Returns decisions, not just names, so the caller can log the
 * reason for each.
 *
 * Only names matching `^omah/[a-z0-9-]+$` or
 * `^omah-state/omah-[a-z0-9-]+$` are ever considered.
 */
export function decideDeletions(
  branches: BranchInfo[],
  prs: PrInfo[],
  nowMs: number = Date.now(),
): DeleteDecision[] {
  const decisions: DeleteDecision[] = [];

  // Index PRs by their head branch.
  const prByHead = new Map<string, PrInfo>();
  for (const pr of prs) {
    const existing = prByHead.get(pr.headRef);
    if (!existing || Date.parse(pr.updatedAt) > Date.parse(existing.updatedAt)) {
      prByHead.set(pr.headRef, pr);
    }
  }

  // Index task branches (omah/X) so state branches can find them.
  const taskBranches = new Map<string, BranchInfo>();
  // Track which state branches actually exist, so we don't push paired
  // decisions for names that aren't there.
  const existingStateBranches = new Set<string>();
  for (const b of branches) {
    if (/^omah\/[a-z0-9-]+$/.test(b.name)) {
      taskBranches.set(b.name, b);
    } else if (/^omah-state\/omah-[a-z0-9-]+$/.test(b.name)) {
      existingStateBranches.add(b.name);
    }
  }

  const handledStateBranches = new Set<string>();

  // -------- Rules on task branches (omah/X) --------
  for (const [name, info] of taskBranches) {
    const pr = prByHead.get(name);
    const decision = decideTaskBranch(info, pr, nowMs);

    if (decision) {
      decisions.push(decision);

      const stateName = stateBranchFor(name);
      if (stateName && existingStateBranches.has(stateName)) {
        handledStateBranches.add(stateName);
        decisions.push({
          branch: stateName,
          rule: decision.rule,
          reason: `paired with ${name} (${decision.reason})`,
        });
      }
    }
  }

  // -------- Rules on orphan state branches --------
  for (const b of branches) {
    if (!/^omah-state\/omah-[a-z0-9-]+$/.test(b.name)) continue;
    if (handledStateBranches.has(b.name)) continue;

    const taskName = taskBranchFor(b.name);
    if (!taskName) continue;

    // If the corresponding task branch still exists, its rules already
    // decided above. Skip.
    if (taskBranches.has(taskName)) continue;

    const pr = prByHead.get(taskName);
    const decision = decideOrphanStateBranch(b, pr, nowMs);
    if (decision) decisions.push(decision);
  }

  return decisions;
}

function decideTaskBranch(
  info: BranchInfo,
  pr: PrInfo | undefined,
  nowMs: number,
): DeleteDecision | null {
  const name = info.name;

  // Rule 1: merged.
  if (pr && pr.merged) {
    return { branch: name, rule: 1, reason: `PR #${pr.number} merged` };
  }

  // Rule 2: closed, not merged.
  if (pr && pr.state === "closed" && !pr.merged) {
    return {
      branch: name,
      rule: 2,
      reason: `PR #${pr.number} closed without merge`,
    };
  }

  // Rules 4/5: open PR.
  if (pr && pr.state === "open") {
    const ageMs = nowMs - Date.parse(pr.updatedAt);
    if (pr.draft) {
      if (ageMs > RULES.DRAFT_PR_AGE_MS) {
        return {
          branch: name,
          rule: 5,
          reason: `draft PR #${pr.number} idle ${days(ageMs)}d`,
        };
      }
      return null;
    }
    if (ageMs > RULES.OPEN_PR_AGE_MS) {
      return {
        branch: name,
        rule: 4,
        reason: `open PR #${pr.number} idle ${days(ageMs)}d`,
      };
    }
    return null;
  }

  // Rule 3: no PR, age based on branch's last commit.
  if (!pr && info.lastCommitAt) {
    const ageMs = nowMs - Date.parse(info.lastCommitAt);
    if (ageMs > RULES.ORPHAN_AGE_MS) {
      return { branch: name, rule: 3, reason: `no PR, age ${days(ageMs)}d` };
    }
  }

  return null;
}

function decideOrphanStateBranch(
  info: BranchInfo,
  pr: PrInfo | undefined,
  nowMs: number,
): DeleteDecision | null {
  const name = info.name;

  if (pr) {
    if (pr.merged) {
      return {
        branch: name,
        rule: 1,
        reason: `PR #${pr.number} merged, task branch gone`,
      };
    }
    if (pr.state === "closed") {
      return {
        branch: name,
        rule: 2,
        reason: `PR #${pr.number} closed, task branch gone`,
      };
    }
    if (pr.state === "open") {
      const ageMs = nowMs - Date.parse(pr.updatedAt);
      if (pr.draft && ageMs > RULES.DRAFT_PR_AGE_MS) {
        return {
          branch: name,
          rule: 5,
          reason: `draft PR #${pr.number} idle ${days(ageMs)}d, task branch gone`,
        };
      }
      if (!pr.draft && ageMs > RULES.OPEN_PR_AGE_MS) {
        return {
          branch: name,
          rule: 4,
          reason: `open PR #${pr.number} idle ${days(ageMs)}d, task branch gone`,
        };
      }
      return null;
    }
  }

  // No PR. Age from the state branch's own last commit.
  if (info.lastCommitAt) {
    const ageMs = nowMs - Date.parse(info.lastCommitAt);
    if (ageMs > RULES.ORPHAN_AGE_MS) {
      return {
        branch: name,
        rule: 3,
        reason: `no PR, age ${days(ageMs)}d`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Name mapping
// ---------------------------------------------------------------

/** "omah/X" -> "omah-state/omah-X" */
export function stateBranchFor(taskBranch: string): string | null {
  if (!/^omah\/[a-z0-9-]+$/.test(taskBranch)) return null;
  return `omah-state/${taskBranch.replace("/", "-")}`;
}

/** "omah-state/omah-X" -> "omah/X" */
export function taskBranchFor(stateBranch: string): string | null {
  if (!/^omah-state\/omah-[a-z0-9-]+$/.test(stateBranch)) return null;
  return `omah/${stateBranch.slice("omah-state/omah-".length)}`;
}

// ---------------------------------------------------------------
// Internal
// ---------------------------------------------------------------

function days(ms: number): number {
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}
