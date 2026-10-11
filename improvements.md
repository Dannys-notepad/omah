# Omah — Improvement Roadmap

Every improvement discussed so far, plus the ones that fall out of the current
design, grouped by what they'd change. Numbering may have gaps where completed
items have been removed.

---

## How the agent makes a tool call (current mechanism)

**Structured calls.** Normal turns send the same five tool declarations to
each provider. Gemini function calls and OpenAI-compatible `tool_calls` are
normalized to `{name, arguments}` and validated against the shared schemas in
`src/tool-contract.ts`. Only one call is accepted per turn.

**Compatibility fallback.** If a provider explicitly rejects function-calling
fields, its adapter retries once without tools. The model is instructed to
return one canonical JSON envelope in that mode. Other HTTP or provider errors
continue through normal provider rotation; they are not mistaken for tool
support failures.

**Text parsing.** Canonical JSON (optionally in a whole-response code fence) is
accepted from any provider. Poolside alone also gets compatibility handling
for a flat envelope, one JSON envelope inside `<tool_call>…</tool_call>`, or a
single unambiguous envelope embedded in prose. Multiple candidates are
rejected rather than selecting whichever appeared last. Each tool's required,
typed arguments and allowed fields are checked before dispatch.

**The `request_write` exception.** File contents remain a separate raw-text
turn. No function declarations are sent for that turn; its bytes go directly
through the sentinel/chunk checks, and a recognizable tool envelope is
rejected by the write guard.

**Provider quirks handled.**

| Provider | Quirk | Where handled |
|---|---|---|
| Gemini | Native function-call parts need a provider-specific schema and response adapter | `GeminiProvider` |
| OpenAI-compatible providers | Native `tool_calls`; endpoints that explicitly reject tools get one text-mode retry | `OpenAICompatibleProvider` |
| Groq (gpt-oss) | May return useful JSON-mode text in `message.reasoning` with empty `content` | `OpenAICompatibleProvider.complete` |
| Poolside (Laguna S) | May wrap a JSON call in `<tool_call>` or emit a flat envelope | Poolside-only fallback in `src/tool-contract.ts` |

**Tradeoff.** Native calls avoid most text parsing, but custom endpoints may
need one fallback request. The fallback is intentionally narrow: provider
quirks do not become global parser rules, and ambiguous output is retried rather
than guessed.

---

## Category 1 — Provider layer

**2. Streaming responses.** Every call waits for the full reply before
proceeding. Streaming would let the harness start reading as tokens arrive.

- Not a correctness win, a latency one.
- For Omah's scale — small tasks, short responses — probably not worth the
  complexity. Defer.

**3. Provider failover mode.** Right now rotation moves to the next key on
error. A stronger policy: if a provider fails twice in a row on any error, skip
it for the rest of the run. You've seen the Groq case: its keys cool and come
back in a loop, keeping the picker pinned to Groq even though Requesty and
Poolside are ready.

- **Cost:** a run-level provider ban map. Small change to `runLoop`.
- **Benefit:** fewer wasted turns when a provider is having a bad day.

**4. Model tiers.** A "fast" model for exploration, a "strong" model for
planning and writing. Requires two models per provider, plus a routing policy.

- Right now you have one model per provider, and no evidence the split would
  help. Defer.

---

## Category 2 — Agent loop

**5. Self-review pass (Path B).** Before `finish`, the agent re-reads the diff,
runs the tests again, and looks for edge cases it missed. No infrastructure
change, just a prompt addition and a slightly bigger wall-clock budget.

- This is the highest-value item on the list. It directly addresses the
  "agent believes it's done when it isn't" failure mode, which is the one
  failure mode the PR review exists to catch.
- **Cost:** prompt work. The budget bump is minor.

**6. History compression.** Long tasks send the entire history on every call.
Input tokens grow linearly with step count: you saw a run go from 2,500 to
9,900 input tokens across 15 steps. Compressing old tool results (replace the
full output with a summary) would reduce tokens per call and reduce free-tier
burn.

- **Cost:** a compression pass that rewrites older history entries. It runs
  periodically — after N steps, or when history exceeds a token threshold — and
  leaves the recent 5 steps verbatim.
- **Benefit:** fewer tokens per call, more tasks per day, less quota pressure.

**7. Parallel tool calls.** Some tasks need reads from three files. Right now
that's three turns. If the model could emit multiple tool calls in one
response, the harness could execute them together and reply once.

- **Cost:** a change to the tool contract and the loop.
- **Benefit:** fewer turns, faster runs, fewer tokens on redundant history.
- **Prerequisite:** native calls are implemented. This item still needs a
  batch-dispatch contract and result handling before the loop can run calls in
  parallel.

