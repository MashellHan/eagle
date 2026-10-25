// Ladder row 52g: an over-limit attempt is withdrawn through a snapshot, the notice takes
// the withheld entry's id after the commit, and nothing above the transport cap is ever
// presented as the answer (docs/bots/PROTOCOL.md, "Message").
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { OVERSIZED_NOTICE } from "../../src/runtime/pi/limits.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;
const MAX_FRAME_BYTES = 256 * 1024;

test("an over-limit answer is withheld, announced after commit and stable on reconnect", async () => {
  const stack = await startStack({ real: true, maxMessageBytes: 400, tokensPerSecond: 50 });
  try {
    const long = "很长的回答。".repeat(120);
    stack.faux?.setResponses([text(long)]);
    const botId = await stack.createBot("超限");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("over1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_over_00001",
      text: "请长一点",
      whenBusy: "followUp",
      trace: tr("over2"),
    });

    let withdrawn = false;
    let settled: Record<string, unknown> | undefined;
    const seen: Record<string, unknown>[] = [];
    for (;;) {
      const frame = await frames.next(15_000);
      seen.push(frame);
      assert.ok(
        Buffer.byteLength(JSON.stringify(frame)) < MAX_FRAME_BYTES,
        "no frame goes over the transport cap",
      );
      const value = frame.value as { running?: boolean; streaming?: unknown } | undefined;
      if (frame.type === "snapshot" && value?.running === true && value.streaming === null) {
        withdrawn = true;
      }
      if (frame.type === "submission" && frame.status === "done") {
        settled = frame;
        break;
      }
    }
    assert.equal(withdrawn, true, "the attempt was withdrawn before its entry existed");
    assert.equal(typeof settled?.answerEntryId, "string", "the submission still settles");

    // A late join sees the same rule: the withdrawn attempt is not in its snapshot.
    const during = stack.connect();
    const joinedEarly = frameQueue(during);
    await send(during, hello);
    await joinedEarly.next();
    await send(during, { type: "subscribe", botId, trace: tr("over5") });
    const early = await joinedEarly.next();
    const earlyValue = early.value as {
      messages: Message[];
      streaming: unknown;
      running: boolean;
    };
    assert.equal(Array.isArray(earlyValue.messages), true);
    assert.equal(
      earlyValue.messages.some((message) => JSON.stringify(message).includes(long)),
      false,
      "no oversized partial reaches a client that joins mid-attempt",
    );
    assert.ok(
      earlyValue.streaming === null || typeof earlyValue.streaming === "object",
      "the snapshot is one of the two documented states",
    );
    during.close();

    await send(socket, { type: "resync", trace: tr("over3") });
    let transcript: Message[] = [];
    for (;;) {
      const frame = await frames.next(15_000);
      if (frame.type !== "snapshot") continue;
      transcript = (frame.value as { messages: Message[] }).messages;
      break;
    }
    const notices = transcript.filter((message) => message.role === "notice");
    assert.equal(notices.length, 1, "one notice replaces the withheld answer");
    const notice = notices[0] as Message;
    assert.equal(notice.id, settled?.answerEntryId, "the notice takes the withheld entry id");
    assert.equal(notice.state, "complete");
    assert.equal(notice.blocks[0]?.type === "text" ? notice.blocks[0].text : "", OVERSIZED_NOTICE);
    assert.equal(
      transcript.some((message) => JSON.stringify(message).includes(long)),
      false,
      "the oversized content was never presented",
    );

    // A late join sees the same notice from its snapshot: same id, same text, no duplicate.
    const late = stack.connect();
    const joined = frameQueue(late);
    await send(late, hello);
    await joined.next();
    await send(late, { type: "subscribe", botId, trace: tr("over4") });
    const baseline = await joined.next();
    const lateTranscript = (baseline.value as { messages: Message[] }).messages;
    assert.deepEqual(
      lateTranscript.map((message) => [message.id, message.role]),
      transcript.map((message) => [message.id, message.role]),
      "the reconnect sees the same transcript, not a second variant",
    );
    assert.equal(
      (baseline.value as { streaming: unknown }).streaming,
      null,
      "nothing is left streaming",
    );
    late.close();
    socket.close();
  } finally {
    await stack.close();
  }
});
