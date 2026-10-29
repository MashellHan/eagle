// docs/bots/TRIGGERS.md §4: a bot's trigger definitions, the journal that survives a crash,
// and the two idempotency rules a replayed tool call depends on.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_TRIGGERS,
  TriggerStore,
  type TriggerStoreOptions,
  triggerJournalPath,
} from "../../src/core/TriggerStore.ts";

const botId = "b_1";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** A deterministic id that still obeys the wire alphabet, so the real shape is asserted. */
const idAt = (index: number): string => {
  let value = index;
  let body = "";
  for (let digit = 0; digit < 10; digit += 1) {
    body = `${ALPHABET[value % ALPHABET.length]}${body}`;
    value = Math.floor(value / ALPHABET.length);
  }
  return `t_${body}`;
};

const openStore = async (dir: string, options: TriggerStoreOptions = {}) => {
  let tick = 0;
  const ids = { next: 0 };
  return TriggerStore.open(botId, triggerJournalPath(join(dir, "bot")), {
    now: () => new Date(Date.UTC(2026, 9, 28, 0, tick++)),
    newId: () => idAt(ids.next++),
    ...options,
  });
};

const webhook = (name: string, opId = `op_${name}`) => ({
  opId,
  kind: "webhook" as const,
  name,
  prompt: `handle ${name}`,
});

const schedule = (
  name: string,
  opId = `op_${name}`,
  cron = "0 9 * * *",
  timezone = "Asia/Shanghai",
) => ({
  opId,
  kind: "schedule" as const,
  name,
  prompt: `run ${name}`,
  schedule: { cron, timezone },
});

