# Omah

**A github action based conding agent**

Omah is a personal coding agent that runs on GitHub Actions, uses free-tier LLM
keys with automatic rotation, and delivers its work as a pull request you review
from your phone.

You submit a repo and a task. Omah clones the repo into an ephemeral runner,
runs an agent loop that explores, edits, and tests, then opens a PR against the
target repo. You review the diff. You merge, or you don't. Omah never merges.

---

## What it is

A single TypeScript agent plus a small set of workflows, running entirely on
GitHub Actions and free-tier infrastructure.

- **Asynchronous.** Submit a task and walk away. Check on it later.
- **Cloud-hosted.** Every operation happens on a GitHub-hosted runner. Your
  devices only submit and read.
- **PR-shaped.** The agent's output arrives as a GitHub pull request, not a
  diff to apply.
- **Trust-bounded.** No auto-merge, ever. The PR is the review boundary.
- **Free.** Free Gemini, Groq, Mistral, NVIDIA, Poolside, and Requesty keys
  with rotation. Free Supabase and Hugging Face would be overkill — Omah uses
  the GitHub runner and a state branch instead.
- **Serial.** One task at a time, by design. A review discipline more than a
  technical limit.

## What it is not

- Not a SaaS. Personal tool, single user.
- Not multi-tenant. One App, one token, one user.
- Not auto-merging. Ever, not even opt-in.
- Not a general-purpose agent. It writes code and opens PRs, nothing else.
- Not parallel. The workflow's concurrency group serializes runs.
- Not a chat tool. You submit tasks and review results; there is no conversation.

---

## How it works

```
Trigger → mint token → clone target → agent loop → patch → fresh clone → push → PR
```

The GitHub Actions runner is both the orchestrator and the sandbox. There is no
separate service, no database, no queue. The workflow is the whole system.

1. **Trigger.** You run the `Omah` workflow with a repo and a task.
2. **Setup.** The workflow creates an unprivileged user (`omah-runner`), runs an
   isolation canary, and mints a short-lived GitHub App token scoped to the
   target repo.
3. **Loop.** The agent clones the repo, calls an LLM, executes tool calls
   (`read_file`, `request_write`, `run_bash`, `git_commit`, `finish`), and
   repeats until it finishes or hits a budget.
4. **Patch.** The agent's committed changes are captured as a binary-safe patch.
5. **Push.** The orchestrator applies the patch to a fresh clone it controls —
   not the workspace the agent wrote to — and pushes a branch.
6. **PR.** The orchestrator opens a pull request with a decision log.
7. **Notify.** Email on terminal state, with a deep link to the PR.

---

## Setup

### 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

- **Name:** `omah-agent` (or anything unique)
- **Homepage URL:** this repo
- **Webhook:** inactive
- **Repository permissions:**
  - Contents: Read and write
  - Pull requests: Read and write
- **Where can this app be installed:** Only on this account

After creation, note the **App ID**. Generate a **private key** (downloads a
`.pem` file). Install the App on every repo Omah should touch — including the
Omah repo itself (for state persistence).

### 2. Add repository secrets

Settings → Secrets and variables → Actions → **Secrets** tab.

| Name | Value |
|---|---|
| `GEMINI_KEYS` | JSON array of Gemini keys, e.g. `["key1","key2"]` |
| `GROQ_KEYS` | JSON array of Groq keys |
| `MISTRAL_KEYS` | JSON array of Mistral keys |
| `NVIDIA_KEYS` | JSON array of NVIDIA keys |
| `REQUESTY_KEYS` | JSON array of Requesty keys |
| `POOLSIDE_KEYS` | JSON array of Poolside keys |
| `OMAH_APP_ID` | The App ID from step 1 |
| `OMAH_APP_PRIVATE_KEY` | The full contents of the `.pem` file |

### 3. Add repository variables

Same page, **Variables** tab.

| Name | Value | Required |
|---|---|---|
| `OMAH_APP_BOT_ID` | The App's bot user id | Yes |
| `OMAH_META_REPO` | `owner/omah` — for state persistence | Yes |
| `OMAH_ALLOWED_REPOS` | Comma-separated allowlist | No |
| `OMAH_DISABLED_PROVIDERS` | Comma-separated providers to skip | No |
| `OMAH_CLEANUP_DRY_RUN` | `true` to dry-run cleanup | No |
| `AUTHOR_NAME` | Git author name for commits | No |
| `AUTHOR_EMAIL` | Git author email (verified on GitHub) | No |

**To get the bot user id:**

```
gh api "/users/omah-agent[bot]" --jq .id
```

