# Omah

A personal coding agent that runs on GitHub Actions, accepts a repo and a task,
works in a disposable runner, and delivers its result as a GitHub pull request.

**Repo in, PR out. From your phone. For free. While you sleep.**

---

## What it is

Omah is a single-file TypeScript agent (`agent.ts`) plus a GitHub Actions
workflow (`.github/workflows/omah.yml`). You trigger the workflow with a target
repo and a task description. Omah:

1. Mints a short-lived GitHub App token scoped to the target repo.
2. Clones the target repo into the runner.
3. Runs an LLM-driven loop: explore, read, write, verify, commit.
4. Generates a patch and applies it to a fresh clone.
5. Opens a pull request against the target repo.

The PR is the review boundary. Omah never merges.

## What it is not

- Not a SaaS. Personal tool, single user.
- Not multi-tenant. One GitHub App, one user.
- Not auto-merging. Ever.
- Not a general-purpose agent. It writes code and opens PRs.
- Not parallel. The workflow's `concurrency` setting serializes runs.

## How it works

See `ARCHITECTURE.md` for the full design. The short version:

```text
Trigger -> mint token -> clone target -> agent loop -> patch -> fresh clone -> push -> PR
```

The agent runs as an unprivileged user (`omah-runner`) inside the runner. Every
authenticated git operation runs as the orchestrator user, in a directory the
agent cannot touch. Tokens travel via environment variables, never command-line
arguments. See "Security model" below.

## Setup

### 1. Create the GitHub App

Settings → Developer settings → GitHub Apps → **New GitHub App**.

- **Name:** `omah-agent` (or anything unique on GitHub)
- **Homepage URL:** this repo
- **Webhook:** inactive
- **Repository permissions:**
  - Contents: Read and write
  - Pull requests: Read and write
- **Where can this app be installed:** Only on this account

Click **Create GitHub App**. Note the **App ID** (a number).

Generate a private key (**Generate a private key** button at the bottom). A
`.pem` file downloads. Copy its full contents, including the BEGIN/END lines.

Install the App on the repo you want Omah to work on (Install App in the left
sidebar, then select the target repo).

### 2. Add repository secrets

In this repo: **Settings → Secrets and variables → Actions → Secrets**.

| Name | Value |
|---|---|
| `GEMINI_KEYS` | JSON array of Gemini API keys, e.g. `["key1","key2"]` |
| `OMAH_APP_ID` | The App ID from step 1 |
| `OMAH_APP_PRIVATE_KEY` | The full `.pem` contents |

### 3. Add repository variables

Same page, **Variables** tab.

| Name | Value | Required |
|---|---|---|
| `OMAH_APP_BOT_ID` | The App's bot user id | **Yes** |
| `OMAH_ALLOWED_REPOS` | Comma-separated `owner/name` allowlist | No |

To get the bot user id:

```bash
gh api "/users/omah-agent[bot]" --jq .id
```

