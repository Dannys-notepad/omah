#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const WORKFLOW = "omah.yml";
const MAX_TASK_CHARS = 60_000;
const PROVIDERS = new Set([
  "default",
  "gemini",
  "requesty",
  "groq",
  "mistral",
  "nvidia",
  "poolside",
]);
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^omah\/[a-z0-9-]+$/;

export function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const separator = token.indexOf("=");
    const name = token.slice(2, separator < 0 ? undefined : separator);
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Option repeated: --${name}`);

    let value;
    if (separator >= 0) {
      value = token.slice(separator + 1);
    } else {
      value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Option --${name} needs a value`);
      }
    }
    options[name] = value;
  }
  return options;
}

export function validateRepo(repo) {
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    throw new Error('Repository must be in "owner/name" format');
  }
  return repo;
}

export function validateBranch(branch) {
  if (typeof branch !== "string" || !BRANCH_PATTERN.test(branch)) {
    throw new Error("Branch must be an Omah branch like omah/fix-login-a1b2c3d4");
  }
  return branch;
}

export async function resolveTask(options) {
  const hasTask = typeof options.task === "string";
  const hasTaskFile = typeof options["task-file"] === "string";
  if (hasTask === hasTaskFile) {
    throw new Error("Provide exactly one of --task or --task-file");
  }

  if (hasTask) {
    return validateTask(options.task);
  }

  if (!options["task-file"].trim()) throw new Error("Task file path must not be empty");
  const task = await fs.readFile(options["task-file"], "utf8");
  return validateTask(task, "Task file is empty");
}

function validateTask(task, emptyMessage = "Task must not be empty") {
  if (!task.trim()) throw new Error(emptyMessage);
  if (task.length > MAX_TASK_CHARS) {
    throw new Error(`Task exceeds the ${MAX_TASK_CHARS.toLocaleString()} character CLI limit`);
  }
  return task;
}

export function buildWorkflowArgs(mode, options, controlRepo) {
  const repo = validateRepo(options.repo);
  const args = [
    "workflow",
    "run",
    WORKFLOW,
    "--repo",
    validateRepo(controlRepo),
    "--field",
    `repo=${repo}`,
  ];

  if (options["base"]) args.push("--field", `base_branch=${options["base"]}`);
  if (options["provider"]) {
    if (!PROVIDERS.has(options["provider"])) {
      throw new Error(`Unknown provider: ${options["provider"]}`);
    }
    args.push("--field", `provider=${options["provider"]}`);
  }

  if (mode === "run") {
    args.push("--field", `task=${validateTask(options.task, "Run requires a non-empty task")}`);
  } else if (mode === "resume") {
    const branch = validateBranch(options.branch);
    validateTask(options.task, "Resume requires non-empty --task");
    args.push(
      "--field",
      "resume=true",
      "--field",
      `branch=${branch}`,
      "--field",
      `resume_text=${options.task}`,
    );
  } else {
    throw new Error(`Unsupported workflow mode: ${mode}`);
  }

  return args;
}

export function configFilePath(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return pathApi.join(
      env.APPDATA || pathApi.join(home, "AppData", "Roaming"),
      "omah",
      "config.json",
    );
  }
  return pathApi.join(env.XDG_CONFIG_HOME || pathApi.join(home, ".config"), "omah", "config.json");
}

async function readConfig(filePath = configFilePath()) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config root must be an object");
    }
    if (config.controlRepo !== undefined) validateRepo(config.controlRepo);
    return config;
  } catch (error) {
    throw new Error(`Invalid CLI config at ${filePath}: ${error.message}`);
  }
}

