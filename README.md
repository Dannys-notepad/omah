# Omah

A personal coding agent that runs on GitHub Actions, accepts a repo and a task,
works in a disposable runner, and delivers its result as a GitHub pull request.

**Repo in, PR out. From your phone. For free. While you sleep.**

## Setup

1. Create a GitHub App: Contents (read/write), Pull requests (read/write).
2. Install it on the target repo.
3. Add secrets: `GEMINI_KEYS`, `OMAH_APP_ID`, `OMAH_APP_PRIVATE_KEY`.
4. Add variables: `OMAH_APP_BOT_ID` (required), `OMAH_ALLOWED_REPOS` (optional).
5. Trigger the **Omah** workflow with a repo and a task.

The bot user id is `gh api "/users/<app-slug>[bot]" --jq .id`.

## Security

The agent runs as an unprivileged user in a disposable runner. No authenticated
git operation runs inside the workspace. Tokens travel via environment
variables only, never argv. The hostile test (`omah-hostile.yml`) verifies this
on demand.

## Files

- `agent.ts` — the agent loop
- `system.md` — the system prompt
- `.omahignore.default` — default ignore patterns
- `.github/workflows/omah.yml` — production workflow
- `.github/workflows/omah-hostile.yml` — hostile security test
- `test/` — the hostile test's helpers

## Running the hostile test

Create a public repo `omah-hostile-test` with a README, install the App on it,
add it to `OMAH_ALLOWED_REPOS`, then dispatch `omah-hostile.yml` manually. The
check step is the source of truth. A pass means the specific attacks the test
plants are blocked on the current runner image. Network egress and kernel-level
attacks are out of scope.