### 4. Trigger a task

Actions → **Omah** → **Run workflow**.

---

## Usage

| Input | Notes |
|---|---|
| Target repo | `owner/name` |
| Task | What you want done. Plain English. |
| Base branch | Blank uses the repo's default branch. |
| Provider | Optional. `default`, `gemini`, `poolside`, `requesty`, `mistral`, `groq`, `nvidia`. |
| Resume | Check to resume an existing Omah branch. |
| Branch | Required if resume is checked. |
| Resume text | Follow-up instruction, required if resume is checked. |

The workflow is serial: one run at a time.

---

## The agent loop

The agent has exactly five tools.

- **`read_file(path)`** — read a file from the workspace.
- **`request_write(path)`** — begin writing a file. The harness asks for the
  raw contents next, and the model sends them as plain text with a sentinel
  line (`<<<OMAH_END>>>`). Large files are split across chunks with
  `<<<OMAH_MORE>>>`.
- **`run_bash(command)`** — run a shell command in the workspace.
- **`git_commit(message)`** — commit all changes in the workspace.
- **`finish(summary, status)`** — end the task. `status` is `"done"` or
  `"blocked"`.

**Why a two-step write.** Content goes inside JSON strings. Long files break
JSON when the model emits raw newlines. The `request_write` handshake sidesteps
the problem: the model calls `request_write(path)`, the harness asks for the
raw contents, and the model replies in plain text.

**Budgets.** Two, both enforced from the first step:
- **Wall-clock:** 15 minutes.
- **Consecutive tool errors:** 3.

**Terminal states.**
- `done` — changes committed, tests passing, PR opened as ready for review.
- `blocked_needs_human` — the agent cannot proceed. It committed what it had
  and opened a draft PR with an explanation. `blocked` is a first-class
  outcome, not a failure.
- `failed_permanent` — a budget ran out or a non-retryable error occurred.
- `cancelled` — the user requested cancellation.

---

## Providers and key rotation

Omah uses free-tier LLM keys from several providers. Each provider has its own
rate limits, and every one of them is a constraint. The rotation tries keys in
a fixed order and moves to the next when a key hits a limit.

The default order is:

1. **Gemini** — 20 requests/day per key. Reliable until the cap.
2. **Poolside** — direct API, `poolside/laguna-s-2.1`.
3. **Requesty** — routes to multiple models, 200 requests/day per account.
4. **Mistral** — per-account rate limit; all keys share the same bucket.
5. **Groq** — 8,000 tokens/minute. Two or three calls before it cools.
6. **NVIDIA** — often 503-overloaded. Last resort.

**Key state is persisted.** When a key hits a per-day limit, Omah records it in
`keys.json` on an orphan `omah-meta` branch. The next run skips that key until
its reset time. This is why the daily limit doesn't have to be rediscovered
every time.

**Errors are classified.** Quota errors cool the key. Retryable errors
(5xx, network) cool the whole provider for five minutes. Rotate errors
(401/403/404/410, plus JSON-validate 400s) skip the entire provider. If all
keys are exhausted, the run ends `blocked` with a clear summary.

---

## Writing files (the `request_write` protocol)

The agent does not embed file contents inside JSON. Instead:

1. Agent emits `{"reasoning": "...", "tool": "request_write", "args": {"path": "foo.js"}}`.
2. Harness replies: "Reply with the raw contents."
3. Agent emits the file's bytes as plain text, ending with `<<<OMAH_END>>>`.
4. Harness writes the file.

Large files are split across messages with `<<<OMAH_MORE>>>` between chunks.
The harness concatenates them. Limits: 200 KB per chunk, 500 KB per file.

---

## Security model

The agent runs untrusted, LLM-generated commands. The design assumes it may
eventually do something unexpected.

- **Disposable runner.** GitHub Actions provides an ephemeral VM per run.
- **Unprivileged agent user.** The agent runs as `omah-runner`, not as the
  workflow user. It cannot read runner files, environment variables, or
  process state.
- **No authenticated git in the workspace.** The agent commits locally; the
  orchestrator generates a patch and applies it to a fresh clone it controls.
  The workspace holds no credentials.
- **Env-var-only auth.** Tokens travel via `GIT_CONFIG_*` environment variables,
  never argv. `/proc/<pid>/environ` is only readable by the same user.
- **Scoped App token.** Minted per run, scoped to one repo, expires in an hour.
- **Process kill before push.** `pkill -9 -u omah-runner` runs after the loop,
  so no agent process survives into the push phase.
