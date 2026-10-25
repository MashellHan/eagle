// Ladder rows 38-40: the handshake, refusal close codes and the one-subscription rule.
import assert from "node:assert/strict";
import test from "node:test";
import { closeCode, frameQueue, hello, nextFrame, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("closes 1008 when hello is not the first frame", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    await send(socket, { type: "subscribe", botId: "b_x", trace: tr("first") });
    assert.equal(await closeCode(socket), 1008);
  } finally {
    await stack.close();
  }
});

test("a version the daemon does not speak answers then closes 4009", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    await send(socket, { type: "hello", protocolVersion: 99, client: "BotsTest/0" });
    const frame = await nextFrame(socket);
    assert.equal(frame.type, "error");
    assert.equal(frame.kind, "version_mismatch");
    assert.equal((frame.server as { protocolVersion: number }).protocolVersion, 1);
    assert.equal(await closeCode(socket), 4009);
  } finally {
    await stack.close();
  }
});

test("closes 4004 for an unknown bot and 4090 while quarantined", async () => {
  const stack = await startStack();
  try {
    const unknown = stack.connect();
    await send(unknown, hello);
    await nextFrame(unknown);
    await send(unknown, { type: "subscribe", botId: "b_does_not_exist", trace: tr("unknown") });
    assert.equal(await closeCode(unknown), 4004);

    const botId = await stack.createBot("隔离");
    stack.quarantine(botId);
    const quarantined = stack.connect();
    await send(quarantined, hello);
    await nextFrame(quarantined);
    await send(quarantined, { type: "subscribe", botId, trace: tr("quarantine") });
    assert.equal(await closeCode(quarantined), 4090);
  } finally {
    await stack.close();
  }
});

test("a second subscribe on one connection closes 1008", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("重复订阅");
    const socket = stack.connect();
    await send(socket, hello);
    await nextFrame(socket);
    await send(socket, { type: "subscribe", botId, trace: tr("once") });
    const snapshot = await nextFrame(socket);
    assert.equal(snapshot.type, "snapshot");
    await send(socket, { type: "subscribe", botId, trace: tr("twice") });
    assert.equal(await closeCode(socket), 1008);
  } finally {
    await stack.close();
  }
});

test("an unknown command is refused and the connection kept", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    await send(socket, hello);
    await nextFrame(socket);
    await send(socket, { type: "nonsense", trace: tr("unknown") });
    const frame = await nextFrame(socket);
    assert.equal(frame.type, "error");
    assert.equal(frame.kind, "invalid_command");
    assert.equal(frame.disposition, "not_admitted");
    await send(socket, { type: "ping" });
    assert.equal((await nextFrame(socket)).type, "pong", "the connection still works");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("malformed JSON closes 1008 with a protocol record only", async () => {
  const stack = await startStack();
  try {
    const before = stack.records.length;
    const socket = stack.connect();
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send("{not json");
    assert.equal(await closeCode(socket), 1008);
    const records = stack.records.slice(before);
    assert.deepEqual(
      records.filter((record) => record.layer === "core" || record.layer === "runtime"),
      [],
      "no core or runtime record for a malformed frame",
    );
    assert.ok(
      records.some(
        (record) => record.evt === "protocol.decode.fail" && record.err?.origin === true,
      ),
      "the protocol layer owns the record",
    );
  } finally {
    await stack.close();
  }
});

test("a delta, a status and a runtime error each reach the wire", async () => {
  const stack = await startStack({
    script: {
      onSubmit: (input) => [
        {
          type: "delta",
          trace: input.trace,
          messageId: "p_a1",
          changes: [{ kind: "text", index: 0, append: "半" }],
        },
        { type: "status", trace: input.trace, running: true, streaming: "p_a1", inbox: [] },
        {
          type: "error",
          trace: input.trace,
          failure: { id: "f_wire_1", kind: "task_parked", layer: "runtime" },
          message: "a task was parked",
        },
        { type: "status", trace: input.trace, running: false, streaming: null, inbox: [] },
      ],
    },
  });
  try {
    const botId = await stack.createBot("帧");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("frames") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_frames_01",
      text: "问题",
      whenBusy: "followUp",
      trace: tr("frames2"),
    });
    const seen = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < 6; index += 1) {
      const frame = await frames.next();
      seen.set(String(frame.type), frame);
      if (frame.type === "error") break;
    }
    assert.ok(seen.has("delta"), "a delta reaches the wire");
    const changes = (seen.get("delta")?.changes ?? []) as { append: string }[];
    assert.equal(changes[0]?.append, "半");
    assert.ok(seen.has("status"), "a status reaches the wire");
    assert.equal(seen.get("error")?.kind, "task_parked");
    assert.equal(seen.get("error")?.failure, "f_wire_1");
    assert.equal(seen.get("error")?.disposition, "runtime");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("the seventeenth connection is refused with 503", async () => {
  const stack = await startStack();
  try {
    const sockets = [];
    for (let index = 0; index < 16; index += 1) {
      const socket = stack.connect();
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      sockets.push(socket);
    }
    const refused = stack.connect();
    const status = await new Promise<number>((resolve) => {
      refused.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      refused.once("error", () => resolve(-1));
    });
    assert.equal(status, 503, "the connection cap sits in front of the upgrade");
    for (const socket of sockets) socket.close();
  } finally {
    await stack.close();
  }
});

test("a command before the subscription is refused with a keep-alive error", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_early_001",
      text: "还没有订阅",
      whenBusy: "followUp",
      trace: tr("early"),
    });
    const frame = await frames.next();
    assert.equal(frame.type, "error");
    assert.equal(frame.kind, "invalid_command");
    assert.equal(frame.disposition, "not_admitted");
    assert.equal(frame.requestId, "r_early_001", "the client can restore its draft");
    socket.close();
  } finally {
    await stack.close();
  }
});
