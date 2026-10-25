// Ladder row 29: one requestId, one record (F7).
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { createBench, requestId, text, trace, waitFor } from "../support/pi.ts";

const of = <T extends RuntimeEvent["type"]>(events: readonly RuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

test("the same requestId returns one record and emits no new events", async () => {
  const bench = await createBench({
    provider: { tokensPerSecond: 30, tokenSize: { min: 2, max: 3 } },
  });
  try {
    bench.faux.setResponses([text("第一次的答案，慢一点，好让记录还在飞行中。")]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    const first = await handle.submit({
      requestId,
      text: "只发送一次的问题",
      whenBusy: "followUp",
      trace,
    });
    const inFlight = await handle.submission({ requestId });
    assert.deepEqual(
      inFlight === undefined ? undefined : [inFlight.id, inFlight.status],
      [first.id, "placed"],
      "a live submission is readable by request id",
    );
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the first turn to settle",
    );
    const settled = of(events, "submission").at(-1)?.record;
    assert.equal(settled?.status, "done");

    const before = events.length;
    const again = await handle.submit({
      requestId,
      text: "只发送一次的问题",
      whenBusy: "followUp",
      trace,
    });
    assert.deepEqual(again, settled, "a duplicate returns the stored record, not a new one");
    assert.deepEqual(
      events.slice(before),
      [],
      "F7: no new events, which is why the daemon answers per connection",
    );
    assert.deepEqual(
      await handle.submission({ requestId }),
      undefined,
      "it settled, so it left the ledger",
    );
    const byId = await handle.submission({ submissionId: settled?.id as string });
    assert.deepEqual(byId, settled);
    assert.equal(await handle.submission({ requestId: "r_unknown_1" }), undefined);

    const history = await handle.history({ limit: 10 });
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
      "one admission, one answer",
    );
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("a re-sent requestId converges after a restart", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([text("重启之前的答案。")]);
    const first = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await first.subscribe(trace, (event) => events.push(event));
    await first.submit({ requestId, text: "重启之前的问题", whenBusy: "followUp", trace });
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the first turn to settle",
    );
    const settled = of(events, "submission").at(-1)?.record;
    assert.equal(await first.close(trace, 10_000), "closed");

    // The ledger is not persisted; pi dedupes by requestId in storage (F7).
    bench.faux.setResponses([text("不应该出现的第二个答案。")]);
    const reopened = await bench.runtime.open(bench.spec("tr_runtime_2"));
    const after: RuntimeEvent[] = [];
    await reopened.subscribe("tr_runtime_2", (event) => after.push(event));
    const record = await reopened.submit({
      requestId,
      text: "重启之前的问题",
      whenBusy: "followUp",
      trace: "tr_runtime_2",
    });
    assert.equal(record.id, settled?.id, "the same submission id comes back");
    assert.equal(record.status, "done");
    assert.equal(record.answerEntryId, settled?.answerEntryId);
    assert.equal(bench.faux.getPendingResponseCount(), 1, "the duplicate never reached the model");
    assert.deepEqual(
      after.filter((event) => event.type === "append"),
      [],
      "no entry was written for the duplicate",
    );
    const history = await reopened.history({ limit: 10 });
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    await reopened.close("tr_runtime_2", 10_000);
  } finally {
    await bench.cleanup();
  }
});