**8. Resumable runs across process death.** If the runner dies mid-task, the
conversation state is saved but the loop restarts from scratch on resume. A
true checkpoint-resume would replay the conversation and continue from the last
step.

- **Cost:** mostly in the resume path. The conversation is already on the state
  branch.
- **Benefit:** long tasks don't lose progress when the runner goes down. This is
  rare on GitHub Actions, so lower priority.

**9. Token budget display.** The diagnostics block shows input/output tokens
per step. It doesn't show a running total against the free-tier ceiling. A line
that says "this run used 45,000 of your 100,000 daily Gemini tokens" would tell
you when you're close to the wall.

- **Cost:** trivial. The diagnostics block already has the numbers.
- **Benefit:** you know whether you can run another task today, without
  checking every provider dashboard.

---

## Category 3 — Task submission

**10. CLI wrapper.** `omah run "..."`, `omah status <id>`, `omah watch`. A
small Node binary inside the repo, installed with `npm link`.

- **Cost:** ~100 lines and a `bin` field in `package.json`.
- **Benefit:** shorter than typing the full `gh workflow run` invocation.
  Defaults the repo. Prints the PR URL when the run finishes.

**11. Task templates.** Named, reusable prompts: "add test," "fix bug,"
"refactor module." Pick a template, fill one or two slots, submit.

- **Cost:** one JSON file of templates, one dropdown in the workflow.
- Defer until you've run enough tasks to know which ones you repeat.

**12. Web form for task submission.** An HTML form hosted somewhere that
triggers the workflow via the GitHub API.

- Not worth it. The GitHub dispatch UI already works from a phone, and the CLI
  covers the terminal.

**13. Scheduled tasks.** A `schedule` trigger with a fixed task. "Every Monday,
upgrade dependencies on Zorx."

- **Cost:** one schedule entry per task. Everything else is reused.
- Cheap once you have a task worth scheduling.

**14. Multi-repo tasks.** A task that spans two repos. Requires a different
workspace model (two clones, two branches, two PRs).

- Significant change. Defer until you need it.

---

## Category 4 — Review and merge

**15. Auto-review of the PR.** After Omah opens a PR, a second workflow reads
the diff, runs the tests, and posts a comment summarizing what it found. This
is different from the self-review pass: it's an outside check, after the PR
exists.

- **Cost:** a new workflow, a new prompt.
- **Benefit:** a second opinion before you read the diff. Most useful when the
  reviewing model is different from the writing model — the same model
  reviewing its own work catches fewer mistakes.

**16. Auto-merge on green.** If the tests pass and the auto-review approves,
merge automatically.

- Contradicts the core principle of no auto-merge. Would remove the one safety
  boundary the design depends on.
- **Do not add.**

**17. Comment-resume flow.** Reply to a blocked PR with a follow-up. The
`issue_comment` trigger fires. The workflow resumes the task.

- Half-built: `runLoop` supports resume. The workflow doesn't wire the trigger.
- **Cost:** one workflow trigger block.
- **Benefit:** you don't have to re-submit a task to correct a blocked one.

---

## Category 5 — Observability

**18. Per-run cost dashboard.** Every run logs tokens, keys used, wall time. A
small script that reads the last N runs and prints a table: "this week, 12
tasks, 340k tokens, 4 keys exhausted."

- Aggregates data you already write. Not required, nice to have.

**19. Structured error log.** Right now errors are strings in a log line. A
small enum — `PARSE_FAILURE`, `PROVIDER_DOWN`, `KEY_EXHAUSTED`,
`BUDGET_EXCEEDED` — attached to each failed run would let you query "how often
do tasks fail because of parse errors vs. provider outages?"

- **Cost:** small. Every error path gets a code.
- **Benefit:** data for deciding what to fix next.

---

## Category 6 — Documentation

**20. README.** Describes what Omah is, how to set it up, how to use it.

- Draft written, ready to commit.

**21. ARCHITECTURE.md.** The design decisions and why.

- The master doc you wrote describes a different system. This file would
  describe the current one.

**22. CHANGELOG.md.** One line per behavior-changing commit.

- Reconstructing the last twenty commits would be tedious. Adding future
  entries is trivial. Start fresh.

**23. Troubleshooting.md.** For when a run fails: what to check, common errors,
where the logs are.

- You've accumulated enough failure modes to write this. Worth doing before
  you forget them.

---

## What I would rank as the top three

1. **Self-review pass (5).** Small, high value, addresses the "agent believes
   it's done when it isn't" failure mode. Path B, as decided.
2. **History compression (6).** Directly reduces token burn. The free tiers are
   the binding constraint, and this is the single lever that moves it.
3. **Provider failover mode (3).** Avoids repeatedly returning to an unhealthy
  provider while other providers remain available.

Native tool calls are implemented; the remaining ideas are deferred pending
need or evidence.
