# Omah — Improvement Roadmap

Every improvement discussed so far, plus the ones that fall out of the current
design, grouped by what they'd change.

---

## How the agent makes a tool call (current mechanism)

Before discussing improvements, the current shape — because most of the
provider-layer work exists to fix problems in this mechanism.

**The protocol.** The model is asked to emit exactly one JSON object per turn:

```json
{"reasoning": "…", "tool": "run_bash", "args": {"command": "ls -la"}}
```

The harness parses this, dispatches the tool, and replies with a tool result.
The next turn carries the full history including the model's call and the
tool's output.

**The `request_write` exception.** For file writes, the model first calls
`request_write(path)`, the harness asks for raw content, and the model's next
message is the raw bytes of the file with a sentinel terminator
(`<<<OMAH_END>>>`). This was added because large files broke JSON: raw newlines
inside strings aren't valid JSON, and the model kept emitting them.

**The parser.** `parseModelOutput` in `agent.ts` tries, in order:

1. Strip code fences, parse the whole string as JSON.
2. If that fails, find the last balanced `{…}` span and parse it.
3. If that fails, try the "flat" form: `{"tool": "...", "<param>": value}`
   where params sit at the top level instead of under `args`.

The flat-form fallback was added for Poolside / Laguna S. The balanced-brace
scan was added because reasoning text often contains a draft object before the
real call.

**The quarantine guard.** Before the raw-write path writes a file, it calls
`looksLikeToolCall(raw)`. If the raw reply parses as a tool-call envelope, the
write is rejected with a `TOOL_CALL_GUARD` error. This catches the case where
the model forgets the write protocol and emits JSON instead of raw content. The
harness pushes a placeholder into history (`[attempted JSON tool call instead
of raw content]`) so the model doesn't reinforce its own mistake by seeing it
repeated back.

**Provider quirks absorbed so far.**

| Provider | Quirk | Where handled |
|---|---|---|
| Gemini | None significant | — |
| Groq (gpt-oss) | Emits reasoning text in `message.reasoning` and leaves `content` empty | `OpenAICompatibleProvider.complete` reads `reasoning` when `content` is blank |
| Poolside (Laguna S) | Emits XML tool calls (`<tool_call>…</tool_call>`) on first attempt, then flat JSON | Parser tries JSON, falls back to flat form |
| Mistral (Leanstral via Requesty) | Refuses the raw-write handshake; sends JSON tool calls instead of raw content | `TOOL_CALL_GUARD` + placeholder in history |

**What this costs.**

- Every quirk is a code path in `agent.ts` that exists for one provider.
- Every retry is a wasted LLM call and duplicated history.
- The wall-clock budget absorbs the retries.

This is the case for native tool calls (item 1, below). Providers have
structured tool-calling APIs. Using them would replace the whole mechanism
above with a schema and a structured response.

---

## Category 1 — Provider layer

**1. Native tool calls.** Each provider has a structured function-calling API:
Gemini's `tools: [{functionDeclarations: [...]}]`, OpenAI's `tools` parameter,
Mistral's function-calling support. Passing the tools as a schema means the
model emits a structured call, and the SDK handles the wire format. This would
eliminate the class of problems described above.

- **Cost:** rewrite `llm.ts` and the request shape in `callModel`. The tool
  definitions move from `system.md` prose into a TypeScript schema.
- **Benefit:** fewer parse failures, fewer retries, cleaner code, one less
  provider quirk to absorb per new provider.
- **Risk:** some free-tier endpoints don't support structured tool calls at all,
  or support them inconsistently. Requires per-provider testing.

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
- **Prerequisite:** item 1. Structured tool calls make this easy; the
  JSON-in-text protocol makes it hard.

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

**20. Failure-mode tests.** The hostile test verifies the security model. A
parallel set of tests for the agent loop: what happens when a provider hangs,
when the model emits malformed JSON three times in a row, when the wall-clock
budget expires.

- **Cost:** cheap. The `OMAH_SCRIPT` mechanism already exists for simulating
  specific model responses.
- **Benefit:** confidence that the loop's error handling works, without waiting
  for a real provider outage.

---

## Category 6 — Documentation

**21. README.** Describes what Omah is, how to set it up, how to use it.

- Draft written, ready to commit.

**22. ARCHITECTURE.md.** The design decisions and why.

- The master doc you wrote describes a different system. This file would
  describe the current one.

**23. CHANGELOG.md.** One line per behavior-changing commit.

- Reconstructing the last twenty commits would be tedious. Adding future
  entries is trivial. Start fresh.

**24. Troubleshooting.md.** For when a run fails: what to check, common errors,
where the logs are.

- You've accumulated enough failure modes to write this. Worth doing before
  you forget them.

---

## What I would rank as the top three

1. **Self-review pass (5).** Small, high value, addresses the "agent believes
   it's done when it isn't" failure mode. Path B, as decided.
2. **History compression (6).** Directly reduces token burn. The free tiers are
   the binding constraint, and this is the single lever that moves it.
3. **Native tool calls (1).** Eliminates the class of parser failures we've
   been absorbing provider by provider. Biggest single-codebase change, and it
   simplifies or unblocks several other items (7 in particular).

Everything else is either polish, or an addition you don't have evidence for
yet.
