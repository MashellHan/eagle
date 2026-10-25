// Ladder rows 48 and 54: a real daemon process, the kernel lock, and a takeover after the
// owner is killed outright (docs/bots/ARCHITECTURE.md, "Singleton lock").
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Child = ReturnType<typeof spawn>;

const start = (root: string): Child =>
  spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(process.cwd(), "src/main.ts"),
      "--root",
      root,
      "--port",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

/** Resolves with the daemon's start line, or rejects when it exits first. */
const started = async (child: Child): Promise<string> => {
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  for (let index = 0; index < 600; index += 1) {
    if (output.includes('"daemon.start"')) return output;
    if (child.exitCode !== null) throw new Error(`the daemon exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the daemon did not start: ${output}`);
};

const exited = (child: Child): Promise<number> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code ?? 0));
  });

test("a SIGKILLed daemon is taken over on the next start", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-crash-"));
  let first: Child | undefined;
  let second: Child | undefined;
  try {
    first = start(root);
    await started(first);

    // While it lives, a second daemon on the same root is refused even on another port.
    const rival = start(root);
    let stderr = "";
    rival.stderr?.setEncoding("utf8");
    rival.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await exited(rival);
    assert.notEqual(code, 0, "a live owner wins");
    assert.match(stderr, /already owns/, "and says which root it refused");
    // The kill is the point: no lock file to delete, no takeover race.
    first.kill("SIGKILL");
    await exited(first);
    first = undefined;

    second = start(root);
    const output = await started(second);
    assert.match(output, /"daemon.start"/, "the next start owns the root");
  } finally {
    second?.kill("SIGKILL");
    first?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