(`omah-agent` is the App's slug — the name you chose, not the App ID.)

## Usage

Actions → **Omah** → **Run workflow**.

| Input | Notes |
|---|---|
| Target repo | `owner/name` |
| Task | What you want done. Plain English. |
| Base branch | Blank uses the repo's default branch. |
| Resume | Check to resume an existing Omah branch. |
| Branch | Required if resume is checked. |
| Resume text | Follow-up instruction, required if resume is checked. |

The workflow is serial: one run at a time. If you trigger a second while one is
running, it queues.

## Writing files (protocol)

Omah's agent does not embed file contents inside JSON — that breaks on escaping.
Instead, the agent uses a two-step handshake:

1. Agent emits: `{"reasoning": "...", "tool": "request_write", "args": {"path": "foo.js"}}`
2. Harness replies: "Reply with the raw contents."
3. Agent emits the raw file contents (not JSON), ending with a line containing
   only `<<<OMAH_END>>>`.
4. Harness writes the file and continues.

Large files can be split across messages. Each non-final chunk ends with
`<<<OMAH_MORE>>>`. The harness concatenates chunks and writes the assembled file.
A reply with no sentinel line is rejected and nothing is written.

Limits: 200 KB per chunk, 500 KB per file. Above that, the write fails with a
tool error and the agent is expected to finish as `blocked`.

## Security model

The agent runs untrusted LLM-generated commands. The design assumes it may
eventually do something unexpected.

- **Disposable runner.** GitHub Actions provides an ephemeral VM per run.
- **Unprivileged agent user.** The agent runs as `omah-runner`, not `runner`.
  It cannot read runner files or the runner's process environments.
- **No authenticated git in the workspace.** The agent commits locally; the
  orchestrator generates a patch and applies it to a fresh clone it controls.
- **Env-var-only auth.** Tokens travel via `GIT_CONFIG_*` env vars, never
  argv. `/proc/<pid>/environ` is only readable by the same user.
- **Scoped App token.** Minted per run, scoped to one repo, expires in an hour.
- **Process kill before push.** `pkill -9 -u omah-runner` runs after the loop,
  so no agent process survives into the push phase.
- **`.omahignore` enforcement.** Files matching the default or repo-provided
  ignore patterns are deleted from the workspace before the agent starts.
- **Commit-layer path checks.** `.git/`, `.github/`, submodules, and any path
  matching the ignore patterns are rejected before the patch is applied.

**What this does not protect against:**

- A repo whose git history contains secrets. Omah cannot un-see what's already
  committed. Don't point it at repos with secrets in their history.
- Network egress. The runner's internet access is open, so the agent can send
  repo contents anywhere.
- The ignore list is advisory against a determined agent (for example,
  `git restore` brings a deleted tracked file back into the workspace). The
  commit-layer check stops it from being committed, not from being read.

## Isolation canary

Every run performs a canary check before the agent starts. It verifies that
`omah-runner` cannot:

- list `/home/runner`
- list `$RUNNER_TEMP`
- read `$GITHUB_ENV` or list `$GITHUB_WORKSPACE`
- read another process's environment (`/proc/*/environ`)
- run `sudo`
- access Docker

And that it *can* run `node`, `git`, and write to its own home directory.

If any check fails, the job stops before the agent runs. The canary runs on
every job because isolation is a property of the runner's configuration, and
that configuration can change out from under you.

## Repository contents

```text
.github/workflows/omah.yml   The workflow. Trigger, setup, canary, cleanup.
agent.ts                     The agent loop. Single file, no build step.
system.md                    The system prompt. Versioned.
.omahignore.default          Default ignore patterns for every run.
package.json                 Deps: @google/genai, ignore. Dev: tsx, typescript.
tsconfig.json                TypeScript config for tsx.
```

## Limits and known gaps

- **Wall-clock budget: 15 minutes.** The agent stops at the limit and reports
  `blocked`. The workflow has a 30-minute hard timeout as a backstop.
- **Consecutive tool errors: 3.** Three failures in a row stops the loop.
- **Chunk writes are not resumable.** If a run is interrupted mid-write, the
  partial chunks are lost. The agent has to re-issue `request_write`.
- **Free-tier Gemini keys have per-minute and per-day caps.** Rotating across
  multiple keys helps only if they're in different Google Cloud projects.
- **`node_modules` tracking on target repos.** If the target repo still tracks
  `node_modules`, the first agent step that runs `npm install` will produce a
  phantom modification. Run `git rm -r --cached node_modules` on the target
  repo once to fix it.
- **Parse failures on malformed JSON.** Rare but not zero. The loop logs the
  first 2,000 characters and retries.

## Running locally

There is no local-run story yet. `agent.ts` expects GitHub Actions environment
variables (`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, an `omah-runner` user, etc.)
and it writes to `/tmp/omah`. A local wrapper is on the roadmap but not built.

## History

See `ARCHITECTURE.md` for the design decisions and the reasoning behind them.

## License

ISC
