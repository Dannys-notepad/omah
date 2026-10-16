// src/config.ts
// Constants used across Omah's modules. No logic, no imports from
// other Omah modules.

import path from "node:path";

export const WALL_CLOCK_MS = 15 * 60 * 1000;
export const MAX_CONSECUTIVE_ERRORS = 3;
export const MAX_LLM_RETRIES = 3;
export const MAX_PATCH_BYTES = 5 * 1024 * 1024;
export const MAX_PR_BODY_CHARS = 60_000;
export const MAX_BASH_OUT = 1_000_000;

export const MAX_CHUNK_BYTES = 200 * 1024;
export const MAX_FILE_BYTES = 500 * 1024;

export const SENTINEL_MORE = "<<<OMAH_MORE>>>";
export const SENTINEL_END = "<<<OMAH_END>>>";

export const RETRYABLE_KEY_COOLDOWN_MS = 30 * 1000;

export const OMAH_ROOT = "/tmp/omah";
export const WORKSPACE = path.join(OMAH_ROOT, "workspace");
export const SYSTEM_PROMPT_PATH = path.join(
  process.cwd(),
  "prompts",
  "system.md",
);
export const REVIEWER_SYSTEM_PROMPT_PATH = path.join(
  process.cwd(),
  "prompts",
  "review-system.md",
);
export const IGNORE_FILE_PATH = path.join(process.cwd(), ".omahignore.default");
export const AGENT_USER = "omah-runner";
export const AGENT_HOME = `/home/${AGENT_USER}`;

export const BASH_HEAD_CHARS = 1_500;
export const BASH_TAIL_CHARS = 2_500;

export const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
export const KEY_LINE_PATTERN =
  /fail|error|✗|✕|FAIL|Cannot find|TypeError|ReferenceError|SyntaxError|AssertionError/i;
export const ZERO_LINE_PATTERN = /\b0\s+(failed|errors?)\b|no errors?/i;
export const TEST_SUMMARY_PATTERN = /\b\d+\s+(passed|failed|suites?|tests?)\b/i;
export const KEY_LINES_MAX = 15;
export const KEY_LINE_CHARS = 200;

export const REVIEW_MAX_DIFF_BYTES = 30 * 1024;
export const REVIEW_MAX_FILE_DIFF_BYTES = 10 * 1024;
export const REVIEW_TEST_TIMEOUT_MS = 3 * 60 * 1000;
export const REVIEW_MIN_REMAINING_MS = 4 * 60 * 1000;
export const REVIEW_FIX_BUDGET_MS = 4 * 60 * 1000;
export const REVIEW_MAX_CALLS = 6;