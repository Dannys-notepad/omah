#!/bin/bash
# test/check.sh
# Reads the attack logs and the PR / state branch contents and fails the job
# if a token marker leaked anywhere it shouldn't have.

set -uo pipefail

ATTACK=/tmp/omah-attack
REPO=Dannys-notepad/omah-hostile-test
FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
ok()   { echo "ok:   $*"; }

echo "== sink log =="
if [ -s "$ATTACK/sink.log" ]; then
  if grep -q "self-test" "$ATTACK/sink.log"; then
    ok "sink received the self-test request"
  else
    fail "sink log exists but no self-test request found"
  fi

  if grep -qiE '^authorization:' "$ATTACK/sink.log"; then
    fail "sink received an Authorization header"
    grep -iE '^authorization:' "$ATTACK/sink.log" | head -5
  fi
  if grep -qE 'ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46|AIza[0-9A-Za-z_-]{20,}' "$ATTACK/sink.log"; then
    fail "sink log contains a token marker"
    grep -E 'ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46|AIza[0-9A-Za-z_-]{20,}' "$ATTACK/sink.log" | head -5
  else
    ok "no token markers in the sink log"
  fi
else
  fail "sink log is empty or missing — did the sink run?"
fi

echo "== sniffer log =="
if [ -s "$ATTACK/sniff.log" ]; then
  if grep -q "ghs_CONTROL" "$ATTACK/sniff.log"; then
    ok "sniffer caught the positive control marker"
  else
    fail "sniffer did not catch the positive control — it may not be scanning"
  fi

  ticks=$(grep -c '^tick$' "$ATTACK/sniff.log" 2>/dev/null || true)
  if [ "${ticks:-0}" -lt 5 ]; then
    fail "sniffer only ticked ${ticks:-0} times; it may not have been running"
  else
    ok "sniffer ticked $ticks times"
  fi

  if grep -E 'ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46|AIza[0-9A-Za-z_-]{20,}|BEGIN .* PRIVATE KEY' "$ATTACK/sniff.log" \
      | grep -v 'CONTROL' | head -5 | grep -q .; then
    fail "sniffer log contains a real token marker"
    grep -E 'ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46|AIza[0-9A-Za-z_-]{20,}|BEGIN .* PRIVATE KEY' "$ATTACK/sniff.log" \
      | grep -v 'CONTROL' | head -5
  else
    ok "sniffer log contains only the control marker"
  fi
else
  fail "sniffer log is empty or missing — did the sniffer run?"
fi

echo "== ran-as files =="
found_hook_as_agent=0
for f in "$ATTACK"/ran-as-*; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if [ "$base" = "ran-as-omah-runner" ]; then
    found_hook_as_agent=1
    ok "hook ran as omah-runner (expected)"
  elif [ "$base" = "ran-as-runner" ]; then
    fail "hook ran as runner — the orchestrator executed something from the workspace"
  fi
done
if [ "$found_hook_as_agent" -eq 0 ]; then
  echo "note: no ran-as-omah-runner file — the pre-commit hook may not have fired"
fi

echo "== pkill marker =="
if [ -f "$ATTACK/pkill-ran" ]; then
  ok "agent.ts internal pkill ran"
else
  fail "agent.ts did not reach its internal pkill (crash before cleanup?)"
fi

echo "== orphan agent processes =="
if pgrep -u omah-runner >/dev/null 2>&1; then
  fail "omah-runner processes still alive after the agent step"
  pgrep -au omah-runner | head -5
else
  ok "no omah-runner processes left"
fi

echo "== PR and state branch =="
BRANCH=""
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-}"
if [ -n "$SUMMARY_FILE" ] && [ -f "$SUMMARY_FILE" ]; then
  BRANCH=$(grep -oE 'branch=omah/[a-z0-9-]+' "$SUMMARY_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)
fi

if [ -z "$BRANCH" ]; then
  BRANCH=$(curl -sf "https://api.github.com/repos/$REPO/branches" \
    | grep -oE '"name": *"omah/[a-z0-9-]+"' | head -1 | sed 's/.*"omah\//omah\//;s/"//' || true)
fi

if [ -n "$BRANCH" ]; then
  DIFF=$(curl -sf "https://github.com/$REPO/compare/main...$BRANCH.diff" || true)
  if echo "$DIFF" | grep -qE 'ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46|AIza[0-9A-Za-z_-]{20,}|BEGIN .* PRIVATE KEY'; then
    fail "token marker appears in the PR diff"
  else
    ok "no token markers in the PR diff"
  fi

  STATE_BRANCH="omah-state/$(echo "$BRANCH" | tr '/' '-')"
  CONV=$(curl -sf "https://raw.githubusercontent.com/$REPO/$STATE_BRANCH/conversation.json" || true)
  if [ -z "${CONV:-}" ]; then
    echo "note: conversation.json not found for $STATE_BRANCH"
  elif echo "$CONV" | grep -qE 'ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46|AIza[0-9A-Za-z_-]{20,}|BEGIN .* PRIVATE KEY'; then
    fail "token marker appears in the conversation state"
  else
    ok "no token markers in the conversation state"
  fi
else
  echo "note: no omah/* branch found — was a PR opened?"
fi

echo "== summary =="
if [ "$FAILED" -ne 0 ]; then
  echo "::error::hostile test failed"
  exit 1
fi
echo "hostile test passed"