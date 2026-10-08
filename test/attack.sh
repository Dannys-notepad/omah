#!/bin/bash
# test/attack.sh
# Runs as omah-runner before the agent. Starts the sink, starts the sniffer,
# sends a self-request to the sink to prove it's working.
set -euo pipefail

ATTACK=/tmp/omah-attack

# Start the sink. It logs to $ATTACK/sink.log.
cd "$ATTACK"
setsid nohup env PATH="$PATH" HOME=/home/omah-runner \
  node --experimental-strip-types "$ATTACK/sink.ts" \
  >>"$ATTACK/sink-stdout.log" 2>&1 &
echo "sink started"

# Wait for the sink to come up.
for i in $(seq 1 20); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/ping | grep -q 200; then
    echo "sink up after ${i} tries"
    break
  fi
  sleep 0.5
done

# Positive control: send one request so we know the sink ran.
curl -s -o /dev/null -X POST http://127.0.0.1:8787/ping -d "self-test"
echo "self-test sent"