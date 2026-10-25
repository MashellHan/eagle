// Ladder row 37: the bearer token gates HTTP and the upgrade, and a refusal never reaches
// core or the runtime.
import assert from "node:assert/strict";
import test from "node:test";
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
