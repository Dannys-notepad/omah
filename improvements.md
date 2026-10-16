# Omah — Improvement Roadmap

Status of every improvement discussed, grouped by what they change.
Updated 2026-10-16.

Legend:
- **done** — shipped and verified in a live run.
- **next** — the active queue.
- **queued** — planned, not started.
- **deferred** — considered, postponed with a reason.
- **rejected** — considered, will not do.

---

## Completed

### History compression (Phase 1) — done

**Problem.** Tool results accumulate in `history` and are resent on every
model call, so input tokens grow linearly with step count. One observed
run grew from 2,500 to 9,900 input tokens across 15 steps, burning
free-tier quota on information the model no longer needed.

**What shipped.** A new module, `src/history.ts`. Once history passes
either a step threshold (6 steps since the last pass) or a size
threshold (4,000 estimated tokens), it walks the oldest tool-result
messages and replaces their bodies with short stubs.

Four stub rules:

1. **Old `read_file` results** become `[compressed] read path: N lines,
   M bytes. Re-read with read_file if needed.` The model can always
   re-read the file if it needs the contents again.
2. **Pre-edit reads** are kept verbatim while the edit is fresh (within
   3 steps) and small (under 8 KB), then stubbed with a
   `git show <startSha>:<path>` hint so the model can recover the
   original.
3. **Long `run_bash` results** are cut to head 10 lines and tail 20
   lines. The digest (below) is what survives.
4. **A progress ledger** is appended to the task message: files read,
   files written, commits made, last test summary. Built from
   `conversation.steps`, no model involved.

**The `run_bash` digest.** At capture time, before the output is
truncated, `buildBashDigest` extracts:

- The exit code.
- Up to 15 lines matching `fail|error|✗|✕|FAIL|Cannot find|TypeError|`
  `ReferenceError|SyntaxError|AssertionError`, excluding "zero" lines
  like `0 failed` and `no errors found`.
- The total match count, so a stub can print `(+N more matching lines)`
  when the cap cut results.
- The final test summary line, matched by `\d+ (passed|failed|...)`.

The digest is stored on the step and survives truncation and resume, so
failing test names stay visible after compression even when the middle
of the output was cut.

**Trigger.** Fire when either gate is met, not both. An earlier version
required both, and on a realistic 14-step run the size gate never
opened because history peaked at 4,500 tokens.

**Verified.** Fires in production. On the Zorx run of 2026-10-14, pass 1
landed at step 6 and cut input tokens by ~1,100 on the next call.

---

### Retryable cooldown scoped per key — done

**Problem.** A 5xx from any key of a provider cooled every key of that
provider for 300 seconds. With 5 Gemini keys, a transient 503 on one
key took the whole provider offline, forcing a switch to a slower
provider even when other Gemini keys were healthy.

**What shipped.** A retryable error cools only the key that saw it, for
30 seconds, not 300. If a key is persistently bad it re-cools itself,
which quarantines it without harming its siblings. If every key of a
provider starts failing in sequence, the rotation exhausts them and
falls through to the next provider anyway.

**Verified.** In the Zorx run, all five Gemini keys cooled independently
at 30s each rather than all five cooling at 300s.

---

### CLI symlink fix — done

**Problem.** `omah --help` produced no output. The main-module guard
compared `path.resolve(process.argv[1])` against
`fileURLToPath(import.meta.url)`. When the CLI ran through the npm link
symlink, `argv[1]` was the symlink path and `import.meta.url` was the
real file path. `path.resolve` does not dereference symlinks, so the
two never matched, the guard was false, and `main()` was never called.

**What shipped.** `fs.realpathSync` on both sides so symlinked
invocation is detected. Imported invocation from tests is unaffected.

**Verified.** `omah --help`, `omah config get control-repo`, and
`omah status` all work.

---

### Review gate (Phase 2) — done

**Problem.** The harness opened a PR as soon as the agent called
`finish`. There was no check between "the model believes it is done"
and "the PR exists". A run that passed its own tests could still ship a
wrong or incomplete change, and nothing caught it until the diff was
reviewed by hand.