async function writeControlRepo(repo, filePath = configFilePath()) {
  validateRepo(repo);
  const config = await readConfig(filePath);
  config.controlRepo = repo;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved control repo ${repo} in ${filePath}`);
}

async function resolveControlRepo(optionValue) {
  if (optionValue) return validateRepo(optionValue);
  if (process.env.OMAH_CONTROL_REPO) return validateRepo(process.env.OMAH_CONTROL_REPO);
  const config = await readConfig();
  const repo = config.controlRepo;
  if (!repo) {
    throw new Error(
      "Control repo is not configured. Run `omah config set control-repo owner/omah`, " +
        "set OMAH_CONTROL_REPO, or pass --control-repo.",
    );
  }
  return validateRepo(repo);
}

async function gh(args) {
  try {
    return await execFileAsync("gh", args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("GitHub CLI `gh` was not found. Install it and make sure it is on PATH.");
    }
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`gh ${args[0]} failed: ${detail}`);
  }
}

async function checkGhAuth() {
  await gh(["auth", "status", "--hostname", "github.com"]);
}

async function dispatch(mode, options) {
  const repo = validateRepo(options.repo);
  if (options.provider && !PROVIDERS.has(options.provider)) {
    throw new Error(`Unknown provider: ${options.provider}`);
  }

  if (mode === "run") {
    options.task = await resolveTask(options);
    delete options["task-file"];
  } else {
    validateBranch(options.branch);
    options.task = await resolveTask(options);
    delete options["task-file"];
  }

  const controlRepo = await resolveControlRepo(options["control-repo"]);
  const args = buildWorkflowArgs(mode, { ...options, repo }, controlRepo);
  await checkGhAuth();
  let result;
  try {
    result = await gh(args);
  } catch (error) {
    if (/network|timed out|connection|HTTP 5\d\d|\b5\d\d\b/i.test(error.message)) {
      throw new Error(
        `${error.message}\nIf dispatch status is uncertain, check Actions before retrying to avoid a duplicate run.`,
      );
    }
    throw error;
  }
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  console.log("Dispatch accepted by GitHub. Check the Actions page for queue and run status.");
}

async function showStatus(options) {
  if (options["run-id"] && !/^\d+$/.test(options["run-id"])) {
    throw new Error("--run-id must contain only digits");
  }
  const controlRepo = await resolveControlRepo(options["control-repo"]);
  await checkGhAuth();

  const args = options["run-id"]
    ? [
        "run",
        "view",
        options["run-id"],
        "--repo",
        controlRepo,
        "--json",
        "databaseId,displayTitle,status,conclusion,url,createdAt",
      ]
    : [
        "run",
        "list",
        "--workflow",
        WORKFLOW,
        "--repo",
        controlRepo,
        "--limit",
        "1",
        "--json",
        "databaseId,displayTitle,status,conclusion,url,createdAt",
      ];
  const { stdout } = await gh(args);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("GitHub CLI returned invalid JSON while reading workflow status");
  }
  const run = Array.isArray(result) ? result[0] : result;
  if (!run) {
    console.log("No Omah workflow runs found.");
    return;
  }

  console.log(`Run: #${run.databaseId}${run.displayTitle ? ` ${run.displayTitle}` : ""}`);
  console.log(`Status: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}`);
  if (run.createdAt) console.log(`Created: ${run.createdAt}`);
  if (run.url) console.log(`URL: ${run.url}`);
  if (!options["run-id"]) {
    console.log("This is the latest Omah run, not necessarily the one you just dispatched.");
  }
}

async function showStats(options) {
  const controlRepo = await resolveControlRepo(options["control-repo"]);
  await checkGhAuth();

  let limit = null;
  if (options["runs"] !== undefined) {
    limit = Number(options["runs"]);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("--runs must be a positive integer");
    }
  }

  const runs = await fetchRunsFile(controlRepo);
  if (!runs || runs.length === 0) {
    console.log("No runs recorded yet.");
    return;
  }

  const scoped = limit ? runs.slice(-limit) : runs;
  printSummary(scoped);
}

