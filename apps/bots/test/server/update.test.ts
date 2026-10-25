// Editing a bot's name, label and face over PATCH (docs/bots/PROTOCOL.md, "HTTP
// endpoints"): each field is optional, a label of "" clears it, and an unknown field or a
// face outside the closed sets is a 400.
import assert from "node:assert/strict";
import test from "node:test";
import type { BotSummary } from "../../src/core/domain.ts";
import { startStack } from "../support/server.ts";

test("name, label and face are editable over PATCH", async () => {
  const stack = await startStack();
  const call = async (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${stack.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const created = await call("POST", "/v1/bots", {
      title: "旧名",
      label: "旧标签",
      appearance: { shape: "blob", tint: "green" },
    });
    assert.equal(created.status, 201);
    const bot = ((await created.json()) as { bot: BotSummary }).bot;

    const relabelled = await call("PATCH", `/v1/bots/${bot.id}`, { label: "研究" });
    assert.equal(relabelled.status, 200);
    const one = ((await relabelled.json()) as { bot: BotSummary }).bot;
    assert.equal(one.label, "研究");
    assert.equal(one.title, "旧名", "an omitted field is left alone");

    const faced = await call("PATCH", `/v1/bots/${bot.id}`, {
      appearance: { shape: "star", tint: "pink" },
    });
    const two = ((await faced.json()) as { bot: BotSummary }).bot;
    assert.deepEqual(two.appearance, { shape: "star", tint: "pink" });

    const renamed = await call("PATCH", `/v1/bots/${bot.id}`, { title: "新名" });
    const three = ((await renamed.json()) as { bot: BotSummary }).bot;
    assert.equal(three.title, "新名");

    const cleared = await call("PATCH", `/v1/bots/${bot.id}`, { label: "" });
    const four = ((await cleared.json()) as { bot: BotSummary }).bot;
    assert.equal(four.label, undefined);

    for (const body of [
      {},
      { title: "  " },
      { label: "x".repeat(25) },
      { appearance: { shape: "triangle", tint: "green" } },
      { appearance: { shape: "blob", tint: "neon" } },
      { colour: "red" },
    ]) {
      assert.equal(
        (await call("PATCH", `/v1/bots/${bot.id}`, body)).status,
        400,
        JSON.stringify(body),
      );
    }
    assert.equal(stack.registry.summaries()[0]?.label, undefined);
  } finally {
    await stack.close();
  }
});