**What shipped.** An independent review step between the loop and the
push. After `runLoop` returns with `status=done`, and before the patch
is pushed, the harness:

1. Snapshots `git status --porcelain` in the agent workspace.
2. Picks a test command: the most recent test command the agent ran,
   stripped of shell chaining, falling back to `scripts.test` in
   `package.json`.
3. Runs it as `omah-runner` with a 3-minute cap. **Never as the
   orchestrator user**, whose environment holds the App private key and
   every LLM key.
4. Reverts any paths that appeared during the test run, so coverage
   folders, snapshots, or lockfile changes cannot leak into the PR.
5. Builds a diff against `startSha`, truncated per file and overall,
   with `.git` paths removed.
6. Runs a harness scan (below) for debug code and secrets.
7. Calls a reviewer model with the task, the diff, the file list, and a
   digest of the fresh test run. The reviewer gets no history, no
   reasoning, and no tools.
8. Parses a strict JSON verdict. Anything unparseable is logged and the
   gate is skipped cleanly.

**Severity and action.**

- Low severity — listed in the PR body, no fix round.
- Medium or high severity, with at least 4 minutes of wall clock left —
  the loop re-enters once with a 4-minute budget and the findings as a
  follow-up message.
- Regardless of whether the fix round ran, the PR opens as a **draft**
  with the title prefixed `[Omah] Review concerns:` and the body leading
  with the findings table. A flagged PR cannot be merged by reflex from
  a phone.
- If the gate cannot run — no time, no keys, unparseable verdict, empty
  diff — it logs why and the PR opens as it did before.

**Harness-owned issues.** Two categories are merged with the reviewer's
verdict, regardless of what the reviewer said:

- Failing tests after the agent reported done, or a test run that timed
  out. Both are high severity.
- Debug code and secrets, from the harness scan (below).

**Design.** The reviewer sees the diff as untrusted input. Repo content
can carry injected instructions; the reviewer's output is data only. It
goes into a PR body or a fix-round message and is never executed, and
never selects a tool.

**Verified.** Fires in production. Detected a real scope-creep finding
on the Zorx run of 2026-10-16 (package-lock.json changed by an
unrelated `npm install`).

---

### Reviewer system prompt in its own file — done

**Problem.** The reviewer's rubric lived in a template string inside
`buildReviewPrompt`. Editing it meant editing code. Every other
behavioral rule in Omah lives in a Markdown file that can be tuned
without recompiling.

**What shipped.** `prompts/review-system.md` holds the reviewer's role,
rubric, severity definitions, uncertainty policy, and response format.
`buildReviewPrompt` is now data-only: task, files, test digest, diff.
`runReviewGate` loads the system prompt from disk and passes it to the
reviewer.

**Lesson.** Two reviewer models, Poolside and Gemini, both returned
`verdict=pass` on a diff that contained `console.log('loaded')`, with
the rubric naming `console.log` explicitly. Prompt-based rule checks
are not reliable across models. This is why the harness scan exists.

---

### Harness scan for debug code and secrets — done

**Problem.** The reviewer kept missing obvious debug code. Two models
had to be tested to be sure, and both missed. The fix was to move rule
checks out of the model and into the harness, where they are
deterministic.

**What shipped.** `scanDiffForIssues` in `src/review.ts`.

Scans added lines only (`^+`, not `^+++`). Skips noise paths (markdown,
lockfiles, fixtures, snapshots). Test files are skipped for debug-code
findings but not for secrets. CLI paths (`bin/`) are skipped for
`console.log`, because console output is often legitimate there. If the
task text names the file, debug-code findings for that file are
suppressed.

**Debug findings** — severity low, do not trigger a fix round:

- `console.log`, `console.debug`, `console.trace`, `console.dir`
- `debugger`
- `TODO`, `FIXME`, `XXX`

**Secret findings** — severity high, trigger a fix round:

