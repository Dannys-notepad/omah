#!/bin/bash
# test/attack.sh
# Runs as omah-runner before the agent. Starts the sink and sends a self-test
# request to prove it works. The sniffer is started by the scripted task.

set -euo pipefail

ATTACK=/tmp/omah-attack
LOG="$ATTACK/sink.log"
STDOUT="$ATTACK/sink-stdout.log"

# Start the sink.
cd "$ATTACK"
setsid nohup env PATH="$PATH" HOME=/home/omah-runner \
  node --experimental-strip-types "$ATTACK/sink.ts" \
  >>"$STDOUT" 2>&1 &
echo "sink launched"

# Wait for the sink to come up. Hard-fail if it doesn't.
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
  echo "--- sink-stdout.log ---"
  cat "$STDOUT" 2>/dev/null || echo "(no stdout log)"
  exit 1
fi

# Send the self-test so the checker can confirm the sink received it.
curl -sf -o /dev/null -X POST http://127.0.0.1:8787/self-test -d "self-test"
echo "self-test sent"

# Confirm the sink logged it before we return.
if [ -f "$LOG" ] && grep -q "self-test" "$LOG"; then
  echo "self-test confirmed in sink log"
else
  echo "FATAL: self-test was sent but is not in the sink log"
  echo "--- sink.log ---"
  cat "$LOG" 2>/dev/null || echo "(no sink log)"
  exit 1
fi