// Ladder row 11: the fake runtime satisfies the port, so core tests can rely on it.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

test("open is recorded and returns a handle with the whole port", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  assert.deepEqual(runtime.opens, ["b_1"]);
  for (const method of [
    "subscribe",
    "submit",
    "submission",
    "history",
    "abort",
    "recover",
    "busy",
    "close",
  ] as const) {
    assert.equal(typeof handle[method], "function", `${method} is missing`);
  }
  assert.deepEqual(await handle.busy(), { run: false, tasks: false });
  assert.equal(await handle.close(trace, 5_000), "closed");
  assert.deepEqual(runtime.closes, [{ trace, deadlineMs: 5_000 }]);
});

test("subscribe is atomic: the snapshot and every later event arrive", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const seen: RuntimeEvent[] = [];
  const subscription = await handle.subscribe(trace, (event) => seen.push(event));
  assert.deepEqual(subscription.snapshot.messages, []);
  runtime.emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "status");
  subscription.detach();
  runtime.emit({ type: "status", trace, running: false, streaming: null, inbox: [] });
  assert.equal(seen.length, 1, "a detached sink receives nothing");
});

test("submit is idempotent by requestId and the record is readable both ways", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "queued" },
        },
      ],
    },
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const first = await handle.submit({ requestId, text: "hi", whenBusy: "followUp", trace });
  const second = await handle.submit({ requestId, text: "hi", whenBusy: "followUp", trace });
  assert.equal(first.id, second.id);
  assert.deepEqual(await handle.submission({ requestId }), first);
  assert.deepEqual(await handle.submission({ submissionId: first.id }), first);
  assert.equal(await handle.submission({ requestId: "nope" }), undefined);
});

test("history pages older messages and stops at the boundary", async () => {
  const runtime = new FakeRuntime({
    snapshot: {
      botId: "b_1",
      messages: [1, 2, 3, 4, 5].map((index) => ({
        id: `e_${index}`,
        role: "user" as const,
        state: "complete" as const,
        createdAt: "2026-10-25T02:11:04.001Z",
        blocks: [{ type: "text" as const, text: String(index) }],
      })),
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  assert.deepEqual(
    (await handle.history({ limit: 2 })).messages.map((m) => m.id),
    ["e_4", "e_5"],
  );
  const older = await handle.history({ beforeEntryId: "e_4", limit: 2 });
  assert.deepEqual(
    older.messages.map((m) => m.id),
    ["e_2", "e_3"],
  );
  assert.equal(older.hasMore, true);
});
