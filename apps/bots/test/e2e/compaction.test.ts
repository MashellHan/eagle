// Context compaction, accepted once on a deliberately tiny window: the model context
// shrinks while the transcript keeps every message. A real 200k window would need hours of
// chat to cross its threshold, so the acceptance runs a 1 200-token model instead.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Message as ProviderMessage } from "@earendil-works/pi-ai";
import { assistant, createBench, textBlock, trace, waitFor } from "../support/pi.ts";

const WINDOW = 1_200;
const RESERVE = 400;
const KEEP_RECENT = 150;

/** Characters a request carried, so "the model context shrank" is measurable. */
const contextSizes: number[] = [];

const prompt = (turn: number): string =>
  `Turn ${turn}: ${"please summarise the state of the build ".repeat(12)}`;

const answer = (turn: number): string =>
  `${"The build is green and the scripts pass. ".repeat(18)}Turn ${turn} done.`;

const contextChars = (messages: readonly ProviderMessage[]): number =>
  messages.reduce((total, message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return total + content.length;
    if (Array.isArray(content)) {
      return (
        total +
        content.reduce((sum: number, block: unknown) => {
          const text = (block as { text?: unknown }).text;
          return sum + (typeof text === "string" ? text.length : 0);
        }, 0)
      );
    }
    return total;
  }, 0);

test("a small window compacts the model context and keeps every message", async () => {
  const bench = await createBench({
    provider: { models: [{ id: "faux-tiny", contextWindow: WINDOW, maxTokens: 200 }] },
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: RESERVE,
        keepRecentTokens: KEEP_RECENT,
        backgroundTokens: 0,
      },
    },
  });
  const dbPath = join(bench.dir, "b_runtime", "session.sqlite");
  try {
    // Every request records what the model was given, then answers.
    bench.faux.setResponses([]);
    let turn = 0;
    bench.faux.appendResponses(
      Array.from({ length: 40 }, () => (context: { messages: ProviderMessage[] }) => {
        contextSizes.push(contextChars(context.messages));
        turn += 1;
        return assistant([textBlock(answer(turn))]);
      }),
    );
    const handle = await bench.runtime.open(bench.spec());
    const records = [];
    for (let index = 1; index <= 5; index += 1) {
      const record = await handle.submit({
        requestId: `r_compact_${index}`,
        text: prompt(index),
        whenBusy: "followUp",
        trace,
      });
      await waitFor(async () => {
        const status = (await handle.submission({ requestId: record.requestId }))?.status;
        return status === "done" || status === "unanswered";
      }, `turn ${index} to settle`);
      const settled = await handle.submission({ requestId: record.requestId });
      records.push(settled);
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const kinds = db
      .prepare("select record from entries")
      .all()
      .map(
        (row) => (JSON.parse(String((row as { record: string }).record)) as { kind?: string }).kind,
      );
    db.close();
    const compactions = kinds.filter((kind) => kind === "pi.compaction").length;
    const rawMessages = kinds.filter(
      (kind) => kind === "pi.user" || kind === "pi.assistant",
    ).length;

    assert.deepEqual(
      records.map((record) => record?.status),
      ["done", "done", "done", "done", "done"],
      `every turn answered (${records.map((record) => record?.reason ?? "").join(",")})`,
    );
    assert.ok(compactions >= 1, `a compaction was committed (kinds: ${kinds.join(",")})`);
    assert.equal(rawMessages, 10, "every turn is still stored: 5 user + 5 assistant entries");

    // The transcript the daemon serves keeps the whole conversation.
    const history = await handle.history({ limit: 200 });
    assert.equal(
      history.messages.filter((message) => message.role === "user").length,
      5,
      "all five questions are still readable through history",
    );

    // The model context did not grow without bound: the last request carried fewer
    // characters than the sum of every message stored.
    const last = contextSizes.at(-1) ?? 0;
    const everything = contextSizes.reduce((best, size) => Math.max(best, size), 0);
    assert.ok(
      last < everything,
      `the context shrank after compaction (last ${last} chars, peak ${everything})`,
    );
    assert.ok(last < WINDOW * 4, `the last request stayed near the window (${last} chars)`);
  } finally {
    await bench.cleanup();
  }
});
