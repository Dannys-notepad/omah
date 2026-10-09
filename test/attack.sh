#!/bin/bash
# Runs as omah-runner before the agent. Starts sink, sniffer, control.
set -euo pipefail

ATTACK=/tmp/omah-attack
LOG="$ATTACK/sink.log"
STDOUT="$ATTACK/sink-stdout.log"

cd "$ATTACK"

setsid nohup env PATH="$PATH" HOME=/home/omah-runner \
  node --experimental-strip-types "$ATTACK/sink.ts" \
  </dev/null >>"$STDOUT" 2>&1 &
echo "sink launched"

up=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/ping || true)
  if [ "$code" = "200" ]; then
    up=1
    echo "sink up after ${i} tries"
    break
  fi
  sleep 0.5
done

if [ "$up" -ne 1 ]; then
  echo "FATAL: sink did not come up in 15s"
  cat "$STDOUT" 2>/dev/null || echo "(no stdout log)"
  exit 1
fi

curl -sf -o /dev/null -X POST http://127.0.0.1:8787/self-test -d "self-test"
echo "self-test sent"

if [ -f "$LOG" ] && grep -q "self-test" "$LOG"; then
  echo "self-test confirmed in sink log"
else
  echo "FATAL: self-test was sent but is not in the sink log"
  cat "$LOG" 2>/dev/null || echo "(no sink log)"
  exit 1
fi

setsid nohup bash "$ATTACK/sniff.sh" </dev/null >/dev/null 2>&1 &
echo "sniffer launched"

setsid nohup sleep 300 ghs_CONTROL0000000000000000 </dev/null >/dev/null 2>&1 &
echo "control launched"