- Known formats: `AKIA...`, `ghp_`, `ghs_`, `gho_`, `sk-`, `sk_live_`,
  `xox[bpoas]-`, `-----BEGIN ... PRIVATE KEY-----`.
- Long literals (`20+` chars) next to names matching
  `key|token|secret|password|passwd|credential`, excluding hex-only
  strings and placeholder prefixes (`your`, `example`, `dummy`, ...).

**Secret handling.**

- Matched values are passed to `console.log ::add-mask::` before
  anything else touches the log.
- Notes in the PR body redact the value and show only the variable name.
- A **pre-push check** reruns the scan without truncation. If a secret
  is still in the diff after the fix round, the push is refused and the
  run finishes as `blocked` with the file list and no values.

**Verified.** Caught `console.log('loaded')` in the Zorx run of
2026-10-16 after two reviewer models missed it.

---

### Fix-round summary instruction — done

**Problem.** When a fix round ran, the PR body's summary described only
the fix, not the whole task. The user saw "Installed dependencies and
verified tests pass" instead of "Added the reviewed comment and
removed the lockfile."

**What shipped.** `buildFixRoundMessage` now tells the agent to
summarize the complete task, not just the fix.

**Verified.** PR #17 body describes the whole task including the fix
round.

---

### `agent.ts` split (#11) — done

**Problem.** `agent.ts` had grown to 3,051 lines with twenty concerns in
one file: the loop, tools, workspace setup, review gate, push logic,
GitHub helpers, conversation persistence, usage tracking, process
plumbing. Every change to any of them meant editing the same file. #7
(checkpointing) cannot land cleanly in a file that size.

**What shipped.**

- `src/config.ts` — constants. No logic, no imports from other Omah
  modules.
- `src/types.ts` — shared types. No runtime code.
- `src/state.ts` — run-scoped mutable state (usage log, key stats,
  persisted state, meta token, flags). Reassignable values are exposed
  through setters, because ES module bindings cannot be reassigned from
  outside their declaring module.
- `src/infra.ts` — process spawning, workspace preparation, conversation
  persistence, key picking, ignore list handling, small utilities.
- `src/tools.ts` — tool implementations, raw-write chunk handling, bash
  digest, bash execution.
- `src/loop.ts` — `runLoop` and everything it directly uses: `callModel`,
  `recordStep`, `withTimeout`, scripted responses.
- `agent.ts` — entry point. `main`, the review gate, the push phase,
  GitHub helpers, usage summary, entry guard.

**Verified.** A live run after the split produced identical behavior to
before, with all modules loading correctly from a fresh GitHub checkout.

---

## Next

### #6 — Observability

**Problem.** Every run writes a diagnostics block to the GitHub Actions
summary. That block is transient — it goes away when the Actions log
expires. There is no persistent record of what ran, what failed, and
why. Without that record, every future improvement is guesswork.

**What to build.**

**A structured run log.** Every run appends a JSON entry to the state
branch (`omah-meta`), under a new file `runs.json`. One entry per run,
with:

- Task ID, target repo, task text.
- Terminal status (`done` / `blocked`) and, if blocked, the reason.
- Steps taken, LLM calls made, tokens consumed per step.
- Compression passes applied.
- Review gate outcome: skipped / pass / concerns, and the issue list.
- Fix-round outcome, if it ran.
- Wall time, split into setup / loop / review / push.
- Per-key call counts and error counts.

**An `omah stats` CLI command.** Reads the last N entries and prints:

- Completion rate over the last week / month.
- Most common terminal reason for blocked runs.
- Average tokens per successful task.
- Which providers are contributing the most calls and errors.
- Which steps in a typical run are the slowest.

**An "accepted without edit" tracker.** After each PR, the user marks
whether it was merged as-is, edited, or closed. This is the only metric
that matters for real use — how often does the agent produce something
you accept? Stored in `runs.json` as an optional `outcome` field on each
entry.

**Cost.** Low. One new file in `src/`, one new CLI subcommand, one new
state-branch file. The data is already computed for the diagnostics
block; it just isn't saved.

