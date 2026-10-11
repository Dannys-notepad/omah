# Omah

**A GitHub Actions coding agent**

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

- **JS/TS-first, full-stack.** Omah focuses on JavaScript and TypeScript across
  Node.js backends, browser frontends, and shared packages, following the
  target repository's existing framework and conventions.
- **Asynchronous.** Submit a task and walk away. Check on it later.
- **Cloud-hosted.** Every operation happens on a GitHub-hosted runner. Your
  devices only submit and read.
- **PR-shaped.** The agent's output arrives as a GitHub pull request, not a
  diff to apply.
- **Trust-bounded.** No auto-merge, ever. The PR is the review boundary.
- **Free.** Free Gemini, Groq, Mistral, NVIDIA, Poolside, and Requesty keys
  with rotation. Free Supabase and Hugging Face would be overkill — Omah uses
  the GitHub runner and a state branch instead.
- **Serial.** Agent and cleanup workflows share a concurrency group, so only
  one runs at a time. GitHub Actions can queue up to 100 pending runs.

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
separate service, database, or queue service; GitHub Actions handles queued
runs. The workflows are the whole system.

1. **Trigger.** You run the `Omah` workflow with a repo and a task.
2. **Setup.** The workflow creates an unprivileged user (`omah-runner`), runs an
   isolation canary, and mints a short-lived GitHub App token scoped to the
   target repo.
3. **Loop.** The agent clones the repo, calls an LLM, executes tool calls
   (`read_file`, `request_write`, `run_bash`, `git_commit`, `finish`), and
   repeats until it finishes or hits a budget.
4. **Patch.** The orchestrator stages workspace changes and captures them as a
  binary-safe patch; an explicit agent commit is not required.
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

## CLI

The CLI requires Node.js, npm, and GitHub CLI (`gh`) authenticated with access
to the repository that hosts Omah's `omah.yml` workflow. From the Omah checkout,
run `npm link` to install the local `omah` command. The control repo is separate
from the target repo being changed and is stored locally; no GitHub credentials
are written to the CLI config.

```sh
npm link
omah config set control-repo owner/omah
omah run --repo owner/project --task "Add retry handling and tests"
omah run --repo owner/project --task-file task.md --provider groq
omah resume --repo owner/project --branch omah/fix-login-a1b2c3d4 --task-file review-notes.md
omah status
omah status --run-id 123456789
```

Use `--control-repo owner/omah` to override the configured control repo for one
command, or set `OMAH_CONTROL_REPO`. Task files are read from the current
directory and support multiline prompts up to 60,000 characters. `omah status`
shows the latest Omah workflow run, which may not be the run just dispatched;
use `--run-id` when you know the specific ID. A successful dispatch means
GitHub accepted the request, not necessarily that the run has started yet.

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

Normal turns use provider-native function calls, normalized to one internal
call shape and checked against per-tool argument schemas. If an endpoint
explicitly rejects function-calling fields, its adapter retries once without
tool declarations and accepts one canonical JSON envelope. Poolside has a
narrow compatibility parser for its flat and JSON-wrapped `<tool_call>` forms;
ambiguous or schema-invalid responses are rejected for a retry.

**Why a two-step write.** File bytes are sent as raw text rather than escaped
inside JSON, so long contents do not need to fit in a JSON string. The
`request_write` handshake sends file bytes as a separate raw-text turn: the
model requests a path, the harness asks for the contents, and the model replies
in plain text. Function declarations are disabled for that payload turn.

**Budgets.** Two, both enforced from the first step:
- **Wall-clock:** 15 minutes.
- **Consecutive tool errors:** 3.

**Terminal states.**
- `done` — the task completes successfully; if it produced changes, the PR is
  opened ready for review.
- `blocked` — the agent cannot continue, for example after exhausting its
  budget or available keys. If there are changes, it opens a draft PR with an
  explanation.
- Workflow failures before a terminal agent result are reported as failed runs;
  GitHub cancellation is handled by the workflow runner.

---

## Providers and key rotation

Omah uses free-tier LLM keys from several providers. Each provider has its own
rate limits, and every one of them is a constraint. The rotation tries keys in
a fixed order and moves to the next when a key hits a limit.

The default order is:

1. **Gemini** — 20 requests/day per key. Reliable until the cap.
2. **Poolside** — direct API, `poolside/laguna-s-2.1`.
3. **Requesty** — routes to multiple models, 200 requests/day per account.
4. **Groq** — 8,000 tokens/minute. Two or three calls before it cools.
5. **Mistral** — per-account rate limit; all keys share the same bucket.
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

The agent calls `request_write` with a path (or uses the canonical JSON
fallback envelope if its provider has no function-calling support). The
harness then asks for raw contents, and the agent replies with the file bytes
ending in `<<<OMAH_END>>>`.

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

**Automated tests.** The dedicated test workflow runs `npm test` on pull
requests and pushes to `main`. The suite covers tool-call parsing, argument
validation, OpenAI-compatible response normalization, and loop failure cases.
The separately dispatched hostile workflow tests runner isolation and token
exfiltration defenses; its latest recorded result is in
`HOSTILE-TEST-STATUS.md`. Network egress and kernel-level attacks remain out of
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
├── bin/
│   └── omah.js                 # cross-platform CLI
├── cleanup.ts                  # branch cleanup script
├── system.md                   # the system prompt
├── .omahignore.default         # default ignore patterns
├── package.json
├── package-lock.json
├── tsconfig.json
├── .github/
│   └── workflows/
│       ├── omah.yml            # production workflow
│       ├── omah-hostile.yml    # adversarial security test
│       ├── omah-cleanup.yml    # daily branch cleanup
│       └── tests.yml           # unit-test CI
│       └── tests.yml           # unit-test CI
├── src/
│   ├── llm.ts                  # provider abstraction and key loading
│   ├── keystate.ts             # keys.json + repositories.json persistence
│   ├── cleanup-rules.ts        # pure decision function for cleanup
│   └── tool-contract.ts        # shared schemas, validation, and text fallback parser
└── test/
    ├── agent-loop.test.ts      # loop failure-mode regression tests
  ├── cli.test.js             # CLI parsing and dispatch argument tests
    ├── llm-tools.test.ts       # provider request/response adapter tests
    ├── tool-contract.test.ts   # parser and schema validation tests
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
- **Conditional frontend browser checks.** Use existing browser tooling, with
  optional pinned Playwright provisioning when a task explicitly needs it.
- **Comment-resume flow.** Reply to a blocked PR and the agent continues. The
  loop already supports resume; the workflow trigger is missing.
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
