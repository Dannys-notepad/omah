import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWorkflowArgs,
  configFilePath,
  parseOptions,
  resolveTask,
  validateBranch,
  validateRepo,
} from "../bin/omah.js";

test("parses separate and equals-style options without rewriting values", () => {
  const options = parseOptions(
    ["--repo", "owner/project", "--task=Fix the 'login' flow", "--provider", "groq"],
    new Set(["repo", "task", "provider"]),
  );

  assert.deepEqual(options, {
    repo: "owner/project",
    task: "Fix the 'login' flow",
    provider: "groq",
  });
});

test("rejects unknown, duplicate, and valueless options", () => {
  const allowed = new Set(["repo", "task"]);
  assert.throws(() => parseOptions(["--unexpected", "value"], allowed), /Unknown option/);
  assert.throws(() => parseOptions(["--repo", "a/b", "--repo", "c/d"], allowed), /repeated/);
  assert.throws(() => parseOptions(["--task"], allowed), /needs a value/);
});

test("builds a run dispatch with task text kept as one field", () => {
  const args = buildWorkflowArgs(
    "run",
    {
      repo: "owner/project",
      task: "Fix the login bug\nAdd a regression test",
      base: "develop",
      provider: "gemini",
    },
    "owner/omah",
  );

  assert.deepEqual(args, [
    "workflow", "run", "omah.yml", "--repo", "owner/omah",
    "--field", "repo=owner/project",
    "--field", "base_branch=develop",
    "--field", "provider=gemini",
    "--field", "task=Fix the login bug\nAdd a regression test",
  ]);
});

test("builds resume fields and rejects invalid targets and branches", () => {
  const args = buildWorkflowArgs(
    "resume",
    { repo: "owner/project", branch: "omah/fix-login-a1b2c3d4", task: "Address review" },
    "owner/omah",
  );
  assert.ok(args.includes("resume=true"));
  assert.ok(args.includes("branch=omah/fix-login-a1b2c3d4"));
  assert.ok(args.includes("resume_text=Address review"));
  assert.throws(() => validateRepo("owner/project/extra"), /owner\/name/);
  assert.throws(() => validateBranch("main"), /Omah branch/);
  assert.throws(
    () => buildWorkflowArgs("run", { repo: "owner/project", task: "x", provider: "invalid" }, "owner/omah"),
    /Unknown provider/,
  );
});

test("requires exactly one non-empty task source and reads multiline files", async () => {
  assert.equal(await resolveTask({ task: "  Fix bug  " }), "  Fix bug  ");
  await assert.rejects(resolveTask({ task: "", "task-file": "task.md" }), /exactly one/);
  await assert.rejects(resolveTask({ task: "   " }), /must not be empty/);
  await assert.rejects(resolveTask({ task: "x".repeat(60_001) }), /character CLI limit/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omah-cli-test-"));
  const taskPath = path.join(directory, "task.txt");
  try {
    await fs.writeFile(taskPath, "Fix the bug\nAdd tests\n");
    assert.equal(await resolveTask({ "task-file": taskPath }), "Fix the bug\nAdd tests\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("chooses platform-appropriate config paths", () => {
  assert.equal(
    configFilePath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me"),
    path.win32.join("C:\\Users\\me\\AppData\\Roaming", "omah", "config.json"),
  );
  assert.equal(
    configFilePath({ XDG_CONFIG_HOME: "/tmp/config" }, "linux", "/home/me"),
    path.posix.join("/tmp/config", "omah", "config.json"),
  );
  assert.equal(
    configFilePath({}, "linux", "/home/me"),
    path.posix.join("/home/me", ".config", "omah", "config.json"),
  );
});