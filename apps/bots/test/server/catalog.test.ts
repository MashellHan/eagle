// Ladder row 41: create, rename and delete over HTTP keep the catalog absolute, and every
// change reaches a connected client as one `bots` event.
import assert from "node:assert/strict";
import test from "node:test";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const api = (stack: { port: number; token: string }) => {
  const headers = { authorization: `Bearer ${stack.token}`, "content-type": "application/json" };
  return {
    list: () => fetch(`http://127.0.0.1:${stack.port}/v1/bots`, { headers }),
    create: (title: string) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
      }),
    rename: (id: string, title: string) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ title }),
      }),
    remove: (id: string) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots/${id}`, { method: "DELETE", headers }),
  };
};

test("create, rename and delete keep the catalog absolute", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();

    const created = await client.create("研究员");
    assert.equal(created.status, 201);
    const body = (await created.json()) as { bot: { id: string; title: string; state: string } };
    assert.equal(body.bot.title, "研究员");
    assert.match(body.bot.id, /^b_[A-Za-z0-9_-]{1,64}$/);
    const announced = await frames.next();
    assert.equal(announced.type, "bots", "the catalog reaches the client as one event");
    assert.deepEqual(
      (announced.bots as { id: string }[]).map((bot) => bot.id),
      [body.bot.id],
      "and it is absolute, not a delta",
    );

    const renamed = await client.rename(body.bot.id, "助理");
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { bot: { title: string } }).bot.title, "助理");
    assert.deepEqual(
      ((await frames.next()).bots as { title: string }[]).map((bot) => bot.title),
      ["助理"],
    );

    const listed = await client.list();
    const listedBody = (await listed.json()) as { bots: { title: string }[] };
    assert.deepEqual(
      listedBody.bots.map((bot) => bot.title),
      ["助理"],
      "the catalog is the authority",
    );

    const deleted = await client.remove(body.bot.id);
    assert.equal(deleted.status, 204);
    assert.deepEqual((await frames.next()).bots, []);
    assert.deepEqual(((await (await client.list()).json()) as { bots: unknown[] }).bots, []);
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a title over the limit and an unknown bot are refused", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const long = await client.create("x".repeat(81));
    assert.equal(long.status, 400);
    assert.equal(
      ((await long.json()) as { error: { kind: string } }).error.kind,
      "invalid_command",
    );
    assert.equal((await client.rename("b_missing", "ok")).status, 404);
  } finally {
    await stack.close();
  }
});

test("an unknown endpoint and an oversized body are refused", async () => {
  const stack = await startStack();
  try {
    const headers = { authorization: `Bearer ${stack.token}`, "content-type": "application/json" };
    const missing = await fetch(`http://127.0.0.1:${stack.port}/v1/unknown`, { headers });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { kind: string } }).error.kind, "unknown_bot");
    const huge = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "x".repeat(9_000) }),
    });
    assert.equal(huge.status, 500, "a body over the cap is refused");
  } finally {
    await stack.close();
  }
});
