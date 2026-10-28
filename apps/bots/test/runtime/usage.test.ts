// Usage per bot (docs/bots/PROTOCOL.md, "usage"): the inspector's 用量 section reads the same
// numbers the daemon already keeps for every answered turn.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, requestId, trace, waitFor } from "../support/pi.ts";

test("an answered turn publishes the conversation's usage", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([assistant("完成")]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    const subscription = await handle.subscribe(trace, (event) => events.push(event));
    assert.equal(subscription.snapshot.usage, undefined, "nothing is spent before the first turn");

    await handle.submit({ requestId, text: "你好", whenBusy: "followUp", trace });
    await waitFor(
      () => events.some((event) => event.type === "usage" && event.usage.totalTokens > 0),
      "a usage event",
    );
    const usage = events
      .filter((event): event is Extract<RuntimeEvent, { type: "usage" }> => event.type === "usage")
      .at(-1)?.usage;
    assert.ok(usage !== undefined);
    assert.ok(usage.inputTokens > 0, "the prompt is counted");
    assert.ok(usage.outputTokens > 0, "and the answer");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
