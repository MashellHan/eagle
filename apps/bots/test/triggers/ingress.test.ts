// docs/bots/TRIGGERS.md §9.2: the delivery contract. One bearer per trigger, one item per
// delivery, the queue's answer for a burst, and no oracle for an unknown trigger.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TriggerSecretStore } from "../../src/core/TriggerSecrets.ts";
import { TriggerStore, triggerJournalPath } from "../../src/core/TriggerStore.ts";
import { createIngress, deliveryText } from "../../src/triggers/ingress.ts";
import { MAX_QUEUE_ITEMS, memoryJournal, TriggerQueue } from "../../src/triggers/queue.ts";

const botId = "b_1";
const triggerId = "t_9f2a1c3d04";

const bench = async (options: { enabled?: boolean; kind?: "webhook" | "schedule" } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "bots-ingress-"));
  const store = await TriggerStore.open(botId, triggerJournalPath(join(dir, "bot")), {
    now: () => new Date("2026-10-29T00:00:00.000Z"),
    newId: () => triggerId,
  });
  await store.create({
    opId: "op_1",
    kind: options.kind ?? "webhook",
    name: "deploy notify",
    prompt: "handle the deploy",
    ...(options.kind === "schedule" ? { schedule: { cron: "0 9 * * *", timezone: "UTC" } } : {}),
  });
  if (options.enabled === false) {
    await store.enable({ opId: "op_off", triggerId, enabled: false });
  }
  const secrets = await TriggerSecretStore.open(join(dir, "bot", "triggers.secrets.json"));
  const token = await secrets.tokenFor(triggerId);
  const queue = await TriggerQueue.open({ triggerId, journal: memoryJournal() });
  const drains: string[] = [];
  const counts: { fired?: number; dropped?: number; refused?: number }[] = [];
  const ingress = createIngress({
    storeFor: async () => store,
    secretsFor: async () => secrets,
    queueFor: async () => queue,
    drain: (id) => drains.push(id),
    now: () => new Date("2026-10-29T00:00:00.000Z"),
    count: (_botId, _triggerId, delta) => counts.push(delta),
  });
  return { dir, store, secrets, token, queue, ingress, drains, counts };
};

const deliver = (
  ingress: ReturnType<typeof bench> extends Promise<infer T>
    ? T extends { ingress: infer I }
      ? I
      : never
    : never,
  overrides: Partial<Parameters<typeof deliverInput>[0]> = {},
) => ingress.deliver(deliverInput(overrides));

type DeliverInput = {
  botId: string;
  triggerId: string;
  token: string;
  body: Buffer;
  contentType: string | undefined;
  idempotencyKey: string | undefined;
};

const deliverInput = (overrides: Partial<DeliverInput> = {}): DeliverInput => ({
  botId,
  triggerId,
  token: "",
  body: Buffer.from("deploy finished"),
  contentType: "text/plain",
  idempotencyKey: undefined,
  ...overrides,
});

test("a delivery becomes one item, one drain, and no second for a retried key", async () => {
  const setup = await bench();
  try {
    const first = await deliver(setup.ingress, { token: setup.token });
    assert.deepEqual(first, { kind: "queued", queued: 1, dropped: 0 });
    assert.deepEqual(setup.drains, [botId], "the pump is asked to look, not waited on");
    assert.deepEqual(setup.counts, [{ fired: 1 }], "the trigger counts its own fire");
    assert.deepEqual(
      setup.queue.items().map((item) => item.text),
      ["deploy finished"],
    );

    const retry = await deliver(setup.ingress, {
      token: setup.token,
      idempotencyKey: "delivery-1",
    });
    const again = await deliver(setup.ingress, {
      token: setup.token,
      idempotencyKey: "delivery-1",
    });
    assert.deepEqual(retry, { kind: "queued", queued: 1, dropped: 0 });
    assert.deepEqual(again, { kind: "queued", queued: 0, dropped: 0 }, "same key, same item");
    assert.equal(setup.queue.items().length, 2);
  } finally {
    await rm(setup.dir, { recursive: true, force: true });
  }
});