- **`.omahignore` enforcement.** Files matching the default or repo-provided
  ignore patterns are deleted from the workspace before the agent starts.
- **Commit-layer path checks.** `.git/`, `.github/`, submodules, and any path
  matching the ignore patterns are rejected at patch-apply time.

**What this does not protect against:** a repo whose git history contains
secrets. Omah cannot un-see what is already committed. Do not point it at
repos with secrets in their history.

**The hostile test.** Every workflow change is verified by an adversarial test
that deliberately attempts to exfiltrate the token through git redirects,
pre-commit hooks, `/proc` reads, and background processes. The test passes on
the current runner image. Network egress and kernel-level attacks are out of
scope.

---

## Cleanup

Omah creates two kinds of branches per task:

- `omah/<slug>-<id>` — the PR branch.
- `omah-state/omah-<slug>-<id>` — the conversation state, on the target repo.

These accumulate. A daily cleanup workflow prunes them according to explicit
rules:

| Rule | Condition | Deletes |
|---|---|---|
| 1 | PR merged | task branch and state branch |
| 2 | PR closed, not merged | task branch and state branch |
| 3 | No PR, branch older than 2 days | task branch and state branch |
| 4 | Open PR idle more than 2 days | task branch and state branch |
| 5 | Draft PR idle more than 5 days | task branch and state branch |

Open PRs younger than their window are never touched. Cleanup skips a run if
`omah.yml` has an in-progress or queued task. `omah-meta` is never deleted.

**Manual cleanup.** The cleanup workflow also accepts a manual dispatch for a
full wipe of every Omah branch in a target repo. Requires typing `DELETE` to
confirm. This closes every open Omah PR in scope, including drafts awaiting
resume.

---

## Repository layout

```
.
├── agent.ts                    # the agent loop — entry point
├── cleanup.ts                  # branch cleanup script
├── system.md                   # the system prompt
├── .omahignore.default         # default ignore patterns
├── package.json
├── tsconfig.json
├── .github/
│   └── workflows/
│       ├── omah.yml            # production workflow
│       ├── omah-hostile.yml    # adversarial security test
│       └── omah-cleanup.yml    # daily branch cleanup
├── src/
│   ├── llm.ts                  # provider abstraction and key loading
│   ├── keystate.ts             # keys.json + repositories.json persistence
│   └── cleanup-rules.ts        # pure decision function for cleanup
└── test/
    ├── hostile-task.json       # scripted attack responses
    ├── attack.sh               # pre-run setup for the hostile test
    ├── check.sh                # post-run checker
    ├── plant.sh                # plants git config and hooks
    ├── sniff.sh                # background token sniffer
    └── sink.ts                 # local HTTP sink
```

---

## Limits and known gaps

- **15-minute wall-clock budget.** Long tasks end `blocked`. Break large work
  into smaller tasks.
- **3 consecutive tool errors.** Three failures in a row stop the loop.
- **Chunk writes are not resumable.** If a run is interrupted mid-write, the
  partial chunks are lost. The agent has to re-issue `request_write`.
- **Free-tier keys have hard caps.** Gemini is 20/day per key; Groq is 8k TPM.
  Plan for the ceiling, not the average.
- **No self-review pass yet.** The agent verifies with tests and a final read,
  but there is no structured check between "the agent believes it's done" and
  "the PR opens."
- **No history compression.** Input tokens grow with step count. Long tasks
  burn more free-tier capacity than they need to.
- **One model at a time.** No fast-model / strong-model split. The rotation
  uses one provider per turn.

---

## Roadmap

These are planned or under consideration. None are committed.

- **Self-review pass.** A structured check the agent runs before `finish`.
- **History compression.** Summarize old tool results to reduce tokens per call.
- **Native tool calls.** Replace the JSON-in-text tool protocol with each
  provider's structured function-calling API. Eliminates a class of parse
  failures across providers.
- **Comment-resume flow.** Reply to a blocked PR and the agent continues. The
  loop already supports resume; the workflow trigger is missing.
- **CLI wrapper.** A small Node binary for submitting tasks from a terminal.
- **Scheduled tasks.** Recurring prompts, e.g. weekly dependency upgrades.

---

## The pitch

You want to offload coding tasks — fix this test, refactor this module, add
this endpoint — but your laptop is low on RAM and your time is limited. Agents
are useful but you don't trust them to merge without review. Free API keys
exist but have quotas you don't want to burn blindly.

Omah is the answer to that. It lives in the cloud, runs on free tiers, uses the
keys you already have, and gives you a PR to review from wherever you are.

Repo in, PR out. From your phone. For free.

---

## License

ISC
