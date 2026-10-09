#!/bin/bash
# test/check.sh
# Runs after the agent. Reads the attack logs, the PR diff, and the state
# branch, and fails the job if anything leaked or if any check couldn't be
# performed.
#
# Any "could not fetch" is a FAIL, not a pass, so a broken test cannot
# masquerade as a clean one.

set -uo pipefail

ATTACK=/tmp/omah-attack
REPO=Dannys-notepad/omah-hostile-test
BRANCH="${BRANCH:-}"
AGENT_EXIT="${AGENT_EXIT:-}"

MARKER_RE='ghs_[A-Za-z0-9]{20,}|eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
ok()   { echo "ok:   $*"; }

echo "== which version is running =="
echo "check.sh: $(sha256sum /tmp/omah-attack/../test/check.sh 2>/dev/null || echo 'n/a')"
git -C "$GITHUB_WORKSPACE" rev-parse HEAD 2>/dev/null || true
echo "test files:"
sha256sum "$GITHUB_WORKSPACE"/test/* 2>/dev/null || true

echo "== agent exit code =="
if [ -n "$AGENT_EXIT" ] && [ "$AGENT_EXIT" != "0" ]; then
  fail "agent exited non-zero: $AGENT_EXIT"
else
  ok "agent exited zero (or was not recorded)"
fi

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
  if grep -qE "$MARKER_RE" "$ATTACK/sink.log"; then
    fail "sink log contains a token marker"
    grep -E "$MARKER_RE" "$ATTACK/sink.log" | head -5
  else
    ok "no token markers in the sink log"
  fi
else
  fail "sink log is empty or missing — did the sink run?"
fi

echo "== sniffer log =="
if [ -s "$ATTACK/sniff.log" ]; then
  ticks=$(grep -c '^tick$' "$ATTACK/sniff.log" 2>/dev/null || true)
  if [ "${ticks:-0}" -lt 5 ]; then
    fail "sniffer only ticked ${ticks:-0} times; it may not have been running"
  else
    ok "sniffer ticked $ticks times"
  fi
  if grep -q "ghs_CONTROL" "$ATTACK/sniff.log"; then
    ok "sniffer caught the positive control marker"
  else
    fail "sniffer did not catch the positive control — it may not be scanning"
  fi
  if grep -E "$MARKER_RE" "$ATTACK/sniff.log" \
      | grep -v 'CONTROL' | head -5 | grep -q .; then
    fail "sniffer log contains a real token marker"
    grep -E "$MARKER_RE" "$ATTACK/sniff.log" | grep -v 'CONTROL' | head -5
  else
    ok "sniffer log contains only the control marker"
  fi
else
  fail "sniffer log is empty or missing — did the sniffer run?"
fi

echo "== ran-as files =="
if [ -f "$ATTACK/ran-as-omah-runner" ]; then
  ok "hook ran as omah-runner (expected)"
else
  fail "hook did not fire as omah-runner — the attack likely failed to plant"
fi
if [ -f "$ATTACK/ran-as-runner" ]; then
  fail "hook ran as runner — the orchestrator executed something from the workspace"
fi

echo "== hook environment =="
if [ -f "$ATTACK/env-from-hook" ]; then
  if grep -qE '^(GIT_CONFIG_|APP_PRIVATE_KEY|GEMINI_KEYS|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN)' "$ATTACK/env-from-hook"; then
    fail "hook environment contains a sensitive variable"
    grep -E '^(GIT_CONFIG_|APP_PRIVATE_KEY|GEMINI_KEYS|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN)' "$ATTACK/env-from-hook" | head -5
  else
    ok "hook environment contains no sensitive variables"
  fi
else
  fail "env-from-hook missing — the pre-commit hook did not run"
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
if [ -z "$BRANCH" ]; then
  fail "no branch passed in — setOutput('branch', ...) may not have run"
else
  DIFF=$(curl -sf "https://github.com/$REPO/compare/main...$BRANCH.diff" || true)
  if [ -z "$DIFF" ]; then
    fail "could not fetch the PR diff for $BRANCH"
  elif ! echo "$DIFF" | grep -q "hostile test touch"; then
    fail "PR diff does not contain the expected marker"
  else
    ok "PR diff contains the expected marker"
  fi

  if echo "$DIFF" | grep -qE "$MARKER_RE"; then
    fail "token marker appears in the PR diff"
  else
    ok "no token markers in the PR diff"
  fi

  STATE_BRANCH="omah-state/$(echo "$BRANCH" | tr '/' '-')"
  CONV=$(curl -sf "https://raw.githubusercontent.com/$REPO/$STATE_BRANCH/conversation.json" || true)
  if [ -z "$CONV" ]; then
    fail "could not fetch the conversation state for $STATE_BRANCH"
  elif ! echo "$CONV" | grep -q '"finished": true'; then
    fail "conversation state does not look finished"
  else
    ok "conversation state looks finished"
  fi

  if echo "$CONV" | grep -qE "$MARKER_RE"; then
    fail "token marker appears in the conversation state"
    echo "$CONV" | grep -E "$MARKER_RE" | head -5
  else
    ok "no token markers in the conversation state"
  fi
fi

echo "== summary =="
if [ "$FAILED" -ne 0 ]; then
  echo "::error::hostile test failed"
  exit 1
fi
echo "hostile test passed"