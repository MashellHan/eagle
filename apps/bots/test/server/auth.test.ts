// Ladder row 37: the bearer token gates HTTP and the upgrade, and a refusal never reaches
// core or the runtime.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadToken } from "../../src/server/auth.ts";
import { hello, nextFrame, send, startStack } from "../support/server.ts";

test("rejects a wrong bearer token before upgrade", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("鉴权");
    const before = stack.records.length;
    while (stack.opens() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const opensBefore = stack.opens();
    const attempt = stack.connect({ token: "wrong-token-0123456789-abcdefghijkl" });
    const code = await new Promise<number>((resolve) => {
      attempt.once("error", () => resolve(-1));
      attempt.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
    });
    assert.equal(code, 401, "the upgrade is refused with 401");
    assert.deepEqual(
      stack.records
        .slice(before)
        .filter(
          (record) =>
            (record.layer === "core" || record.layer === "runtime") &&
            record.trace.startsWith("tr_http_"),
        ),
      [],
      "no core or runtime record for a refused connection",
    );
    assert.equal(stack.opens(), opensBefore, "a refused connection opens nothing");

    const response = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      headers: { authorization: "Bearer wrong-token-0123456789-abcdefghijkl" },
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: { kind?: string } };
    assert.equal(body.error?.kind, "auth_failed", "a missing token is an auth failure");

    const health = await fetch(`http://127.0.0.1:${stack.port}/v1/health`);
    assert.equal(health.status, 200, "health needs no token");

    const authorised = stack.connect();
    await send(authorised, hello);
    const welcome = await nextFrame(authorised);
    assert.equal(welcome.type, "welcome");
    assert.deepEqual(
      (welcome.bots as { id: string }[]).map((bot) => bot.id),
      [botId],
    );
    authorised.close();
  } finally {
    await stack.close();
  }
});

test("an existing token file is tightened to 0600 and reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-token-"));
  try {
    const path = join(root, "token");
    const issued = "existing-token-0123456789-abcdefghijklmnop";
    await writeFile(path, `${issued}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    const token = await loadToken(root);
    assert.equal(token, issued, "an existing token is never replaced");
    const stats = await stat(path);
    assert.equal(stats.mode & 0o777, 0o600, "the token file is readable by its owner only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two first starts converge on one token without overwriting each other", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-token-race-"));
  try {
    const [first, second] = await Promise.all([loadToken(root), loadToken(root)]);
    assert.equal(first, second, "the loser reads the winner's token");
    assert.equal((await readFile(join(root, "token"), "utf8")).trim(), first);
    assert.equal((await stat(join(root, "token"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
