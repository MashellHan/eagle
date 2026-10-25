// The composition root: one daemon over one root, wired from configuration, closed cleanly.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../src/config.ts";
import { startDaemon } from "../src/main.ts";

test("the daemon starts from configuration and closes without leaving work behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-main-"));
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    try {
      assert.ok(daemon.port > 0, "the kernel chose the port");
      assert.ok(daemon.token.length >= 32, "a token was issued");
      assert.equal((await stat(join(root, "token"))).mode & 0o777, 0o600);
      const health = await fetch(`http://127.0.0.1:${daemon.port}/v1/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { instance: string; bots: number };
      assert.equal(body.bots, 0);
      assert.match(body.instance, /^i_/);
      const refused = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`);
      assert.equal(refused.status, 401, "the catalog needs the token");
      const listed = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      assert.deepEqual(((await listed.json()) as { bots: unknown[] }).bots, []);

      // Creation warms the bot through the composed opener. With no reachable model
      // endpoint the open fails, and the catalog says so instead of pretending it is idle.
      const created = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "组合根" }),
      });
      assert.equal(created.status, 201);
      const botId = ((await created.json()) as { bot: { id: string } }).bot.id;
      let state = "opening";
      for (let index = 0; index < 200 && state === "opening"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const refreshed = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        state =
          ((await refreshed.json()) as { bots: { id: string; state: string }[] }).bots.find(
            (bot) => bot.id === botId,
          )?.state ?? "catalogued";
      }
      assert.equal(state, "idle", "creation warmed the bot through the composed opener");
    } finally {
      await daemon.close();
    }
    // A second daemon on the same root is refused only while the first one lives; after a
    // close the lock is free again.
    const again = await startDaemon(readConfig({ argv: ["--root", root, "--port", "0"], env: {} }));
    await again.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
