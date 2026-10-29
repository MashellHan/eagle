// docs/bots/TRIGGERS.md §9.1: one durable decision per due instant, a cursor that never
// catches up, and a missed window that is recorded instead of replayed.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TriggerStore, triggerJournalPath } from "../../src/core/TriggerStore.ts";
import { fileJournal, memoryJournal, TriggerQueue } from "../../src/triggers/queue.ts";
import {
  FRESHNESS_MS,
  nextAfter,
  ScheduleTicker,
  tickSchedule,
} from "../../src/triggers/schedule.ts";

const at = (iso: string): Date => new Date(iso);

const trigger = (overrides: { enabled?: boolean; kind?: "schedule" | "webhook" } = {}) => ({
  id: "t_abcd2ef3gh",
  enabled: overrides.enabled ?? true,
  ...(overrides.kind === "webhook"
    ? {}
    : { schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" } }),
});

const queue = () => TriggerQueue.open({ triggerId: "t_abcd2ef3gh", journal: memoryJournal() });

test("the next instant is computed in the trigger's own zone", () => {
  // 09:00 Asia/Shanghai is 01:00Z.
  assert.equal(
    nextAfter("0 9 * * *", "Asia/Shanghai", at("2026-10-28T00:00:00.000Z")),
    "2026-10-28T01:00:00.000Z",
  );
  assert.equal(
    nextAfter("0 9 * * *", "UTC", at("2026-10-28T00:00:00.000Z")),
    "2026-10-28T09:00:00.000Z",
  );
  assert.equal(
    nextAfter("0 9 * * *", "Asia/Shanghai", at("2026-10-28T01:00:00.000Z")),
    "2026-10-29T01:00:00.000Z",
    "strictly after, so a fire cannot name itself again",
  );
});

test("the first tick arms the cursor instead of firing", async () => {
  const q = await queue();
  const tick = await tickSchedule({
    trigger: trigger(),
    queue: q,
    now: at("2026-10-28T00:00:00.000Z"),
  });
  assert.deepEqual(tick, { kind: "armed", cursor: "2026-10-28T01:00:00.000Z" });
  assert.equal(q.items().length, 0, "arming sends nothing");
});

test("a due instant fires once and advances the cursor", async () => {
  const q = await queue();
  await tickSchedule({ trigger: trigger(), queue: q, now: at("2026-10-28T00:00:00.000Z") });
  const tick = await tickSchedule({
    trigger: trigger(),
    queue: q,
    now: at("2026-10-28T01:00:20.000Z"),
  });
  assert.deepEqual(tick, {
    kind: "fired",
    dueAt: "2026-10-28T01:00:00.000Z",
    cursor: "2026-10-29T01:00:00.000Z",
  });
  assert.deepEqual(
    q.items().map((item) => item.itemId),
    ["due_2026-10-28T01:00:00.000Z"],
  );
  const again = await tickSchedule({
    trigger: trigger(),
    queue: q,
    now: at("2026-10-28T01:00:40.000Z"),
  });
  assert.deepEqual(again, { kind: "idle" }, "the same instant never fires twice");
  assert.equal(q.items().length, 1);
});

test("downtime is recorded as missed, never replayed", async () => {
  const q = await queue();
  await tickSchedule({ trigger: trigger(), queue: q, now: at("2026-10-28T00:00:00.000Z") });
  const tick = await tickSchedule({
    trigger: trigger(),
    queue: q,
    now: at("2026-10-28T02:00:00.000Z"),
    freshnessMs: FRESHNESS_MS,
  });
  assert.deepEqual(tick, {
    kind: "missed",
    dueAt: "2026-10-28T01:00:00.000Z",
    cursor: "2026-10-29T01:00:00.000Z",
  });
  assert.equal(q.items().length, 0, "a window that passed while off is not delivered");
});

test("a disabled trigger holds no cursor and enabling starts from the next instant", async () => {
  const q = await queue();
  await tickSchedule({ trigger: trigger(), queue: q, now: at("2026-10-28T00:00:00.000Z") });
  assert.notEqual(q.cursor(), undefined);

  const off = await tickSchedule({
    trigger: trigger({ enabled: false }),
    queue: q,
    now: at("2026-10-28T00:30:00.000Z"),
  });
  assert.deepEqual(off, { kind: "idle" });
  assert.equal(q.cursor(), undefined, "disabling drops the cursor");

  const on = await tickSchedule({
    trigger: trigger(),
    queue: q,
    now: at("2026-10-28T03:00:00.000Z"),
  });
  assert.deepEqual(
    on,
    { kind: "armed", cursor: "2026-10-29T01:00:00.000Z" },
    "enabling arms the next instant, it does not catch up",
  );
  assert.equal(q.items().length, 0);
});

test("the cursor and its fire are one journal record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-schedule-"));
  try {
    const path = join(dir, "queue.jsonl");
    const first = await TriggerQueue.open({ triggerId: "t_x", journal: fileJournal(path) });
    await tickSchedule({
      trigger: { ...trigger(), id: "t_x" },
      queue: first,
      now: at("2026-10-28T00:00:00.000Z"),
    });
    await tickSchedule({
      trigger: { ...trigger(), id: "t_x" },
      queue: first,
      now: at("2026-10-28T01:00:05.000Z"),
    });

    const reopened = await TriggerQueue.open({ triggerId: "t_x", journal: fileJournal(path) });
    assert.equal(reopened.cursor(), "2026-10-29T01:00:00.000Z", "the cursor resumed");
    assert.deepEqual(
      reopened.items().map((item) => item.itemId),
      ["due_2026-10-28T01:00:00.000Z"],
      "the fire it belongs to resumed with it",
    );
    const journal = await fileJournal(path).read();
    assert.deepEqual(
      journal.map((record) => record.op),
      ["cursor", "fire"],
      "arming is one record, firing is one record",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a ticker walks every bot's schedule and leaves webhooks alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-schedule-"));
  try {
    let ids = 0;
    const store = await TriggerStore.open("b_1", triggerJournalPath(join(dir, "bot")), {
      now: () => at("2026-10-28T00:00:00.000Z"),
      newId: () => `t_aaaaaaaaa${"bcdefghij"[ids++]}`,
    });
    await store.create({
      opId: "op_1",
      kind: "schedule",
      name: "morning",
      prompt: "triage",
      schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    });
    await store.create({ opId: "op_2", kind: "webhook", name: "hook", prompt: "handle" });
    const queues = new Map<string, TriggerQueue>();
    const queueFor = async (triggerId: string) => {
      const known = queues.get(triggerId);
      if (known !== undefined) return known;
      const opened = await TriggerQueue.open({ triggerId, journal: memoryJournal() });
      queues.set(triggerId, opened);
      return opened;
    };
    const seen: string[] = [];
    let now = at("2026-10-28T00:00:00.000Z");
    const ticker = new ScheduleTicker({
      sources: async () => [{ botId: "b_1", store, queueFor }],
      now: () => now,
      onTick: ({ tick }) => seen.push(tick.kind),
    });

    await ticker.tick();
    assert.deepEqual(seen, ["armed"], "the webhook trigger is not ticked");
    now = at("2026-10-28T01:00:10.000Z");
    await ticker.tick();
    assert.deepEqual(seen, ["armed", "fired"]);
    assert.equal(
      (await store.list()[0]?.lastFiredAt) === undefined,
      false,
      "the fire is recorded on the definition for the sidebar",
    );
    assert.equal(queues.get("t_aaaaaaaaab")?.items().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