**Why first.** Checkpointing (#7) depends on knowing which tasks fail
and why. Without logs, #7's design decisions are guesses. With logs,
they're grounded in what actually happens.

---

## Queued

### #7 — Checkpointed decomposition

**Problem.** Omah runs a task as a single sequence of tool calls until
the model calls `finish` or a budget runs out. If the model loses the
thread partway through a multi-step task, the whole run is wasted. The
15-minute wall clock caps how ambitious a task can be, and there is no
way to make progress on something that would take 30 minutes.

**What to build.**

**A planning pass.** Before the loop starts, one model call produces a
plan as a JSON array of 3–7 steps. Each step has an ID, a description,
the files it touches, and a verification command.

**Per-step verification.** After each step's tool calls complete, run
the step's verification command. If it passes, mark the step done and
move on. If it fails, revert to the last checkpoint and retry that step
with the error appended to the prompt. Cap retries at 2 per step. If a
step fails twice, mark the task `blocked` with the failing step
identified.

**Checkpoint commits.** After each successful step, create a local
checkpoint commit (not pushed). This is the revert target and also
means a mid-task failure leaves a resumable state.

**Interaction with the review gate.** The gate runs once, after the
whole plan is done. Not per step.

**Cost.** High. This is the biggest single change we've discussed. It
touches the loop deeply and changes the shape of `conversation.json`
(a plan is a new field).

**Why now.** This is the feature that turns Omah from "small fixes" into
"real work." Everything before it makes small tasks reliable. This
makes larger tasks possible.

---

### #8 — Parallelism

**Problem.** The workflow uses a single concurrency group, so only one
run happens at a time. A queue of 10 tasks takes 10 × the wall time of
one task. With 22 keys across six providers, most of the rate-limit
capacity sits idle.

**What to build.**

**Per-repo concurrency groups.** Change `concurrency: omah` to
`concurrency: omah-${{ inputs.target_repo }}` so tasks against
different repos run in parallel. Same-repo tasks still serialize,
because they share state branches.

**A global key lock.** The current `keys.json` on the state branch
records per-day exhaustion, but two parallel runs can race on writes.
Add a short-lived lock file (`keys.lock` with a timestamp) or accept
occasional double-use, since free tiers are forgiving.

**Fix the cooldown propagation.** The cooldown map is now shared between
the loop and the review gate within one run. For parallelism, it must
also propagate across runs — otherwise two runs will both think a
cooled key is fresh. Options: persist cooldowns to `keys.json` on
every cool, or accept a small window of duplicate failure.

**Cost.** Moderate, once #7 lands. The hard part is the shared state,
not the concurrency.

---

### #9 — Symbol-level context

**Problem.** The agent reads whole files when it only needs one
function. A 2,000-line file costs about 8,000 tokens to read, most of
which the model doesn't need. Reading a symbol's definition, its direct
dependencies, and its call sites costs a fraction of that.

**What to build.**

- A `get_symbol_context(symbol, file?)` tool. Given a symbol name, find
  its definition, return the body, its direct imports, and its call
  sites (file + line + 3 lines of context). Cap output at ~600 tokens.
- A repo map generated at clone time. A tree-sitter pass produces a
  lightweight symbol index. A summarized version (top-level exports
  only) goes into the system prompt on step 1, so the agent has
  orientation before reading anything.
- A rule in `system.md`: "Call `get_symbol_context` before editing.
  Only call `read_file` if the symbol context is insufficient."

**Cost.** Moderate. A new dependency (tree-sitter plus language
bindings), a new tool, a repo-map generator.

**Why queued, not next.** Phase 1 (compression) already flattens the
history growth curve. Symbol-context reduces the cost of individual
reads, which matters less once old reads stop accumulating. Worth
doing, but not before checkpointing.

---

## Deferred

### Poolside's tool-call reliability

**Problem.** Poolside's `laguna-s-2.1` produces three shapes of tool
call: a flat JSON envelope (handled), a garbled XML/JSON hybrid
(rejected and retried), and multiple native tool calls in one turn
(rejected and retried). As a reviewer it also ignores rule-based
rubrics even when the rubric names the pattern explicitly.

**Why deferred.** Two reviewer models (Poolside and Gemini) both passed
on a diff with explicit `console.log`, which suggests the problem isn't
specific to Poolside. The harness scan now covers rule checks
deterministically. Poolside is currently disabled via
`OMAH_DISABLED_PROVIDERS=poolside`, which removes the tool-call
problems from the loop for now.

**If revisited.** Options: (a) keep disabled permanently, (b) allow
multi-call turns for Poolside specifically, (c) strengthen the retry
prompt with the specific parse error, (d) drop the provider from the
rotation.

### Streaming responses

Every call waits for the full reply before proceeding. Streaming would
let the harness start reading as tokens arrive. Not a correctness win,
a latency one. For small tasks, not worth the complexity.

### Model tiers

A "fast" model for exploration, a "strong" model for planning and
writing. Requires two models per provider plus a routing policy. No
evidence yet that the split would help.

### Task templates

Named, reusable prompts. Defer until there's a pattern of repeated
tasks worth templating.

### Web form for task submission

GitHub's workflow dispatch UI already works from a phone. The CLI
covers the terminal. A form adds surface with no benefit.

### Scheduled tasks

A `schedule` trigger with a fixed task. Cheap once there's a task worth
scheduling. No such task yet.

### Multi-repo tasks

A task that spans two repos. Requires a different workspace model.
Significant change. Defer until there's a real need.

### Comment-resume flow

Reply to a blocked PR and the agent continues. The loop already
supports resume; the workflow trigger is missing. Nice, but `omah
resume` from the CLI covers the case.

### Self-review pass inside the loop

The original Phase 2 plan had a prompt-level self-review before
`finish`. Superseded by the harness-level gate, which has independent
context. The prompt-level version would have the same blind spots as
the writer.

---

## Rejected

### Auto-merge on green

Contradicts the core principle of no auto-merge. The PR is the review
boundary. Will not add.

---

## Known issues, not yet addressed

- **`package-lock.json` pollution.** When the repo uses pnpm, the
  agent's `npm install` calls create `package-lock.json`, which appears
  in the diff as scope creep. The reviewer catches it (J3) and the fix
  round removes it, but it costs a round. Fix would be a system-prompt
  rule: "Match the project's package manager; do not run npm install in
  a pnpm project."
- **Agents frequently skip tests during the loop.** Many runs reach
  `finish` without running the test suite. The review gate catches this
  by running tests itself, but it costs the review budget. A
  system-prompt rule requiring a test run before `finish` would help.
- **Gemini's 5-requests-per-minute per-project limit is the binding
  constraint.** Every long run spends time on 429s. There is no fix
  within Omah — it's the free tier. Worth tracking in the run log so
  the cost is visible.
- **Requesty occasionally truncates JSON envelopes.** The model returns
  a valid-looking start of a tool call and stops. The harness retries,
  the model returns the same truncated output, and the run blocks. Not
  fixable by prompt. Falls through to the next provider if one is
  available; blocks otherwise.
- **`readStub`'s pre-edit anchor is conservative.** It keeps a pre-edit
  read verbatim while the edit is fresh (3 steps) and small (8 KB), and
  stubs it after. This is the right default for safety, but it means a
  rapid sequence of small edits can keep more pre-edit bodies than
  necessary. Watch it in the run log once observability lands.
- **The review gate does not re-run after a fix round.** A `concerns`
  PR opens as a draft even if the fix round resolved every finding.
  This is by design (conservative), but the PR body could note "fix
  round ran; re-review not performed" so the user knows the state
  without reading logs.
- **`refreshLedger`'s marker is a plain string.** It searches for
  `"\n\nProgress so far:"` in the task message. A task text containing
  that string would cause the ledger replacement to truncate the task.
  Low risk, worth changing to a distinctive marker
  (`"\n\n[omah] Progress:"`).