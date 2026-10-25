// The shell tool (docs/bots/RUNTIME.md, "Tools"): one command inside the workspace, with a
// deadline, an output cap, a process group that dies with it, an allowlist environment and
// a sandbox that keeps the daemon's root and other bots out of reach.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { MAX_COMMAND_OUTPUT_BYTES } from "../../src/tools/limits.ts";
import { runCommandTool } from "../../src/tools/shell.ts";
import type { BotWorkspace } from "../../src/tools/types.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

const bench = async (): Promise<{
  workspace: BotWorkspace;
  cleanup: () => Promise<void>;
}> => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-shell-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"), daemonRoot);
  return {
    workspace,
    cleanup: () => rm(daemonRoot, { recursive: true, force: true }),
  };
};

test("run_command runs in the workspace and reports stdout, stderr and the exit code", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const ok = await runCommandTool(workspace, { command: "printf hello && pwd" });
    assert.equal(ok.isError, undefined);
    assert.ok(ok.output.startsWith("hello"));
    assert.ok(ok.output.includes(basename(workspace.root)), "cwd is the workspace");
    assert.match(ok.output, /\[exit code 0\]$/);

    const failedCommand = await runCommandTool(workspace, { command: "printf bad >&2; exit 3" });
    assert.equal(failedCommand.isError, undefined, "a non-zero exit is a result, not a failure");
    assert.match(failedCommand.output, /\[stderr\]\nbad/);
    assert.match(failedCommand.output, /\[exit code 3\]$/);
  } finally {
    await cleanup();
  }
});

test("a command cannot read the daemon's root or another bot", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const token = join(workspace.daemonRoot, "token");
    const otherBot = join(workspace.daemonRoot, "bots", "b", "private.txt");
    await mkdir(join(workspace.daemonRoot, "bots", "b"), { recursive: true });
    await Bunless(token, "TOKEN-SECRET");
    await Bunless(otherBot, "B-SECRET");
    const run = await runCommandTool(workspace, {
      command: `cat ${token} 2>&1; cat ${otherBot} 2>&1; echo done`,
    });
    assert.equal(run.output.includes("TOKEN-SECRET"), false);
    assert.equal(run.output.includes("B-SECRET"), false);
    assert.match(run.output, /Operation not permitted/);
    assert.match(run.output, /done/, "the workspace itself still works");
    // Outside the daemon root the shell is the agent's own machine (documented).
    const machine = await runCommandTool(workspace, { command: "head -c 4 /etc/hosts" });
    assert.match(machine.output, /\[exit code 0\]$/);
  } finally {
    await cleanup();
  }
});

test("run_command honours a relative cwd and refuses one outside the workspace", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const run = await runCommandTool(workspace, { command: "printf data > out.txt", cwd: "." });
    assert.match(run.output, /\[exit code 0\]$/);
    assert.equal(await readFile(join(workspace.root, "out.txt"), "utf8"), "data");
    const outside = await runCommandTool(workspace, { command: "pwd", cwd: "../.." });
    assert.equal(outside.isError, true);
    assert.match(outside.output, /outside the workspace/);
  } finally {
    await cleanup();
  }
});

test("a timeout kills the whole process group and returns promptly", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const started = Date.now();
    const timedOut = await runCommandTool(workspace, {
      command: "(sleep 0.3; printf survived > late.txt) & wait",
      timeoutMs: 50,
    });
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.output, /timed out after 50 ms/);
    assert.ok(Date.now() - started < 280, "the deadline is not stretched by a descendant");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      await readFile(join(workspace.root, "late.txt"), "utf8").catch(() => "absent"),
      "absent",
      "a background descendant dies with the command",
    );
  } finally {
    await cleanup();
  }
});

test("an abort kills the command and says so", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const controller = new AbortController();
    const running = runCommandTool(workspace, { command: "sleep 5" }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const aborted = await running;
    assert.equal(aborted.isError, true);
    assert.match(aborted.output, /aborted/);
    assert.ok(Date.now() - started < 1_000, "abort does not wait for the command");
  } finally {
    await cleanup();
  }
});

test("a setsid descendant cannot outlive the deadline", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const started = Date.now();
    const timedOut = await runCommandTool(workspace, {
      command:
        "perl -e 'if (fork() == 0) { setsid(); sleep 0.4; open(F, q{>}, q{late.txt}); print F q{survived}; }' ; sleep 0.4",
      timeoutMs: 100,
    });
    assert.equal(timedOut.isError, true);
    assert.ok(Date.now() - started < 280, "a detached descendant does not stretch the deadline");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await readFile(join(workspace.root, "late.txt"), "utf8").catch(() => "absent"),
      "absent",
      "a descendant that left the process group is killed too",
    );
  } finally {
    await cleanup();
  }
});

test("a stderr marker is written once, even across many chunks", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const split = await runCommandTool(workspace, {
      command: "printf BUILD_ >&2; sleep 0.05; printf FAILED >&2",
    });
    assert.match(split.output, /\[stderr\]\nBUILD_FAILED/);
    assert.equal((split.output.match(/\[stderr\]/g) ?? []).length, 1);

    const many = await runCommandTool(workspace, {
      command: "perl -e 'for (1..10000) { print STDERR q{x}; }' 2>&1 1>/dev/null",
    });
    assert.ok(Buffer.byteLength(many.output) <= 64 * 1024 + 100);
  } finally {
    await cleanup();
  }
});

test("the output cap covers stdout and stderr together", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const half = Math.floor(MAX_COMMAND_OUTPUT_BYTES / 2) + 1_000;
    const big = await runCommandTool(workspace, {
      command: `head -c ${half} /dev/zero | tr '\\0' 'x'; head -c ${half} /dev/zero | tr '\\0' 'y' >&2`,
    });
    assert.match(big.output, /\[output truncated\]/);
    assert.ok(Buffer.byteLength(big.output) < MAX_COMMAND_OUTPUT_BYTES + 200);
  } finally {
    await cleanup();
  }
});

test("a multi-byte character split across chunks is decoded, not replaced", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const run = await runCommandTool(workspace, {
      command: "printf '\\344'; sleep 0.05; printf '\\275\\240'",
    });
    assert.equal(run.output, "你\n[exit code 0]");
  } finally {
    await cleanup();
  }
});

test("a timeout keeps the stderr it already collected", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const timedOut = await runCommandTool(workspace, {
      command: "printf diagnostic >&2; sleep 0.2",
      timeoutMs: 50,
    });
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.output, /diagnostic/);
  } finally {
    await cleanup();
  }
});

test("run_command does not hand the daemon's secrets to the child", async () => {
  const { workspace, cleanup } = await bench();
  const previous = process.env.BOTS_API_KEY;
  process.env.BOTS_API_KEY = "should-not-leak";
  try {
    const run = await runCommandTool(workspace, {
      command: "printenv BOTS_API_KEY || echo absent",
    });
    assert.equal(run.output.includes("should-not-leak"), false);
    assert.match(run.output, /absent/);
  } finally {
    if (previous === undefined) delete process.env.BOTS_API_KEY;
    else process.env.BOTS_API_KEY = previous;
    await cleanup();
  }
});

const Bunless = async (path: string, body: string): Promise<void> => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, body, { mode: 0o600 });
};
