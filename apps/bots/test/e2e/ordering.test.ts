// Ladder row 52d: a settlement is never undone. The daemon answers a duplicate `send` with
// the stored record, and the fold ignores a ranked-lower duplicate, so a late
// connection-scoped reply cannot move a client back to `queued`
// (docs/bots/PROTOCOL.md, submission semantics and I14).
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("a duplicate send replies with the settled record, never a lower one", async () => {
  const stack = await startStack({ real: true });
  try {
    stack.faux?.setResponses([text("已经完成的回答")]);
    const botId = await stack.createBot("排序");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("order1") });
    await frames.next();

    const requestId = "r_order_0001";
    await send(socket, {
      type: "send",
      requestId,
      text: "一次提问",
      whenBusy: "followUp",
      trace: tr("order2"),
    });
    let settlement: Record<string, unknown> | undefined;
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "submission" && frame.status === "done") {
        settlement = frame;
        break;
      }
    }
    assert.equal(settlement.requestId, requestId);
    const answerEntryId = settlement.answerEntryId;
    assert.equal(typeof answerEntryId, "string");

    // The retry is connection-scoped and carries no revision, but it must answer with the
    // same terminal record: a client that missed the broadcast learns the settlement here.
    await send(socket, {
      type: "send",
      requestId,
      text: "一次提问",
      whenBusy: "followUp",
      trace: tr("order3"),
    });
    const duplicate = await frames.next(10_000);
    assert.equal(duplicate.type, "submission");
    assert.equal(duplicate.rev, undefined, "a reply is connection-scoped (PROTOCOL I11)");
    assert.equal(duplicate.status, "done", "a retry never reports a lower rank");
    assert.equal(duplicate.answerEntryId, answerEntryId, "and it names the same answer");

    // The transcript is untouched by the retry.
    await send(socket, { type: "resync", trace: tr("order4") });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const messages = (frame.value as { messages: Message[] }).messages;
      assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant"],
        "the duplicate reply added no entry",
      );
      break;
    }
    socket.close();
  } finally {
    await stack.close();
  }
});
