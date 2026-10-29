// docs/bots/TRIGGERS.md §3.6 and §9.1 at the daemon level: a schedule becomes one queued
// fire, the pump admits it through the invocation port, and stop detaches both producers.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Submission } from "../../src/core/domain.ts";
import type { Invocation, InvocationPort } from "../../src/core/Invocation.ts";
import { TriggerStore, triggerJournalPath } from "../../src/core/TriggerStore.ts";
import { TriggerProducers } from "../../src/triggers/producers.ts";
import { memoryJournal, TriggerQueue } from "../../src/triggers/queue.ts";

const at = (iso: string): Date => new Date(iso);

const fakePort = () => {
  const invoked: Invocation[] = [];
  const records = new Map<string, Submission>();
  let sink: ((running: boolean) => void) | undefined;
  let running = false;
  const port: InvocationPort = {
    async invoke(input) {
      invoked.push(input);
      if (running) throw new Error("busy");
      const record: Submission = {
        id: `s_${invoked.length}`,
        requestId: input.requestId,
        status: "queued",
      };
      records.set(input.requestId, record);
      running = true;
      sink?.(true);
      return record;
    },
    submission: async (query) => records.get(query.requestId),
    observe: (_botId, next) => {
      sink = next;
      next(running);
      return {
        detach: () => {
          sink = undefined;
        },
      };
    },
  };
  return {
    port,
    invoked,
    settle: (requestId: string) => {
      const known = records.get(requestId);
      if (known !== undefined) records.set(requestId, { ...known, status: "done" });
      running = false;
      sink?.(false);
    },
  };
};

const bench = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-producers-"));
  let ids = 0;
  const store = await TriggerStore.open("b_1", triggerJournalPath(join(dir, "bot")), {
    now: () => at("2026-10-28T00:00:00.000Z"),
    newId: () => `t_aaaaaaaaa${"bcdefghij"[ids++]}`,
  });
  const queues = new Map<string, TriggerQueue>();
  const queueFor = async (botId: string, triggerId: string) => {
    const key = `${botId}/${triggerId}`;
    const known = queues.get(key);
    if (known !== undefined) return known;
    const opened = await TriggerQueue.open({ triggerId, journal: memoryJournal() });
    queues.set(key, opened);
    return opened;
  };
  return { dir, store, queueFor, queues };
};

test("a due schedule becomes one queued fire and one admission", async () => {
  const setup = await bench();
  let producers: TriggerProducers | undefined;
  try {
    const fake = fakePort();
    let now = at("2026-10-28T00:00:00.000Z");
    await setup.store.create({
      opId: "op_1",
      kind: "schedule",
      name: "morning",
      prompt: "triage the queue",
      schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    });
    producers = new TriggerProducers({
      bots: () => ["b_1"],
      storeFor: async () => setup.store,
      queueFor: setup.queueFor,
      port: fake.port,
      now: () => now,
      newTrace: () => "tr_producers_0001",
    });
    producers.start();

    await producers.tick();
    assert.equal(fake.invoked.length, 0, "the first tick only arms the cursor");

    now = at("2026-10-28T01:00:10.000Z");
    await producers.tick();
    assert.equal(fake.invoked.length, 1);
    const admission = fake.invoked[0];
    assert.equal(admission?.botId, "b_1");
    assert.equal(admission?.requestId, "sh_t_aaaaaaaaab_1");
    assert.deepEqual(admission?.origin, { kind: "schedule", triggerId: "t_aaaaaaaaab" });
    assert.match(admission?.text ?? "", /triage the queue/);
    assert.match(admission?.text ?? "", /scheduled/);
    assert.equal(admission?.whenBusy, "reject");
    assert.equal(
      (await setup.store.list())[0]?.lastFiredAt,
      now.toISOString(),
      "the fire is recorded for the sidebar",
    );

    // The run ends: the batch closes, so the next due instant is a new batch and a key.
    fake.settle("sh_t_aaaaaaaaab_1");
    now = at("2026-10-29T01:00:10.000Z");
    await producers.tick();
    assert.equal(fake.invoked.length, 2);
    assert.equal(fake.invoked[1]?.requestId, "sh_t_aaaaaaaaab_2");
  } finally {
    producers?.stop();
    await rm(setup.dir, { recursive: true, force: true });
  }
});

test("a disabled trigger never fires and holds no cursor", async () => {
  const setup = await bench();
  let producers: TriggerProducers | undefined;
  try {
    const fake = fakePort();
    let now = at("2026-10-28T00:00:00.000Z");
    const { trigger } = await setup.store.create({
      opId: "op_1",
      kind: "schedule",
      name: "morning",
      prompt: "triage",
      schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    });
    producers = new TriggerProducers({
      bots: () => ["b_1"],
      storeFor: async () => setup.store,
      queueFor: setup.queueFor,
      port: fake.port,
      now: () => now,
      newTrace: () => "tr_producers_0002",
    });
    producers.start();
    await producers.tick();
    assert.equal((await setup.queueFor("b_1", trigger.id)).cursor(), "2026-10-28T01:00:00.000Z");

    await setup.store.enable({ opId: "op_off", triggerId: trigger.id, enabled: false });
    now = at("2026-10-28T01:00:10.000Z");
    await producers.tick();
    assert.equal(fake.invoked.length, 0, "a disabled trigger does not fire");
    assert.equal((await setup.queueFor("b_1", trigger.id)).cursor(), undefined);

    await setup.store.enable({ opId: "op_on", triggerId: trigger.id, enabled: true });
    now = at("2026-10-28T05:00:00.000Z");
    await producers.tick();
    assert.equal(fake.invoked.length, 0, "enabling re-arms instead of catching up");
    assert.equal((await setup.queueFor("b_1", trigger.id)).cursor(), "2026-10-29T01:00:00.000Z");
  } finally {
    producers?.stop();
    await rm(setup.dir, { recursive: true, force: true });
  }
});

test("stop detaches the pumps and the ticker", async () => {
  const setup = await bench();
  try {
    const fake = fakePort();
    let timers = 0;
    const producers = new TriggerProducers({
      bots: () => ["b_1"],
      storeFor: async () => setup.store,
      queueFor: setup.queueFor,
      port: fake.port,
      now: () => at("2026-10-28T00:00:00.000Z"),
      newTrace: () => "tr_producers_0003",
      setTimer: () => {
        timers += 1;
        return () => undefined;
      },
    });
    producers.start();
    assert.equal(timers, 1, "the ticker armed one timer");
    producers.stop();
    assert.equal(timers, 1, "stop does not arm another");

    await setup.store.create({
      opId: "op_1",
      kind: "schedule",
      name: "morning",
      prompt: "triage",
      schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    });
    await producers.tick();
    assert.equal(
      fake.invoked.length,
      0,
      "an explicit tick after stop still works but nothing watches the bot",
    );
  } finally {
    await rm(setup.dir, { recursive: true, force: true });
  }
});