test("a created trigger has a wire-safe id, is enabled, and is listed by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const { trigger, created } = await store.create(webhook("deploy notify"));
    assert.equal(created, true);
    assert.match(trigger.id, /^t_[a-z2-7]{10}$/, "the id is fixed length and wire-safe");
    assert.equal(trigger.botId, botId);
    assert.equal(trigger.enabled, true);
    assert.deepEqual(trigger.counters, { fired: 0, dropped: 0, refused: 0 });
    assert.equal(store.get(trigger.id)?.name, "deploy notify");
    assert.equal(store.findByName("deploy notify")?.id, trigger.id);
    assert.deepEqual(
      store.list().map((entry) => entry.name),
      ["deploy notify"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("name, prompt, cron and zone are validated before anything is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const refuses = (input: Parameters<TriggerStore["create"]>[0]) =>
      assert.rejects(
        () => store.create(input),
        (error: unknown) => error instanceof Error && error.name === "TriggerStoreError",
      );
    await refuses({ ...webhook("x"), name: "" });
    await refuses({ ...webhook("x"), name: "n".repeat(65) });
    await refuses({ ...webhook("x"), prompt: "" });
    await refuses({ ...webhook("x"), prompt: "p".repeat(4_001) });
    await refuses({ ...schedule("x"), schedule: { cron: "0 9 * *", timezone: "UTC" } });
    await refuses({ ...schedule("x"), schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } });
    await refuses({ ...schedule("x"), schedule: { cron: "0 9 * * * 1", timezone: "UTC" } });
    await refuses({
      opId: "op_nosched",
      kind: "schedule",
      name: "x",
      prompt: "run x",
    } as never);
    await refuses({
      ...webhook("x"),
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
    } as never);
    assert.deepEqual(store.list(), [], "a refusal writes nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the eighth trigger fits and the ninth is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    for (let index = 0; index < MAX_TRIGGERS; index += 1) {
      await store.create(webhook(`t${index}`));
    }
    await assert.rejects(
      () => store.create(webhook("one too many")),
      (error: unknown) =>
        error instanceof Error && error.message.includes(`at most ${MAX_TRIGGERS} triggers`),
    );
    assert.equal(store.list().length, MAX_TRIGGERS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent creates cannot both take the last slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    for (let index = 0; index < MAX_TRIGGERS - 1; index += 1) {
      await store.create(webhook(`t${index}`));
    }
    const outcomes = await Promise.allSettled([
      store.create(webhook("last a", "op_a")),
      store.create(webhook("last b", "op_b")),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["fulfilled", "rejected"],
      "the check and the append are one serial section",
    );
    assert.equal(store.list().length, MAX_TRIGGERS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an identical replay under another op id returns the stored trigger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const first = await store.create(webhook("deploy notify", "op_first"));
    const again = await store.create(webhook("deploy notify", "op_second"));
    assert.equal(again.created, false);
    assert.equal(again.trigger.id, first.trigger.id, "no second definition");
    assert.equal(store.list().length, 1);

    await assert.rejects(
      () => store.create({ ...webhook("deploy notify", "op_third"), prompt: "a different prompt" }),
      (error: unknown) => error instanceof Error && error.message.includes("already exists"),
      "a different definition under a taken name is refused, not silently accepted",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replayed op id answers with what it did instead of acting again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const { trigger } = await store.create(webhook("ops"));
    const enabled = await store.enable({
      opId: "op_disable",
      triggerId: trigger.id,
      enabled: false,
    });
    assert.equal(enabled.enabled, false);
    const replayed = await store.enable({
      opId: "op_disable",
      triggerId: trigger.id,
      enabled: true,
    });
    assert.equal(replayed.enabled, false, "the replay does not flip the switch again");

    const updated = await store.update({ opId: "op_rename", triggerId: trigger.id, name: "new" });
    assert.equal(updated.name, "new");
    assert.equal(
      (await store.update({ opId: "op_rename", triggerId: trigger.id, name: "newer" })).name,
      "new",
      "a replay returns the recorded result",
    );

    await store.remove({ opId: "op_remove", triggerId: trigger.id });
    assert.equal(store.list().length, 0);
    const removedAgain = await store.remove({ opId: "op_remove", triggerId: trigger.id });
    assert.deepEqual(removedAgain, { triggerId: trigger.id });

    const journal = await readFile(triggerJournalPath(join(dir, "bot")), "utf8");
    assert.equal(
      journal.trim().split("\n").length,
      4,
      "one line per operation, and a replay writes none",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("switching a trigger keeps the definition and leaves the cursor to the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const { trigger } = await store.create(schedule("morning"));
    const disabled = await store.enable({
      opId: "op_off",
      triggerId: trigger.id,
      enabled: false,
    });
    assert.equal(disabled.enabled, false);
    assert.deepEqual(
      disabled.schedule,
      { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
      "the definition survives the switch untouched",
    );
    const enabled = await store.enable({ opId: "op_on", triggerId: trigger.id, enabled: true });
    assert.equal(enabled.enabled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a trigger and its bookkeeping survive a reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const { trigger } = await store.create(schedule("morning"));
    await store.patch({
      triggerId: trigger.id,
      patch: {
        counters: { fired: 3, dropped: 1, refused: 0 },
        lastFiredAt: "2026-10-28T01:00:03.000Z",
        lastSkipped: { at: "2026-10-28T02:00:00.000Z", reason: "missed" },
      },
    });
    await store.enable({ opId: "op_off", triggerId: trigger.id, enabled: false });

    const reopened = await openStore(dir);
    const loaded = reopened.get(trigger.id);
    assert.equal(loaded?.enabled, false);
    assert.deepEqual(loaded?.counters, { fired: 3, dropped: 1, refused: 0 });
    assert.equal(loaded?.lastFiredAt, "2026-10-28T01:00:03.000Z");
    assert.equal(loaded?.lastSkipped?.reason, "missed");
    assert.equal(
      await reopened
        .enable({ opId: "op_off", triggerId: trigger.id, enabled: true })
        .then((entry) => entry.enabled),
      false,
      "an op id stays answerable after a restart",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt journal line is skipped and the rest still replays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const store = await openStore(dir);
    const { trigger } = await store.create(webhook("kept"));
    const path = triggerJournalPath(join(dir, "bot"));
    await writeFile(path, "{not json\n", { flag: "a" });
    const reopened = await openStore(dir);
    assert.equal(reopened.get(trigger.id)?.name, "kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a long journal is compacted to one snapshot on open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-"));
  try {
    const path = triggerJournalPath(join(dir, "bot"));
    await mkdir(join(dir, "bot"), { recursive: true });
    const trigger = {
      id: "t_fixed00000",
      botId,
      kind: "webhook" as const,
      name: "compacted",
      prompt: "keep me",
      enabled: true,
      createdAt: "2026-10-28T00:00:00.000Z",
      updatedAt: "2026-10-28T00:00:00.000Z",
      counters: { fired: 0, dropped: 0, refused: 0 },
    };
    const lines = [JSON.stringify({ op: "create", opId: "op_0", trigger })];
    for (let index = 0; index < 1_100; index += 1) {
      lines.push(
        JSON.stringify({
          op: "state",
          triggerId: trigger.id,
          patch: { counters: { fired: index, dropped: 0, refused: 0 } },
        }),
      );
    }
    await writeFile(path, `${lines.join("\n")}\n`);

    const reopened = await openStore(dir);
    assert.equal(reopened.get(trigger.id)?.name, "compacted");
    assert.equal(reopened.get(trigger.id)?.counters.fired, 1_099, "the newest state wins");
    const compacted = await readFile(path, "utf8");
    assert.equal(compacted.trim().split("\n").length, 1, "one snapshot record replaces the log");
    assert.deepEqual(JSON.parse(compacted).op, "snapshot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
