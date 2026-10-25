// Ladder rows 49-51: a real socket, a real catalog and the service, with only the model
// behind the runtime faked. The journey is the product's acceptance test.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import type { FakeScript } from "../../src/testing/FakeRuntime.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

let counter = 0;

/** One scripted turn: the user entry, its placement, the answer and the settlement. */
const script: FakeScript = {
  onSubmit: (input) => {
    counter += 1;
    const entry = `e_${counter * 2}`;
    const answer = `e_${counter * 2 + 1}`;
    const user: Message = {
      id: entry,
      role: "user",
      state: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [{ type: "text", text: input.text }],
      requestId: input.requestId,
    };
    const reply: Message = {
      id: answer,
      role: "assistant",
      state: "complete",
      createdAt: "2026-01-01T00:00:01.000Z",
      blocks: [{ type: "text", text: `回答 ${input.text}` }],
      stopReason: "stop",
    };
    return [
      { type: "append", trace: input.trace, message: user },
      {
        type: "submission",
        trace: input.trace,
        record: {
          id: `s_${counter}`,
          requestId: input.requestId,
          status: "placed",
          entryId: entry,
        },
      },
      { type: "append", trace: input.trace, message: reply },
      {
        type: "submission",
        trace: input.trace,
        record: {
          id: `s_${counter}`,
          requestId: input.requestId,
          status: "done",
          entryId: entry,
          answerEntryId: answer,
        },
      },
      { type: "status", trace: input.trace, running: false, streaming: null, inbox: [] },
    ];
  },
};

const tr = (name: string) => `tr_${name}_0123456`;

/** Reads until the wanted frame arrives, so unrelated frames cannot reorder the assertion. */
const nextOfType = async (
  frames: ReturnType<typeof frameQueue>,
  type: string,
): Promise<Record<string, unknown>> => {
  for (;;) {
    const frame = await frames.next();
    if (frame.type === type) return frame;
  }
};

test("create, chat three turns, reconnect and delete", async () => {
  const stack = await startStack({ script });
  try {
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
      const requestId = `r_journey_${index}`;
      await send(socket, {
        type: "send",
        requestId,
        text: `第 ${index} 个问题`,
        whenBusy: "followUp",
        trace: tr(`send${index}`),
      });
      const seen: string[] = [];
      for (;;) {
        const frame = await frames.next();
        seen.push(String(frame.type));
        if (frame.type === "status" && frame.running === false && seen.includes("append")) {
          break;
        }
      }
      assert.ok(seen.includes("append"), "the transcript grew");
      assert.ok(seen.includes("submission"), "the record reached the client");
    }

    // Reconnect: a fresh socket sees the whole transcript in its first snapshot.
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("sub2") });
    const snapshot = await renewed.next();
    assert.deepEqual(
      (snapshot.value as { messages: Message[] }).messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
      "reconnect restores every turn without a replay",
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
  const stack = await startStack({ script });
  try {
    const botId = await stack.createBot("分页");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("sub3") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_page_0001",
      text: "一个问题",
      whenBusy: "followUp",
      trace: tr("page1"),
    });
    for (;;) {
      const frame = await frames.next();
      if (frame.type === "status" && frame.running === false) break;
    }
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
  } finally {
    await stack.close();
  }
});
