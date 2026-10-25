// Ladder row 52c: history pages older messages and the newest window is never re-fetched
// (docs/bots/PROTOCOL.md, "Client commands" — `history`).
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("history pages older messages and the newest window is never re-fetched", async () => {
  const stack = await startStack({ real: true, windowMessages: 4 });
  try {
    stack.faux?.setResponses(Array.from({ length: 6 }, (_, index) => text(`回答 ${index + 1}`)));
    const botId = await stack.createBot("分页旅程");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("page1") });
    await frames.next();
    for (const index of [1, 2, 3, 4, 5, 6]) {
      await send(socket, {
        type: "send",
        requestId: `r_pages_0000${index}`,
        text: `问题 ${index}`,
        whenBusy: "followUp",
        trace: tr(`page0${index}`),
      });
      for (;;) {
        const frame = await frames.next(10_000);
        if (frame.type === "submission" && frame.status === "done") break;
      }
    }

    // A reconnect renders the newest window only, with a cursor for what is older.
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("page2") });
    const baseline = await renewed.next();
    const window = baseline.value as {
      messages: Message[];
      truncatedBefore?: string;
    };
    assert.equal(window.messages.length, 4, "the window holds the configured page");
    assert.equal(typeof window.truncatedBefore, "string", "older messages are announced");
    const newestIds = window.messages.map((message) => message.id);

    const paged: Message[] = [];
    // The page cursor is the oldest message the client holds, not the truncation marker.
    let cursor = newestIds[0] as string;
    for (;;) {
      await send(again, {
        type: "history",
        before: cursor,
        limit: 4,
        trace: tr(`hist${paged.length}`),
      });
      const page = await (async () => {
        for (;;) {
          const frame = await renewed.next(10_000);
          if (frame.type === "history") return frame;
        }
      })();
      const messages = page.messages as Message[];
      assert.equal(
        messages.some((message) => newestIds.includes(message.id)),
        false,
        "the newest window is never re-fetched",
      );
      paged.unshift(...messages);
      if (page.hasMore !== true) break;
      const oldest = messages[0]?.id;
      assert.equal(typeof oldest, "string");
      cursor = oldest as string;
    }

    const all = [...paged, ...window.messages];
    assert.equal(all.length, 12, "every turn is reachable exactly once");
    assert.equal(
      all.filter((message) => message.role === "user").length,
      6,
      "every question is reachable once",
    );
    assert.equal(
      all.filter((message) => message.role === "assistant").length,
      6,
      "every answer is reachable once",
    );
    const numbers = all.map((message) => Number(message.id.replace(/^e_/, "")));
    assert.deepEqual(
      numbers,
      [...numbers].sort((left, right) => left - right),
      "entry order is preserved across the page boundary",
    );
    assert.equal(new Set(all.map((message) => message.id)).size, all.length, "no repeats");
    assert.deepEqual(
      all
        .filter((message) => message.role === "user")
        .map((message) => message.requestId)
        .sort(),
      [
        "r_pages_00001",
        "r_pages_00002",
        "r_pages_00003",
        "r_pages_00004",
        "r_pages_00005",
        "r_pages_00006",
      ],
      "every user message still names the send that produced it, paged ones included",
    );
    again.close();
    socket.close();
  } finally {
    await stack.close();
  }
});
