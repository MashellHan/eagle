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

test("a title the catalog budget cannot hold is refused before it is stored", async () => {
  const stack = await startStack({ model: { provider: "faux", modelId: `m${"x".repeat(1_400)}` } });
  try {
    const client = api(stack);
    const refused = await client.create("太长");
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: { kind: string } }).error.kind,
      "limit_exceeded",
    );
    assert.deepEqual(stack.registry.summaries(), [], "nothing was written");
  } finally {
    await stack.close();
  }
});

test("every catalog broadcast is a measured frame", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const before = stack.records.length;
    await client.create("度量");
    assert.equal((await frames.next()).type, "bots");
    const sent = stack.records
      .slice(before)
      .filter(
        (record) => record.evt === "transport.frame.send.ok" && record.detail?.evt === "bots",
      );
    assert.equal(sent.length, 1, "the broadcast goes through the frame writer");
    assert.ok(Number(sent[0]?.detail?.bytes) > 0, "and its size is recorded");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a catalog change before hello waits for the handshake", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    // No hello yet: the daemon-side change must not produce a frame.
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    await api(stack).create("先建后握手");
    await send(socket, hello);
    const first = await frames.next();
    assert.equal(first.type, "welcome", "nothing precedes the welcome");
    assert.deepEqual(
      (first.bots as { title: string }[]).map((bot) => bot.title),
      ["先建后握手"],
      "and the welcome already carries the change",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("the catalog follows the run state and pushes it to clients", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const created = await api(stack).create("跟随");
    const botId = ((await created.json()) as { bot: { id: string } }).bot.id;
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_follow_0001" });
    await frames.next();
    const handle = stack.fake?.handle(botId);
    assert.ok(handle !== undefined);
    handle.emit({
      type: "status",
      trace: "tr_follow_0002",
      running: true,
      streaming: null,
      inbox: [],
    });
    const running = await (async () => {
      for (;;) {
        const frame = await frames.next();
        if (frame.type === "bots") return frame;
      }
    })();
    assert.equal(running.type, "bots");
    assert.equal(
      (running.bots as { state: string }[])[0]?.state,
      "running",
      "a run makes the bot running in the catalog",
    );
    handle.emit({
      type: "status",
      trace: "tr_follow_0003",
      running: false,
      streaming: null,
      inbox: [],
    });
    const idle = await (async () => {
      for (;;) {
        const frame = await frames.next();
        if (frame.type === "bots") return frame;
      }
    })();
    assert.equal(idle.type, "bots");
    assert.equal((idle.bots as { state: string }[])[0]?.state, "idle");
    socket.close();
  } finally {
    await stack.close();
  }
});
