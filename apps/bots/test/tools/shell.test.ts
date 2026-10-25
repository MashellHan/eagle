// The shell tool (docs/bots/RUNTIME.md, "Tools"): one command inside the workspace, with a
// deadline, an output cap and no daemon secrets in its environment.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { MAX_COMMAND_OUTPUT_BYTES } from "../../src/tools/limits.ts";
import { runCommandTool } from "../../src/tools/shell.ts";
import { ensureWorkspace } from "../../src/tools/workspace.ts";

const workspace = async (): Promise<{ root: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "bots-shell-"));
  await ensureWorkspace(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("run_command runs in the workspace and reports stdout, stderr and the exit code", async () => {
  const ws = await workspace();
  try {
    const ok = await runCommandTool({ root: ws.root }, { command: "printf hello && pwd" });
    assert.equal(ok.isError, undefined);
    assert.ok(ok.output.startsWith("hello"));
    assert.ok(ok.output.includes(basename(ws.root)), "cwd is the workspace");
    assert.match(ok.output, /\[exit code 0\]$/);

    const failedCommand = await runCommandTool(
      { root: ws.root },
      { command: "printf bad >&2; exit 3" },
    );
    assert.equal(failedCommand.isError, undefined, "a non-zero exit is a result, not a failure");
    assert.match(failedCommand.output, /\[stderr\]\nbad/);
    assert.match(failedCommand.output, /\[exit code 3\]$/);
  } finally {
    await ws.cleanup();
  }
});

test("run_command honours a relative cwd and a written file", async () => {
  const ws = await workspace();
  try {
    const run = await runCommandTool(
      { root: ws.root },
      { command: "printf data > out.txt", cwd: "." },
    );
    assert.match(run.output, /\[exit code 0\]$/);
    assert.equal(await readFile(join(ws.root, "out.txt"), "utf8"), "data");
    const outside = await runCommandTool({ root: ws.root }, { command: "pwd", cwd: "../.." });
    assert.equal(outside.isError, true);
    assert.match(outside.output, /outside the workspace/);
  } finally {
    await ws.cleanup();
  }
});

test("run_command kills a command that outlives its timeout", async () => {
  const ws = await workspace();
  try {
    const timedOut = await runCommandTool({ root: ws.root }, { command: "sleep 5", timeoutMs: 80 });
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.output, /timed out after 80 ms/);
  } finally {
    await ws.cleanup();
  }
});

test("run_command caps its output", async () => {
  const ws = await workspace();
  try {
    const big = await runCommandTool(
      { root: ws.root },
      { command: `head -c ${MAX_COMMAND_OUTPUT_BYTES * 2} /dev/zero | tr '\\0' 'x'` },
    );
    assert.match(big.output, /\[output truncated\]/);
    assert.ok(Buffer.byteLength(big.output) < MAX_COMMAND_OUTPUT_BYTES + 200);
  } finally {
    await ws.cleanup();
  }
});

test("run_command does not hand the daemon's secrets to the child", async () => {
  const ws = await workspace();
  const previous = process.env.BOTS_API_KEY;
  process.env.BOTS_API_KEY = "should-not-leak";
  try {
    const run = await runCommandTool(
      { root: ws.root },
      { command: "printenv BOTS_API_KEY || echo absent" },
    );
    assert.equal(run.output.includes("should-not-leak"), false);
    assert.match(run.output, /absent/);
  } finally {
    if (previous === undefined) delete process.env.BOTS_API_KEY;
    else process.env.BOTS_API_KEY = previous;
    await ws.cleanup();
  }
});