async function fetchRunsFile(controlRepo) {
  try {
    const { stdout } = await gh([
      "api",
      `repos/${controlRepo}/contents/runs.json?ref=omah-runs`,
      "--jq",
      ".content",
    ]);
    const b64 = stdout.replace(/\s/g, "");
    if (!b64) return null;
    const raw = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.runs)) {
      return null;
    }
    return parsed.runs;
  } catch (error) {
    if (/404|not found|not exist/i.test(String(error.message))) return null;
    throw error;
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function classifyBlockedReason(summary) {
  if (!summary) return "(unknown)";
  const s = summary.toLowerCase();
  if (s.includes("wall-clock budget")) return "Wall-clock budget exceeded";
  if (s.includes("consecutive tool errors")) return "Consecutive tool errors";
  if (s.includes("all llm keys are exhausted")) return "All keys exhausted";
  if (s.includes("key cooldown")) return "Key cooldown exceeded budget";
  if (s.includes("refusing to push")) return "Refused to push (secret)";
  if (s.includes("llm call failed")) return "LLM call failed";
  return summary.slice(0, 60);
}

function printSummary(runs) {
  const total = runs.length;
  const done = runs.filter((r) => r.status === "done").length;
  const blocked = total - done;
  const merged = runs.filter((r) => r.outcome === "merged").length;
  const edited = runs.filter((r) => r.outcome === "edited").length;
  const closed = runs.filter((r) => r.outcome === "closed").length;
  const resolved = merged + edited + closed;

  console.log(`Runs: ${total}  (done ${done}, blocked ${blocked})`);
  console.log(`Completion rate: ${total > 0 ? Math.round((done / total) * 100) : 0}%`);

  if (resolved > 0) {
    console.log(
      `Outcomes: merged ${merged}, edited ${edited}, closed ${closed} ` +
        `(${resolved} of ${total} resolved)`,
    );
  } else {
    console.log("Outcomes: none recorded yet.");
  }
  console.log("");

  const reasons = new Map();
  for (const run of runs) {
    if (run.status !== "blocked") continue;
    const reason = classifyBlockedReason(run.blockedReason || run.summary || "");
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  if (reasons.size > 0) {
    console.log("Blocked reasons:");
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}  ${reason}`);
    }
    console.log("");
  }

  const successful = runs.filter((r) => r.status === "done");
  if (successful.length > 0) {
    const tokensIn = successful.map((r) => r.tokensIn || 0);
    const tokensOut = successful.map((r) => r.tokensOut || 0);
    const steps = successful.map((r) => r.steps || 0);
    console.log("Per successful run (median):");
    console.log(`  input tokens:  ${median(tokensIn).toLocaleString()}`);
    console.log(`  output tokens: ${median(tokensOut).toLocaleString()}`);
    console.log(`  steps:         ${median(steps)}`);
    console.log("");
  }

  const byProvider = new Map();
  for (const run of runs) {
    for (const k of run.keyStats || []) {
      const entry = byProvider.get(k.provider) || { calls: 0, rate429: 0, errors: 0 };
      entry.calls += k.calls;
      entry.rate429 += k.rate429;
      entry.errors += k.errors;
      byProvider.set(k.provider, entry);
    }
  }
  if (byProvider.size > 0) {
    console.log("Providers:");
    console.log("  provider        calls     429   errors");
    for (const [provider, s] of [...byProvider.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
      console.log(
        `  ${provider.padEnd(14)} ${String(s.calls).padStart(5)} ` +
          `${String(s.rate429).padStart(6)} ${String(s.errors).padStart(8)}`,
      );
    }
    console.log("");
  }

  if (successful.length > 0) {
    const wallMs = successful.map((r) => r.wallMs || 0);
    const llmMs = successful.map((r) => r.llmMs || 0);
    const setupMs = successful.map((r) => r.setupMs || 0);
    const pushMs = successful.map((r) => r.pushMs || 0);
    console.log("Wall time per successful run (median):");
    console.log(`  total: ${formatDuration(median(wallMs))}`);
    console.log(`  loop:  ${formatDuration(median(llmMs))}`);
    console.log(`  setup: ${formatDuration(median(setupMs))}`);
    console.log(`  push:  ${formatDuration(median(pushMs))}`);
  }
}

function usage() {
  console.log(`Omah CLI

Usage:
  omah run --repo owner/name (--task TEXT | --task-file PATH) [--base BRANCH] [--provider PROVIDER] [--control-repo owner/omah]
  omah resume --repo owner/name --branch omah/slug-id (--task FOLLOW_UP | --task-file PATH) [--base BRANCH] [--provider PROVIDER] [--control-repo owner/omah]
  omah status [--run-id ID] [--control-repo owner/omah]
  omah stats [--runs N] [--control-repo owner/omah]
  omah config set control-repo owner/omah
  omah config get control-repo

The control repo can also be set with OMAH_CONTROL_REPO. GitHub CLI (gh) must be installed and authenticated.`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    usage();
    return;
  }

  if (command === "config") {
    const [action, key, value, ...extra] = rest;
    if (extra.length || key !== "control-repo") {
      throw new Error(
        "Use `omah config set control-repo owner/name` or `omah config get control-repo`",
      );
    }
    if (action === "set" && value) {
      await writeControlRepo(value);
      return;
    }
    if (action === "get" && value === undefined) {
      const config = await readConfig();
      if (!config.controlRepo) throw new Error("Control repo is not configured");
      console.log(config.controlRepo);
      return;
    }
    throw new Error(
      "Use `omah config set control-repo owner/name` or `omah config get control-repo`",
    );
  }

  if (command === "run") {
    const options = parseOptions(
      rest,
      new Set(["repo", "task", "task-file", "base", "provider", "control-repo"]),
    );
    await dispatch("run", options);
    return;
  }

  if (command === "resume") {
    const options = parseOptions(
      rest,
      new Set(["repo", "branch", "task", "task-file", "base", "provider", "control-repo"]),
    );
    await dispatch("resume", options);
    return;
  }

  if (command === "status") {
    const options = parseOptions(rest, new Set(["run-id", "control-repo"]));
    await showStatus(options);
    return;
  }

  if (command === "stats") {
  const options = parseOptions(rest, new Set(["runs", "control-repo"]));
  await showStats(options);
  return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`omah: ${error.message}`);
    process.exitCode = 1;
  });
}
