// src/tools.ts
// Tool implementations used by the agent loop. Each tool runs as the
// unprivileged agent user. Nothing here knows about the review gate or
// the push phase.

import { spawn } from "node:child_process";
import path from "node:path";
import { parseToolCall, type ToolName } from "./tool-contract.js";
import type {
  ChunkErrorCode,
  ChunkOutcome,
  ToolResult,
  WriteState,
} from "./types.js";
import {
  AGENT_USER,
  AGENT_HOME,
  WORKSPACE,
  //BASH_HEAD_CHARS,
  //BASH_TAIL_CHARS,
  MAX_BASH_OUT,
  MAX_CHUNK_BYTES,
  MAX_FILE_BYTES,
  SENTINEL_MORE,
  SENTINEL_END,
  ANSI_PATTERN,
  KEY_LINE_PATTERN,
  ZERO_LINE_PATTERN,
  TEST_SUMMARY_PATTERN,
  KEY_LINES_MAX,
  KEY_LINE_CHARS,
} from "./config.js";
import { asAgent, asOrchestrator, safePath } from "./infra.js";

// ---------------------------------------------------------------
// Bash output helpers
// ---------------------------------------------------------------

export function cleanOutput(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(ANSI_PATTERN, "");
}

export function formatBashOutput(result: {
  stdout: string;
  stderr: string;
  code: number;
}): string {
  return `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export function buildBashDigest(
  fullOutput: string,
  exitCode: number,
): {
  exitCode: number;
  keyLines?: string[];
  keyLinesTotal?: number;
  testSummary?: string;
} {
  const cleaned = cleanOutput(fullOutput);
  const lines = cleaned.split("\n");

  const matched: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!KEY_LINE_PATTERN.test(line)) continue;
    if (ZERO_LINE_PATTERN.test(line)) continue;
    const cut = line.slice(0, KEY_LINE_CHARS);
    if (seen.has(cut)) continue;
    seen.add(cut);
    matched.push(cut);
  }

  const keyLinesTotal = matched.length;
  const keyLines = matched.slice(0, KEY_LINES_MAX);
  const testSummary = lines.find((l) => TEST_SUMMARY_PATTERN.test(l))?.trim();

  const digest: {
    exitCode: number;
    keyLines?: string[];
    keyLinesTotal?: number;
    testSummary?: string;
  } = { exitCode };

  if (keyLines.length > 0) {
    digest.keyLines = keyLines;
    digest.keyLinesTotal = keyLinesTotal;
  }
  if (testSummary) digest.testSummary = testSummary.slice(0, KEY_LINE_CHARS);

  return digest;
}

// ---------------------------------------------------------------
// Raw-write chunk handling
// ---------------------------------------------------------------

function looksLikeToolCall(raw: string): boolean {
  return parseToolCall(raw, "poolside").kind !== "none";
}

export function handleRawChunk(
  raw: string,
  state: WriteState,
  filePath: string,
): ChunkOutcome {
  if (looksLikeToolCall(raw)) {
    return {
      kind: "error",
      code: "TOOL_CALL_GUARD",
      message:
        "Expected raw file contents, got a JSON tool call. " +
        "Call request_write again, then send the raw contents.",
    };
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const last = lines.length ? lines[lines.length - 1].trim() : "";

  let isMore = false;
  if (last === SENTINEL_MORE) {
    isMore = true;
  } else if (last !== SENTINEL_END) {
    const containsToolMarkup = /<\/?tool_call\b|<arg_key\b|<arg_value\b/i.test(raw);
    return {
      kind: "error",
      code: "MISSING_SENTINEL",
      message:
        containsToolMarkup
          ? `Raw response for ${filePath} contained malformed tool-call markup instead of file contents. Nothing was written; missing ${SENTINEL_END}.`
          : `Missing ${SENTINEL_END} line, nothing was written ` +
            `(the reply may have been cut off). Call request_write again ` +
            `and send the file in chunks of ~250 lines.`,
    };
  }
  lines.pop();

  if (
    !/\.mdx?$/i.test(filePath) &&
    lines.length >= 2 &&
    /^```/.test(lines[0].trim()) &&
    lines[lines.length - 1].trim() === "```"
  ) {
    lines.shift();
    lines.pop();
  }

  const body = lines.length ? lines.join("\n") + "\n" : "";
  const buf = Buffer.from(body, "utf8");

  if (buf.length > MAX_CHUNK_BYTES) {
    return {
      kind: "error",
      code: "CHUNK_TOO_LARGE",
      message: `chunk too large (${buf.length} bytes). Split it.`,
    };
  }
  if (state.bytesTotal + buf.length > MAX_FILE_BYTES) {
    return {
      kind: "error",
      code: "FILE_TOO_LARGE",
      message: "file too large. Finish as blocked.",
    };
  }

  state.chunks.push(buf);
  state.bytesTotal += buf.length;
  return isMore ? { kind: "more" } : { kind: "end" };
}

