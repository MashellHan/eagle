import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stopHeldCommand } from "../fixtures/held-command.ts";

test("real Bot SIGKILL recovery retains the original remote operation without replay", {
  timeout: 180_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "eagle-bot-recovery-"));
  const build = join(root, "helper-build");
  let helper = "";
  let clean = true;
  try {
    const gate = resolve("scripts/swift-gate.sh");
    execFileSync(
      gate,
      [
        "build",
        "--package-path",
        "apps/bots-macos",
        "--scratch-path",
        build,
        "--product",
        "BotsCredentialHelper",
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    const bin = execFileSync(
      gate,
      [
        "build",
        "--package-path",
        "apps/bots-macos",
        "--scratch-path",
        build,
        "--show-bin-path",
      ],
      { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    helper = join(bin, "BotsCredentialHelper");
    for (const variant of ["preserved-journal", "missing-journal"]) {
      await t.test(variant, { timeout: 55_000 }, async () => {
        const directory = join(root, variant);
        mkdirSync(directory, { mode: 0o700 });
        const child = spawn(
          process.execPath,
          [
            resolve("tests/fixtures/bot-remote-chain.mjs"),
            directory,
            helper,
            variant,
          ],
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
        const kill = (signal: NodeJS.Signals) => {
          if (child.pid) {
            try {
              process.kill(-child.pid, signal);
            } catch {}
          }
        };
        const timeout = setTimeout(() => kill("SIGTERM"), 45_000);
        const hardTimeout = setTimeout(() => kill("SIGKILL"), 47_000);
        try {
          const [code] = await once(child, "exit");
          assert.equal(code, 0, output);
          const report = output
            .split("\n")
            .filter((line) => line.startsWith('{"check":'))
            .map((line) => JSON.parse(line));
          assert.equal(report.length, 1, output);
          assert.deepEqual(report[0], {
            check: variant,
            passed: true,
            assertions: variant === "preserved-journal" ? 14 : 16,
            modelCalls: 3,
            fixtureProcessesStopped: true,
            fixtureKeychainItemRemoved: true,
            cleanupFailures: [],
          });
        } finally {
          clearTimeout(timeout);
          clearTimeout(hardTimeout);
          kill("SIGKILL");
          const commandStopped = await stopHeldCommand(
            join(directory, "machine-b-resources"),
          );
          clean &&= commandStopped;
          // An outer timeout can bypass the fixture's finally. Retain the exact
          // non-secret binding before put so this process can still clean it.
          const receipt = join(directory, "binding.json");
          if (existsSync(receipt)) {
            const binding = JSON.parse(readFileSync(receipt, "utf8"));
            const invoke = (action: string) =>
              spawnSync(helper, [], {
                input: JSON.stringify({ action, binding }),
                encoding: "utf8",
                timeout: 15_000,
                maxBuffer: 65_536,
                env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
              });
            const removed = invoke("remove");
            const status = invoke("status");
            const absent =
              removed.status === 0 &&
              status.status === 0 &&
              status.stdout.trim() === '{"available":false}';
            clean &&= absent;
            assert(
              absent,
              `fixture Keychain cleanup failed; non-secret receipt retained at ${receipt}`,
            );
          }
          assert(
            commandStopped,
            `fixture command cleanup unconfirmed; state retained at ${directory}`,
          );
        }
      });
    }
  } finally {
    if (clean) rmSync(root, { recursive: true, force: true });
  }
});
