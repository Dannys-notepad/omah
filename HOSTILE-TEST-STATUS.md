# Hostile test status

**Last pass:** 2026-10-09
**Tag:** v0.1-hostile-pass

## What was verified

- No token markers in: sink log, sniffer log, PR diff, conversation state
- All /proc/<runner-pid>/environ reads denied
- /home/runner inaccessible
- sudo denied
- docker socket inaccessible
- No orphan omah-runner processes
- Pre-commit hook fired as omah-runner, not runner
- Redirect control: git ls-remote hit the sink, proving the planted
  insteadOf was active and the sink would have caught a leak
- Sniffer alive for 69 ticks and caught the positive control

## What this does NOT cover

- Network egress (the runner has open outbound)
- Kernel-level attacks
- Compromise of the GitHub runner image itself
- Anything during the push phase (the agent is dead by then)

## Re-run this test when

- asAgent, asOrchestrator, or runBashWithDetach changes
- The isolation canary changes
- The workflow's user-creation or chmod steps change
- pkill ordering changes
- Any change to the four files in test/ that the test depends on
