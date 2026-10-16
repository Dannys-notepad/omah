# Omah

**A GitHub Actions coding agent**

Omah is a personal coding agent that runs on GitHub Actions, uses free-tier LLM keys with automatic rotation, and delivers its work as a pull request you review from your phone.

You submit a repo and a task. Omah clones the repo into an ephemeral runner, runs an agent loop that explores, edits, and tests, runs an independent review gate on the result, then opens a PR against the target repo. You review the diff. You merge, or you don't. Omah never merges.

---

## What it is

A single TypeScript agent plus a small set of workflows, running entirely on GitHub Actions and free-tier infrastructure.

- **JS/TS-first, full-stack.** Omah focuses on JavaScript and TypeScript across Node.js backends, browser frontends, and shared packages, following the target repository's existing framework and conventions.
- **Asynchronous.** Submit a task and walk away. Check on it later.
- **Cloud-hosted.** Every operation happens on a GitHub-hosted runner. Your devices only submit and read.
- **PR-shaped.** The agent's output arrives as a GitHub pull request, not a diff to apply.
- **Reviewed before push.** A review gate runs fresh tests, scans the diff for debug code and secrets, and calls a separate model that only sees the diff. It never sees the agent's reasoning.
- **Trust-bounded.** No auto-merge, ever. The PR is the review boundary.
- **Compressed history.** Old tool results are stubbed, so input tokens stay flat on long runs instead of growing linearly with step count.
- **Free.** Free Gemini, Groq, Mistral, NVIDIA, Poolside, and Requesty keys with rotation. Free Supabase and Hugging Face would be overkill — Omah uses the GitHub runner and a state branch instead.
- **Serial.** Agent and cleanup workflows share a concurrency group, so only one runs at a time. GitHub Actions can queue up to 100 pending runs.

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
Trigger → mint token → clone target → agent loop → patch → review gate → fresh clone → push → PR
```

The GitHub Actions runner is both the orchestrator and the sandbox. There is no separate service, database, or queue service; GitHub Actions handles queued runs. The workflows are the whole system.

1. **Trigger.** You run the `Omah` workflow with a repo and a task, or use the `omah` CLI.
2. **Setup.** The workflow creates an unprivileged user (`omah-runner`), runs an isolation canary, and mints a short-lived GitHub App token scoped to the target repo.
3. **Loop.** The agent clones the repo, calls an LLM, executes tool calls (`read_file`, `request_write`, `run_bash`, `git_commit`, `finish`), and repeats until it finishes or hits a budget. Old tool results are compressed as the conversation grows.
4. **Patch.** The orchestrator stages workspace changes and captures them as a binary-safe patch; an explicit agent commit is not required.
5. **Review gate.** Fresh tests run as `omah-runner` with a 3-minute cap. A deterministic scan checks the diff for debug code and secrets. A separate model reviews the diff against the task and returns a verdict.
6. **Fix round (conditional).** If the gate finds medium or high concerns and at least 4 minutes remain, the loop re-enters once with the findings as a follow-up message.
7. **Push.** The orchestrator applies the patch to a fresh clone it controls — not the workspace the agent wrote to — and pushes a branch. If a secret survived the fix round, the push is refused.
8. **PR.** The orchestrator opens a pull request with a decision log. A PR with unresolved concerns opens as a draft.
9. **Notify.** Email on terminal state, with a deep link to the PR.

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

After creation, note the **App ID**. Generate a **private key** (downloads a `.pem` file). Install the App on every repo Omah should touch — including the Omah repo itself (for state persistence).

### 2. Add repository secrets

Settings → Secrets and variables → Actions → **Secrets** tab. **These go on the control repo** — the repo that hosts `omah.yml`, not each target repo.

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

Same page, **Variables** tab. **Also on the control repo.**

| Name | Value | Required |
|---|---|---|
| `OMAH_APP_BOT_ID` | The App's bot user id | Yes |
| `OMAH_META_REPO` | `owner/omah` — for state persistence | Yes |
| `OMAH_ALLOWED_REPOS` | Comma-separated allowlist | No |
| `OMAH_DISABLED_PROVIDERS` | Comma-separated providers to skip | No |
| `OMAH_SHARED_QUOTA_PROVIDERS` | Providers whose API keys share one quota bucket, e.g. `gemini` | No |
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

The CLI requires Node.js, npm, and GitHub CLI (`gh`) authenticated with access to the repository that hosts Omah's `omah.yml` workflow. From the Omah checkout, run `npm link` to install the local `omah` command. The control repo is separate from the target repo being changed and is stored locally; no GitHub credentials are written to the CLI config.

```
npm link
omah config set control-repo owner/omah
omah run --repo owner/project --task "Add retry handling and tests"
omah run --repo owner/project --task-file task.md --provider groq
omah resume --repo owner/project --branch omah/fix-login-a1b2c3d4 --task-file review-notes.md
omah status
omah status --run-id 123456789
```

Use `--control-repo owner/omah` to override the configured control repo for one command, or set `OMAH_CONTROL_REPO`. Task files are read from the current directory and support multiline prompts up to 60,000 characters. `omah status` shows the latest Omah workflow run, which may not be the run just dispatched; use `--run-id` when you know the specific ID. A successful dispatch means GitHub accepted the request, not necessarily that the run has started yet.

---

## The agent loop

The agent has exactly five tools.

- **`read_file(path)`** — read a file from the workspace.
- **`request_write(path)`** — begin writing a file. The harness asks for the raw contents next, and the model sends them as plain text with a sentinel line (`<<<OMAH_END>>>`). Large files are split across chunks with `<<<OMAH_MORE>>>`.
- **`run_bash(command)`** — run a shell command in the workspace.
- **`git_commit(message)`** — commit all changes in the workspace.
- **`finish(summary, status)`** — end the task. `status` is `"done"` or `"blocked"`.

Normal turns use provider-native function calls, normalized to one internal call shape and checked against per-tool argument schemas. If an endpoint explicitly rejects function-calling fields, its adapter retries once without tool declarations and accepts one canonical JSON envelope. Poolside has a narrow compatibility parser for its flat and JSON-wrapped `<tool_call>` forms; ambiguous or schema-invalid responses are rejected for a retry.

**Why a two-step write.** File bytes are sent as raw text rather than escaped inside JSON, so long contents do not need to fit in a JSON string. The `request_write` handshake sends file bytes as a separate raw-text turn: the model requests a path, the harness asks for the contents, and the model replies in plain text. Function declarations are disabled for that payload turn.

**Budgets.** Two, both enforced from the first step:

- **Wall-clock:** 15 minutes.
- **Consecutive tool errors:** 3.

**History compression.** Tool results accumulate in the conversation and are resent on every model call, so input tokens would grow linearly with step count. Once history passes either 6 steps since the last pass or 4,000 estimated tokens, `src/history.ts` stubs the oldest tool-result bodies:

- Old `read_file` results become a one-line summary with a re-read hint.
- Pre-edit reads stay verbatim while the edit is fresh and small, then get a `git show <startSha>:<path>` hint.
- Long `run_bash` results keep head 10 and tail 20 lines. The digest below is what survives.
- A progress ledger is appended to the task message: files read, files written, commits made, last test summary.

**The `run_bash` digest.** At capture time, before truncation, the harness extracts the exit code, up to 15 key lines matching `fail|error|✗|TypeError|...`, a total match count, and the final test summary line. The digest survives compression and resume, so failing test names stay visible even after the middle of the output is cut.

**Terminal states.**

- `done` — the task completes successfully. If it produced changes, the review gate runs, then the PR opens.
- `blocked` — the agent cannot continue, for example after exhausting its budget or available keys. If there are changes, it opens a draft PR with an explanation.
- Workflow failures before a terminal agent result are reported as failed runs; GitHub cancellation is handled by the workflow runner.

---

## Review gate

Before the patch is pushed, the harness runs an independent review step. The reviewer never sees the agent's reasoning, its history, or its tool calls — only the task, the diff, the file list, and a digest of a fresh test run.

**What it does, in order.**

1. Snapshots `git status --porcelain` in the agent workspace.
2. Picks a test command: the agent's most recent test command, stripped of shell chaining, falling back to `scripts.test` in `package.json`.
3. Runs it as `omah-runner` with a 3-minute cap. Never as the orchestrator user, whose environment holds the App private key and every LLM key.
4. Reverts any paths that appeared during the test run, so coverage folders, snapshots, or lockfile changes cannot leak into the PR.
5. Builds a diff against the start SHA, truncated per file and overall.
6. Runs a deterministic scan (below) for debug code and secrets.
7. Calls a reviewer model, preferring a provider other than the one the writer ended on.
8. Parses a strict JSON verdict. Anything unparseable is logged and the gate is skipped cleanly.

**Severity and action.**

- Low severity — listed in the PR body, no fix round.
- Medium or high severity, with at least 4 minutes of wall clock left — the loop re-enters once with a 4-minute budget and the findings as a follow-up message.
- Regardless of whether the fix round ran, the PR opens as a **draft** with the title prefixed `[Omah] Review concerns:` and the body leading with the findings table. A flagged PR cannot be merged by reflex from a phone.
- If the gate cannot run — no time, no keys, unparseable verdict, empty diff — it logs why and the PR opens as it did before.

**Harness-owned issues.** Two categories are merged with the reviewer's verdict, regardless of what the reviewer said: failing tests after the agent reported done (high), and debug code or secrets from the scan (below).

**The deterministic scan.** `scanDiffForIssues` checks added lines only. Noise paths (markdown, lockfiles, fixtures, snapshots) are skipped. Test files are skipped for debug-code findings but not for secrets. CLI paths (`bin/`) are skipped for `console.log`, because console output is often legitimate there. If the task text names the file, debug-code findings for that file are suppressed.

- Debug findings (`console.log`, `debugger`, `TODO`, `FIXME`, `XXX`) are **low** — listed, no fix round.
- Secret findings (AWS keys, GitHub tokens, `sk-`, private key headers, long literals next to `key`/`token`/`secret`) are **high** — they trigger a fix round.

**Secret handling.** Matched values are passed to `::add-mask::` before anything else touches the log. Notes in the PR body redact the value and show only the variable name. A pre-push check reruns the scan without truncation. If a secret survived the fix round, the push is refused and the run finishes as `blocked` with the file list and no values.

**Why the harness scans.** Two reviewer models, Poolside and Gemini, both returned `verdict=pass` on a diff that contained an explicit `console.log`, with the rubric naming it. Prompt-based rule checks are not reliable across models. The deterministic scan is.

---

## Providers and key rotation

Omah uses free-tier LLM keys from several providers. Each provider has its own rate limits, and every one of them is a constraint. The rotation tries keys in a fixed order and moves to the next when a key hits a limit.

The default order is:

1. **Gemini** — 20 requests/day per key, and 5/minute. Reliable until the cap.
2. **Poolside** — direct API, `poolside/laguna-s-2.1`.
3. **Requesty** — routes to multiple models, 200 requests/day per account.
4. **Groq** — 8,000 tokens/minute. Two or three calls before it cools.
5. **Mistral** — per-account rate limit; all keys share the same bucket.
6. **NVIDIA** — often 503-overloaded. Last resort.

**Key state is persisted.** When a key hits a per-day limit, Omah records it in `keys.json` on an orphan `omah-meta` branch. The next run skips that key until its reset time. This is why the daily limit doesn't have to be rediscovered every time.

**Errors are classified.**

- **Quota (429):** cools the key, or the whole provider bucket if `OMAH_SHARED_QUOTA_PROVIDERS` names it. Per-day exhaustion is persisted to `keys.json`.
- **Retryable (5xx, network):** cools only the key that saw it, for 30 seconds. A transient blip on one key no longer takes the whole provider offline.
- **Rotate (401, 403, 404, 410, JSON-validate 400s):** the whole provider is marked dead for this run.

If all keys are exhausted, the run ends `blocked` with a clear summary.

---

## Writing files (the `request_write` protocol)

The agent calls `request_write` with a path (or uses the canonical JSON fallback envelope if its provider has no function-calling support). The harness then asks for raw contents, and the agent replies with the file bytes ending in `<<<OMAH_END>>>`.

Large files are split across messages with `<<<OMAH_MORE>>>` between chunks. The harness concatenates them. Limits: 200 KB per chunk, 500 KB per file.

---

## Security model

The agent runs untrusted, LLM-generated commands. The design assumes it may eventually do something unexpected.

- **Disposable runner.** GitHub Actions provides an ephemeral VM per run.
- **Unprivileged agent user.** The agent runs as `omah-runner`, not as the workflow user. It cannot read runner files, environment variables, or process state.
- **No authenticated git in the workspace.** The agent commits locally; the orchestrator generates a patch and applies it to a fresh clone it controls. The workspace holds no credentials.
- **Env-var-only auth.** Tokens travel via `GIT_CONFIG_*` environment variables, never argv. `/proc/<pid>/environ` is only readable by the same user.
- **Scoped App token.** Minted per run, scoped to one repo, expires in an hour.
- **Process kill before push.** `pkill -9 -u omah-runner` runs after the loop, so no agent process survives into the push phase.
- **`.omahignore` enforcement.** Files matching the default or repo-provided ignore patterns are deleted from the workspace before the agent starts.
- **Commit-layer path checks.** `.git/`, `.github/`, submodules, and any path matching the ignore patterns are rejected at patch-apply time.
- **Tests run as the unprivileged user.** The review gate runs the target repo's tests as `omah-runner`, never as the orchestrator user. The orchestrator's environment holds the App private key and every LLM key; project code never executes there.
- **Secrets are scanned and can block a push.** A deterministic scan of the diff runs before the reviewer and again before the push. If a secret is present after the fix round, the push is refused and the run finishes `blocked` with the file list and no values. Matched values are masked in the log.

**What this does not protect against:** a repo whose git history contains secrets. Omah cannot un-see what is already committed. Do not point it at repos with secrets in their history.

**Automated tests.** The dedicated test workflow runs `npm test` on pull requests and pushes to `main`. The suite covers tool-call parsing, argument validation, OpenAI-compatible response normalization, loop failure cases, history compression, and the review gate's pure logic. The separately dispatched hostile workflow tests runner isolation and token exfiltration defenses; its latest recorded result is in `HOSTILE-TEST-STATUS.md`. Network egress and kernel-level attacks remain out of scope.

---

## Cleanup

Omah creates two kinds of branches per task:

- `omah/<slug>-<id>` — the PR branch.
- `omah-state/omah-<slug>-<id>` — the conversation state, on the target repo.

These accumulate. A daily cleanup workflow prunes them according to explicit rules:

| Rule | Condition | Deletes |
|---|---|---|
| 1 | PR merged | task branch and state branch |
| 2 | PR closed, not merged | task branch and state branch |
| 3 | No PR, branch older than 2 days | task branch and state branch |
| 4 | Open PR idle more than 2 days | task branch and state branch |
| 5 | Draft PR idle more than 5 days | task branch and state branch |

Open PRs younger than their window are never touched. Cleanup skips a run if `omah.yml` has an in-progress or queued task. `omah-meta` is never deleted.

**Manual cleanup.** The cleanup workflow also accepts a manual dispatch for a full wipe of every Omah branch in a target repo. Requires typing `DELETE` to confirm. This closes every open Omah PR in scope, including drafts awaiting resume.

---

## Repository layout

```
.
├── agent.ts                    # entry point — main, review gate, push phase, GitHub helpers
├── bin/
│   └── omah.js                 # cross-platform CLI
├── cleanup.ts                  # branch cleanup script
├── prompts/
│   ├── system.md               # the agent's system prompt
│   └── review-system.md        # the reviewer's system prompt
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
├── src/
│   ├── config.ts               # constants
│   ├── types.ts                # shared types
│   ├── state.ts                # run-scoped mutable state
│   ├── infra.ts                # process plumbing, workspace, conversation persistence
│   ├── tools.ts                # tool implementations, bash digest, chunk handling
│   ├── loop.ts                 # the agent loop
│   ├── review.ts               # review gate logic and the deterministic diff scan
│   ├── history.ts              # history compression
│   ├── llm.ts                  # provider abstraction and key loading
│   ├── keystate.ts             # keys.json + repositories.json persistence
│   ├── cleanup-rules.ts        # pure decision function for cleanup
│   └── tool-contract.ts        # shared schemas, validation, text fallback parser
└── test/
    ├── agent-loop.test.ts      # loop failure-mode regression tests
    ├── history.test.ts         # compression tests
    ├── review.test.ts          # review gate pure-logic tests
    ├── llm-tools.test.ts       # provider request/response adapter tests
    ├── tool-contract.test.ts   # parser and schema validation tests
    ├── cli.test.js             # CLI parsing and dispatch argument tests
    ├── hostile-task.json       # scripted attack responses
    ├── attack.sh               # pre-run setup for the hostile test
    ├── check.sh                # post-run checker
    ├── plant.sh                # plants git config and hooks
    ├── sniff.sh                # background token sniffer
    └── sink.ts                 # local HTTP sink
