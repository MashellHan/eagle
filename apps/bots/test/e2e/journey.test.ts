// Ladder rows 49-51: a real socket, a real catalog, the real pi-durable adapter over real
// sqlite, and only the model network faked (docs/bots/TESTING.md, "What may be faked").
// The journey is the product's acceptance test.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

type Frame = Record<string, unknown>;

/** Reads until the wanted frame arrives, so unrelated frames cannot reorder the assertion. */
const nextOfType = async (frames: ReturnType<typeof frameQueue>, type: string): Promise<Frame> => {
  for (;;) {
    const frame = await frames.next(10_000);
    if (frame.type === type) return frame;
  }
};

/** Sends one turn and waits for that request's settlement, never for a neighbour's. */
const turn = async (
  frames: ReturnType<typeof frameQueue>,
  socket: Parameters<typeof send>[0],
  requestId: string,
  body: string,
  name: string,
): Promise<void> => {
  await send(socket, {
    type: "send",
    requestId,
    text: body,
    whenBusy: "followUp",
    trace: tr(name),
  });
  for (;;) {
    const frame = await frames.next(10_000);
    if (frame.type === "submission" && frame.requestId === requestId) {
      if (frame.status === "done" || frame.status === "unanswered") return;
    }
  }
};

test("create, chat three turns, reconnect and delete", async () => {
  const stack = await startStack({ real: true });
  try {
    const faux = stack.faux;
    assert.ok(faux !== undefined, "a real stack scripts the model network");
    faux.setResponses([text("第一回答"), text("第二回答"), text("第三回答")]);
    const botId = await stack.createBot("旅程");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("sub1") });
    const baseline = await frames.next();
    assert.equal(baseline.type, "snapshot");
    assert.deepEqual((baseline.value as { messages: Message[] }).messages, []);

    for (const index of [1, 2, 3]) {
      await turn(frames, socket, `r_journey_${index}`, `第 ${index} 个问题`, `send${index}`);
    }

    // Reconnect: a fresh socket sees the whole transcript in its first snapshot.
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("sub2") });
    const snapshot = await renewed.next();
    const messages = (snapshot.value as { messages: Message[] }).messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
      "reconnect restores every turn without a replay",
    );
    assert.deepEqual(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => {
          const block = message.blocks[0];
          return block?.type === "text" ? block.text : undefined;
        }),
      ["第一回答", "第二回答", "第三回答"],
      "the answers are the model's, not a script of the transport",
    );
    assert.equal(
      messages.filter((message) => message.state === "streaming").length,
      0,
      "nothing is left streaming",
    );
    assert.equal(typeof snapshot.rev, "number");
    again.close();
    socket.close();

    const removed = await fetch(`http://127.0.0.1:${stack.port}/v1/bots/${botId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${stack.token}` },
    });
    assert.equal(removed.status, 204);
    assert.deepEqual(stack.registry.summaries(), []);
  } finally {
    await stack.close();
  }
});

test("resync and history answer on the connection", async () => {
  const stack = await startStack({ real: true });
  try {
    stack.faux?.setResponses([text("一个回答")]);
    const botId = await stack.createBot("分页");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("sub3") });
    await frames.next();
    await turn(frames, socket, "r_page_0001", "一个问题", "page1");

    await send(socket, { type: "resync", trace: tr("resync") });
    const resynced = await nextOfType(frames, "snapshot");
    const resyncedMessages = (resynced.value as { messages: Message[] }).messages;
    assert.equal(resyncedMessages.length, 2);
    const answerId = resyncedMessages.at(-1)?.id as string;

    await send(socket, { type: "history", before: answerId, limit: 10, trace: tr("hist") });
    const history = await nextOfType(frames, "history");
    assert.deepEqual(
      (history.messages as Message[]).map((message) => message.role),
      ["user"],
      "the cursor message is not re-served",
    );
    assert.equal(history.hasMore, false);
    socket.close();

    // The daemon keeps the bot after the socket leaves; a second client can still read it.
    const later = stack.connect();
    const after = frameQueue(later);
    await send(later, hello);
    await after.next();
    await send(later, { type: "subscribe", botId, trace: tr("later") });
    assert.equal(
      ((await after.next()).value as { messages: Message[] }).messages.length,
      2,
      "the transcript outlives the connection",
    );
    later.close();
  } finally {
    await stack.close();
  }
});