test("the same body without a key is also one item", async () => {
  const setup = await bench();
  try {
    await deliver(setup.ingress, { token: setup.token });
    const again = await deliver(setup.ingress, { token: setup.token });
    assert.deepEqual(again, { kind: "queued", queued: 0, dropped: 0 });
    assert.equal(setup.queue.items().length, 1, "a content hash dedupes a keyless retry");
  } finally {
    await rm(setup.dir, { recursive: true, force: true });
  }
});

test("JSON carries the text; an empty or textless body is refused", async () => {
  const setup = await bench();
  try {
    const json = await deliver(setup.ingress, {
      token: setup.token,
      body: Buffer.from(JSON.stringify({ text: "from json", other: 1 })),
      contentType: "application/json; charset=utf-8",
    });
    assert.deepEqual(json, { kind: "queued", queued: 1, dropped: 0 });
    assert.equal(setup.queue.items()[0]?.text, "from json");

    assert.deepEqual(
      await deliver(setup.ingress, {
        token: setup.token,
        body: Buffer.from(JSON.stringify({ other: 1 })),
        contentType: "application/json",
      }),
      { kind: "invalid", message: "text is required" },
    );
    assert.deepEqual(
      await deliver(setup.ingress, {
        token: setup.token,
        body: Buffer.from("   "),
        contentType: "text/plain",
      }),
      { kind: "invalid", message: "text is required" },
    );
    assert.equal(setup.queue.items().length, 1, "a refusal enqueues nothing");
  } finally {
    await rm(setup.dir, { recursive: true, force: true });
  }
});

test("a long delivery is clamped, not rejected", () => {
  const text = deliveryText(Buffer.from("x".repeat(9_000)), "text/plain");
  assert.equal(Array.from(text ?? "").length, 8_000 + 12, "8000 characters plus the marker");
  assert.match(text ?? "", /…\[truncated\]$/);
  assert.equal(deliveryText(Buffer.from(""), "text/plain"), undefined);
  assert.equal(deliveryText(Buffer.from("{oops"), "application/json"), undefined);
});

test("an unknown trigger, a wrong token, a disabled trigger and a full queue each answer", async () => {
  const setup = await bench();
  try {
    assert.deepEqual(await deliver(setup.ingress, { token: "wrong" }), { kind: "unknown" });
    assert.deepEqual(
      await deliver(setup.ingress, { token: setup.token, triggerId: "t_aaaaaaaaaa" }),
      { kind: "unknown" },
    );
    assert.deepEqual(await deliver(setup.ingress, { token: "" }), { kind: "unknown" });
    assert.deepEqual(setup.counts, [], "an unauthenticated attempt is not this trigger's history");
  } finally {
    await rm(setup.dir, { recursive: true, force: true });
  }

  const off = await bench({ enabled: false });
  try {
    assert.deepEqual(await deliver(off.ingress, { token: off.token }), { kind: "disabled" });
    assert.deepEqual(off.counts, [{ refused: 1 }], "a disabled trigger counts the refusal");
  } finally {
    await rm(off.dir, { recursive: true, force: true });
  }

  const full = await bench();
  try {
    for (let index = 0; index < MAX_QUEUE_ITEMS; index += 1) {
      await deliver(full.ingress, { token: full.token, idempotencyKey: `k${index}` });
    }
    assert.deepEqual(await deliver(full.ingress, { token: full.token }), {
      kind: "queue_full",
    });
    assert.equal(full.queue.items().length, MAX_QUEUE_ITEMS, "nothing was evicted for it");
    assert.deepEqual(full.counts.at(-1), { refused: 1 }, "a full queue counts the refusal");
  } finally {
    await rm(full.dir, { recursive: true, force: true });
  }

  const schedule = await bench({ kind: "schedule" });
  try {
    assert.deepEqual(
      await deliver(schedule.ingress, { token: schedule.token }),
      {
        kind: "unknown",
      },
      "a schedule trigger has no endpoint",
    );
  } finally {
    await rm(schedule.dir, { recursive: true, force: true });
  }
});