```

---

## Limits and known gaps

- **15-minute wall-clock budget.** Long tasks end `blocked`. Break large work into smaller tasks.
- **3 consecutive tool errors.** Three failures in a row stop the loop.
- **Chunk writes are not resumable.** If a run is interrupted mid-write, the partial chunks are lost. The agent has to re-issue `request_write`.
- **Gemini's 5-per-minute limit is the binding constraint.** Every long run spends time on 429s. Not fixable within Omah — it's the free tier.
- **Free-tier keys have hard caps.** Gemini is 20/day per key; Groq is 8k TPM. Plan for the ceiling, not the average.
- **Requesty occasionally truncates JSON envelopes.** The model returns a valid-looking start of a tool call and stops. The harness retries, the model returns the same truncated output, and the run blocks. Falls through to the next provider if one is available.
- **Agents frequently skip tests during the loop.** Many runs reach `finish` without running the test suite. The review gate catches this by running tests itself, but it costs the review budget.
- **No history compression of the model's own reasoning.** Only tool-result bodies are stubbed. Long chains of reasoning still accumulate.
- **One model at a time.** No fast-model / strong-model split. The rotation uses one provider per turn.

---

## Roadmap

- **Observability.** A structured run log on the state branch, and an `omah stats` CLI command that reports completion rate, common failure modes, and tokens per successful task.
- **Checkpointed decomposition.** A planning pass at task start, per-step verification, and revert-on-failure. Unlocks tasks that would take more than one wall-clock budget.
- **Parallelism.** Per-repo concurrency groups and a global key lock, so tasks against different repos can run at the same time.
- **Symbol-level context.** A `get_symbol_context` tool backed by tree-sitter, so the agent reads a function and its call sites rather than whole files.

---

## License

ISC