export function rawWriteRetryInstruction(
  filePath: string,
  code: ChunkErrorCode,
  provider: string,
): string {
  if (code === "FILE_TOO_LARGE") {
    return `The file ${JSON.stringify(filePath)} exceeds the write limit. Stop and finish as blocked; do not retry this file.`;
  }
  if (code === "CHUNK_TOO_LARGE") {
    return `The chunk for ${JSON.stringify(filePath)} exceeded 200 KB. Call request_write again and split the file into smaller chunks, ending non-final chunks with ${SENTINEL_MORE}.`;
  }

  const providerRule = provider === "poolside"
    ? "Do not emit <tool_call>, <arg_key>, <arg_value>, JSON, XML, or shell commands in the raw payload."
    : "Do not emit another tool call, JSON envelope, or explanation in the raw payload.";
  return (
    `The raw write for ${JSON.stringify(filePath)} was rejected (${code}); no bytes were written. ` +
    `Call request_write again for the same path. When asked for contents, send only the file bytes, ` +
    `then end with a line containing exactly ${SENTINEL_END}. ${providerRule}`
  );
}

export async function writeAsAgentBytes(
  destPath: string,
  contents: Buffer,
): Promise<{ ok: boolean; output: string }> {
  const full = safePath(destPath);
  await asAgent("mkdir", ["-p", path.dirname(full)]);

  return new Promise((resolve) => {
    const child = spawn("sudo", ["-u", AGENT_USER, "tee", full], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ ok: false, output: `tee error: ${err.message}` }),
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output: `wrote ${full}` });
      else resolve({ ok: false, output: `tee exit ${code}: ${stderr}` });
    });
    child.stdin.end(contents);
  });
}

// ---------------------------------------------------------------
// Bash execution
// ---------------------------------------------------------------

export async function runBashWithDetach(
  cmd: string,
  timeoutMs: number = 5 * 60 * 1000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      "sudo",
      [
        "-u",
        AGENT_USER,
        "env",
        `PATH=${process.env.PATH}`,
        `HOME=${AGENT_HOME}`,
        `XDG_CONFIG_HOME=${AGENT_HOME}/.config`,
        `NPM_CONFIG_CACHE=${AGENT_HOME}/.npm`,
        "bash",
        "-c",
        cmd,
      ],
      { cwd: WORKSPACE, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };

    const timer = setTimeout(async () => {
      child.kill("SIGKILL");
      await asOrchestrator("sudo", ["pkill", "-9", "-u", AGENT_USER]);
      done(124);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_BASH_OUT) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_BASH_OUT) stderr += d.toString();
    });

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      done(1);
    });

    child.on("exit", (code, sig) => {
      const finalCode = code ?? (sig ? 137 : 1);
      setTimeout(() => done(finalCode), 300);
    });
  });
}

// ---------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------

export async function runTool(
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (tool) {
    case "read_file": {
      const p = safePath(String(args.path));
      const { stdout, stderr, code } = await asAgent("cat", [p]);
      if (code !== 0) return { ok: false, output: stderr };
      return { ok: true, output: stdout };
    }
    case "run_bash": {
      const cmd = String(args.command ?? "");
      if (!cmd) return { ok: false, output: "empty command" };
      const result = await runBashWithDetach(cmd);
      const formatted = formatBashOutput(result);
      const digest = buildBashDigest(formatted, result.code);
      if (
        result.code === 124 ||
        result.code === 126 ||
        result.code === 127 ||
        result.stderr.startsWith("sudo failure:")
      ) {
        return {
          ok: false,
          output: `tool failure (exit ${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ...digest,
        };
      }
      return {
        ok: true,
        output: formatted,
        ...digest,
      };
    }
    case "git_commit": {
      const msg = String(args.message ?? "omah: changes");
      const trailer = process.env.AUTHOR_NAME && process.env.AUTHOR_EMAIL
        ? `\n\nCo-authored-by: ${process.env.AUTHOR_NAME} <${process.env.AUTHOR_EMAIL}>`
        : "";
      await asAgent("git", ["add", "-A"]);
      const { stdout, stderr, code } = await asAgent("git", [
        "commit",
        "-m",
        msg + trailer,
      ]);
      if (code !== 0) return { ok: false, output: stderr };
      return { ok: true, output: stdout };
    }
    default:
      return { ok: false, output: `unknown tool: ${tool}` };
  }
}