// docs/bots/TRIGGERS.md §5.1-§5.3: a bounded FIFO, a frozen batch, and an envelope that
// turns several fires into one turn without losing or reordering any of them.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fileJournal,
  MAX_BATCH_TEXT,
  MAX_QUEUE_ITEMS,
  memoryJournal,
  planBatch,
  type QueueItem,
  TriggerQueue,
} from "../../src/triggers/queue.ts";

const at = (minute: number): string =>
  `2026-10-28T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;

const item = (index: number, text = `event ${index}`): QueueItem => ({
  itemId: `d_${index}`,
  text,
  receivedAt: at(index),
});

const queue = async () =>
  TriggerQueue.open({ triggerId: "t_abcd2ef3gh", journal: memoryJournal() });

const webhook = (overrides: Partial<Parameters<TriggerQueue["cut"]>[0]> = {}) => ({
  kind: "webhook" as const,
  prompt: "handle the deliveries",
  cutAt: at(0),
  requestId: (batchId: number) => `wh_t_abcd2ef3gh_${batchId}`,
  ...overrides,
});

test("a fire is queued once: a repeated delivery id is the same delivery", async () => {
  const q = await queue();
  assert.deepEqual(await q.enqueue(item(0)), { accepted: true, dropped: 0 });
  assert.deepEqual(await q.enqueue(item(0)), { accepted: false, dropped: 0 });
  assert.deepEqual(
    q.items().map((entry) => entry.itemId),
    ["d_0"],
  );
});

test("the cap evicts the oldest and counts what it evicted", async () => {
  const q = await queue();
  for (let index = 0; index < MAX_QUEUE_ITEMS + 3; index += 1) await q.enqueue(item(index));
  assert.equal(q.items().length, MAX_QUEUE_ITEMS);
  assert.equal(q.items()[0]?.itemId, "d_3", "the three oldest are gone");
  assert.equal(q.droppedSinceCut(), 3);
  const batch = await q.cut(webhook());
  assert.equal(batch?.dropped, 3, "the loss is carried into the batch it belongs to");
  assert.match(batch?.text ?? "", /3 older events dropped/);
  assert.equal(q.droppedSinceCut(), 0, "a cut starts a new count");
});

test("a cut freezes its members, removes them from the queue and names one key", async () => {
  const q = await queue();
  await q.enqueue(item(0));
  await q.enqueue(item(1));
  const batch = await q.cut(webhook());
  assert.deepEqual(
    batch?.items.map((entry) => entry.itemId),
    ["d_0", "d_1"],
  );
  assert.equal(batch?.requestId, "wh_t_abcd2ef3gh_1");
  assert.equal(q.items().length, 0, "frozen members no longer wait");
  assert.equal(q.openBatch()?.batchId, 1);
  assert.equal(
    await q.cut(webhook()),
    undefined,
    "one batch in flight per trigger: a second cut waits for the first to close",
  );

  await q.enqueue(item(2));
  await q.close(1);
  assert.equal(q.openBatch(), undefined);
  const second = await q.cut(webhook());
  assert.equal(second?.requestId, "wh_t_abcd2ef3gh_2", "the key never repeats");
  assert.deepEqual(
    second?.items.map((entry) => entry.itemId),
    ["d_2"],
    "a fire that arrived during the first batch is the next one",
  );
});

test("the envelope has one exact shape", async () => {
  const q = await queue();
  await q.enqueue(item(0, "deploy finished"));
  await q.enqueue(item(2, "rollback started"));
  const batch = await q.cut(webhook({ prompt: "handle the deliveries" }));
  assert.equal(
    batch?.text,
    [
      "handle the deliveries",
      "",
      "[webhook · 2 items · 2026-10-28 10:00Z..2026-10-28 10:02Z]",
      "1. (2026-10-28 10:00Z) deploy finished",
      "2. (2026-10-28 10:02Z) rollback started",
      "",
      "Answer once, for the batch as a whole.",
    ].join("\n"),
  );
  const single = await queue();
  await single.enqueue(item(0, "one"));
  const one = await single.cut(webhook({ kind: "schedule" }));
  assert.match(one?.text ?? "", /\[schedule · 1 item · 2026-10-28 10:00Z\]/, "a range of one");
});

test("the budget cuts more batches instead of truncating the queue", async () => {
  const q = await queue();
  // Each item is ~1 200 characters, so six of them fill one batch.
  const body = "x".repeat(1_200);
  const sent: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    await q.enqueue(item(index, `${index}:${body}`));
  }
  let batchId = 0;
  for (;;) {
    const batch = await q.cut(webhook({ requestId: (id) => `wh_t_abcd2ef3gh_${id}` }));
    if (batch === undefined) break;
    batchId = batch.batchId;
    assert.ok(
      Array.from(batch.text).length <= MAX_BATCH_TEXT,
      `batch ${batch.batchId} fits the send budget`,
    );
    assert.equal(batch.truncated, false);
    sent.push(...batch.items.map((entry) => entry.itemId));
    await q.close(batch.batchId);
  }
  assert.equal(batchId, 4, "twenty long events become four turns");
  assert.deepEqual(
    sent,
    Array.from({ length: 20 }, (_unused, index) => `d_${index}`),
    "every event is delivered once, in order",
  );
});

test("a single fire larger than the budget is marked, not silently cut", async () => {
  const q = await queue();
  await q.enqueue(item(1, "y".repeat(20_000)));
  const batch = await q.cut(webhook({ prompt: "p" }));
  assert.equal(batch?.truncated, true);
  assert.match(batch?.text ?? "", /…\[truncated\]/);
  assert.ok(Array.from(batch?.text ?? "").length <= MAX_BATCH_TEXT);
  assert.deepEqual(
    batch?.items.map((entry) => entry.itemId),
    ["d_1"],
  );
});

test("a plan keeps the first item even when the prompt is long", () => {
  const plan = planBatch({
    kind: "webhook",
    prompt: "p".repeat(4_000),
    items: [item(0, "short"), item(1, "z".repeat(6_000))],
    dropped: 0,
  });
  assert.deepEqual(
    plan.taken.map((entry) => entry.itemId),
    ["d_0"],
    "the next item is too large for what the prompt leaves",
  );
  assert.equal(plan.truncated, false, "the first item fits, so nothing is marked");
  assert.ok(Array.from(plan.text).length <= MAX_BATCH_TEXT);
});

test("a reopened queue resumes its items and its open batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-queue-"));
  try {
    const path = join(dir, "t.jsonl");
    const first = await TriggerQueue.open({ triggerId: "t_x", journal: fileJournal(path) });
    await first.enqueue(item(0));
    await first.enqueue(item(1));
    const batch = await first.cut(webhook({ requestId: (id) => `wh_t_x_${id}` }));
    await first.enqueue(item(2));

    const reopened = await TriggerQueue.open({ triggerId: "t_x", journal: fileJournal(path) });
    assert.deepEqual(
      reopened.items().map((entry) => entry.itemId),
      ["d_2"],
      "the queue is what was not frozen",
    );
    assert.equal(reopened.openBatch()?.requestId, batch?.requestId, "the batch is still open");
    await reopened.close(batch?.batchId as number);
    const third = await reopened.cut(webhook({ requestId: (id) => `wh_t_x_${id}` }));
    assert.equal(third?.requestId, "wh_t_x_2", "the counter survives the restart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
