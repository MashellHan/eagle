import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("real DO hibernation, Agent SIGKILL and managed JWT rotation preserve operation evidence without replay", {
  timeout: 50_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "eagle-recovery-regression-"));
  const child = spawn(
    process.execPath,
    [resolve("tests/fixtures/execution-recovery.mjs"), root],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-128 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
  const deadline = setTimeout(() => killGroup("SIGTERM"), 45_000);
  const finalDeadline = setTimeout(() => killGroup("SIGKILL"), 47_000);
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    const checks = output
      .split("\n")
      .filter((line) => line.startsWith('{"check":'))
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      checks.map((value) => [value.check, value.passed]),
      [
        ["real-do-hibernation-during-command", true],
        ["real-agent-process-restart", true],
        ["managed-jwt-rotation", true],
      ],
    );
  } finally {
    clearTimeout(deadline);
    clearTimeout(finalDeadline);
    killGroup("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
