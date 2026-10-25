// Ladder rows 49-51: a real socket, a real catalog, the real pi-durable adapter over real
// sqlite, and only the model network faked (docs/bots/TESTING.md, "What may be faked").
// The journey is the product's acceptance test.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { text } from "../support/pi.ts";
import { closeCode, frameQueue, hello, send, startStack } from "../support/server.ts";

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

test("two bots stream independently with separate revisions", async () => {
  const stack = await startStack({ real: true });
  try {
    stack.faux?.setResponses([text("甲的回答"), text("乙的回答")]);
    const first = await stack.createBot("甲");
    const second = await stack.createBot("乙");
    const a = stack.connect();
    const b = stack.connect();
    const framesA = frameQueue(a);
    const framesB = frameQueue(b);
    for (const [socket, frames, botId, name] of [
      [a, framesA, first, "a"],
      [b, framesB, second, "b"],
    ] as const) {
      await send(socket, hello);
      await frames.next();
      await send(socket, { type: "subscribe", botId, trace: tr(`sub${name}`) });
      const baseline = await frames.next();
      assert.equal(baseline.type, "snapshot");
      assert.equal(baseline.rev, 1, "each bot numbers its own stream from one");
    }
    await turn(framesA, a, "r_two_a00001", "问甲", "twoA");
    await turn(framesB, b, "r_two_b00001", "问乙", "twoB");

    // A third turn on the first bot alone must not move the second bot's revisions.
    stack.faux?.setResponses([text("再答一次")]);
    const beforeB = stack.records.filter((record) => record.botId === second).length;
    await turn(framesA, a, "r_two_a00002", "再问甲", "twoA2");
    assert.equal(
      stack.records.filter((record) => record.botId === second).length,
      beforeB,
      "the idle bot records nothing while the other streams",
    );

    await send(b, { type: "resync", trace: tr("twoB2") });
    const resynced = await nextOfType(framesB, "snapshot");
    const messages = (resynced.value as { messages: Message[] }).messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
      "each transcript holds only its own bot's turns",
    );
    assert.equal(
      messages.some((message) => JSON.stringify(message).includes("甲")),
      false,
      "nothing crossed between the two bots",
    );
    a.close();
    b.close();
  } finally {
    await stack.close();
  }
});

test("a lost submission reply is recovered by re-sending the requestId", async () => {
  const stack = await startStack({ real: true });
  try {
    stack.faux?.setResponses([text("只应出现一次的回答")]);
    const botId = await stack.createBot("重发");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("lost1") });
    await frames.next();
    await turn(frames, socket, "r_lost_00001", "丢回复的问题", "lost2");
    socket.close();
    await closeCode(socket).catch(() => undefined);

    // The client never saw the reply; it re-sends the same requestId after reconnecting.
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("lost3") });
    await renewed.next();
    await send(again, {
      type: "send",
      requestId: "r_lost_00001",
      text: "丢回复的问题",
      whenBusy: "followUp",
      trace: tr("lost4"),
    });
    const reply = await nextOfType(renewed, "submission");
    assert.equal(reply.requestId, "r_lost_00001");
    assert.equal(reply.status, "done", "the stored record answers the retry");
    assert.equal(typeof reply.answerEntryId, "string");

    await send(again, { type: "resync", trace: tr("lost5") });
    const snapshot = await nextOfType(renewed, "snapshot");
    const messages = (snapshot.value as { messages: Message[] }).messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
      "a repeated requestId never duplicates work (PROTOCOL I4)",
    );
    assert.equal(
      messages.filter((message) => message.requestId === "r_lost_00001").length,
      1,
      "exactly one user entry carries that requestId",
    );
    again.close();
  } finally {
    await stack.close();
  }
});

test("a bot joining mid-answer receives the partial in the snapshot", async () => {
  const stack = await startStack({ real: true, tokensPerSecond: 10 });
  try {
    stack.faux?.setResponses([text(`开头。${"后面还有很多很多内容。".repeat(8)}`)]);
    const botId = await stack.createBot("中途");
    const first = stack.connect();
    const frames = frameQueue(first);
    await send(first, hello);
    await frames.next();
    await send(first, { type: "subscribe", botId, trace: tr("mid1") });
    await frames.next();
    await send(first, {
      type: "send",
      requestId: "r_mid_000001",
      text: "讲故事",
      whenBusy: "followUp",
      trace: tr("mid2"),
    });
    // Wait until the answer is visibly streaming, then join with a second connection.
    for (;;) {
      const frame = await frames.next(10_000);
      const streamed =
        frame.type === "delta"
          ? (frame.changes as { kind: string; append?: string }[]).some(
              (change) => change.kind === "text" && (change.append ?? "").length > 0,
            )
          : frame.type === "append" && (frame.message as Message).role === "assistant"
            ? ((frame.message as Message).blocks as { type: string; text?: string }[]).some(
                (block) => block.type === "text" && (block.text ?? "").length > 0,
              )
            : false;
      if (streamed) break;
    }
    const join = stack.connect();
    const joined = frameQueue(join);
    await send(join, hello);
    await joined.next();
    await send(join, { type: "subscribe", botId, trace: tr("mid3") });
    const baseline = await joined.next();
    assert.equal(baseline.type, "snapshot");
    const value = baseline.value as {
      streaming: { messageId: string } | null;
      messages: Message[];
      running: boolean;
    };
    assert.equal(value.running, true, "the run is still going");
    assert.ok(value.streaming !== null, "the snapshot names the attempt in flight");
    const partial = value.messages.find((message) => message.id === value.streaming?.messageId);
    assert.ok(partial, "the streaming message is already inside the snapshot window");
    assert.equal(partial.state, "streaming");
    const block = partial.blocks[0];
    assert.ok(block?.type === "text", "the block is already content");
    assert.ok(block.text.length > 0, "no earlier frame is needed to render it");

    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "submission" && frame.status === "done") break;
    }
    join.close();
    first.close();
  } finally {
    await stack.close();
  }
});
