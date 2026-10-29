import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { heldCommand, stopHeldCommand } from "./fixtures/held-command.ts";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

for (const mode of ["self-deadline", "outer-cleanup"]) {
  test(`held fixture command is recovered after its owning runner dies: ${mode}`, {
    timeout: 20_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "eagle-held-command-"));
    const operation = heldCommand(root);
    const module = new URL(
      "../packages/agent/command-runner.ts",
      import.meta.url,
    ).href;
    const parent = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runProcess} from ${JSON.stringify(module)};await runProcess(${JSON.stringify(operation)},new AbortController().signal,[]);`,
      ],
      { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } },
    );
    const exited = once(parent, "exit");
    let receipt: { pid: number; tag: string } | undefined;
    try {
      const readyBy = Date.now() + 3000;
      while (
        !existsSync(join(root, "command-process.json")) &&
        Date.now() < readyBy
      )
        await delay(10);
      receipt = JSON.parse(
        readFileSync(join(root, "command-process.json"), "utf8"),
      );
      assert(receipt && alive(receipt.pid));
      assert(parent.pid);
      process.kill(-parent.pid, "SIGSTOP");
      process.kill(-parent.pid, "SIGKILL");
      await exited;
      if (mode === "self-deadline") {
        const deadline = Date.now() + 11_000;
        while (alive(receipt.pid) && Date.now() < deadline) await delay(20);
        assert.equal(
          alive(receipt.pid),
          false,
          "command must enforce its own existing 10-second deadline without the runner",
        );
      } else {
        assert.equal(
          await stopHeldCommand(root),
          true,
          "outer cleanup must confirm the independently detached command stopped",
        );
        assert.equal(alive(receipt.pid), false);
      }
    } finally {
      if (
        parent.pid &&
        parent.exitCode === null &&
        parent.signalCode === null
      ) {
        process.kill(-parent.pid, "SIGKILL");
        await exited;
      }
      if (receipt && alive(receipt.pid)) {
        const command = spawnSync(
          "/bin/ps",
          ["-p", String(receipt.pid), "-o", "command="],
          { encoding: "utf8" },
        ).stdout;
        assert(
          command.includes(receipt.tag),
          "only the owned fixture process may be cleaned up",
        );
        process.kill(-receipt.pid, "SIGKILL");
        const deadline = Date.now() + 2000;
        while (alive(receipt.pid) && Date.now() < deadline) await delay(10);
        assert.equal(alive(receipt.pid), false);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
