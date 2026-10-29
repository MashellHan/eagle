// docs/bots/TRIGGERS.md §5.4: the pump reconciles before it cuts, keeps one frozen batch per
// trigger, retries an unadmitted batch with the same key, and shares the bot fairly.
import assert from "node:assert/strict";
import test from "node:test";
import type { Submission } from "../../src/core/domain.ts";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import { newFailure } from "../../src/core/failures.ts";
import type { Invocation, InvocationPort } from "../../src/core/Invocation.ts";
import { BotDrainPump, type PumpTrigger } from "../../src/triggers/pump.ts";
import { TriggerQueue } from "../../src/triggers/queue.ts";

const botId = "b_1";
const now = () => new Date("2026-10-28T10:30:00.000Z");
let traces = 0;

const fakePort = () => {
  const invoked: Invocation[] = [];
  const records = new Map<string, Submission>();
  let failure: (() => unknown) | undefined;
  let sink: ((running: boolean) => void) | undefined;
  let current = false;
  const port: InvocationPort = {
    async invoke(input) {
      invoked.push(input);
      const thrown = failure?.();
      if (thrown !== undefined) throw thrown;
      const record: Submission = {
        id: `s_${invoked.length}`,
        requestId: input.requestId,
        status: "queued",
      };
      records.set(input.requestId, record);
      return record;
    },
    submission: async (query) => records.get(query.requestId),
    observe: (_botId, next) => {
      sink = next;
      next(current);
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
    records,
    setRunning: (running: boolean) => {
      current = running;
      sink?.(running);
    },
    failWith: (next: (() => unknown) | undefined) => {
      failure = next;
    },
    settle: (requestId: string, status: Submission["status"]) => {
      const known = records.get(requestId);
      if (known !== undefined) records.set(requestId, { ...known, status });
    },
    forget: (requestId: string) => records.delete(requestId),
  };
};

const pumpFor = async (
  port: InvocationPort,
  triggers: PumpTrigger[],
  options: { readonly start?: boolean } = {},
) => {
  const pump = new BotDrainPump({
    botId,
    triggers: () => triggers,
    deps: {
      invoke: port.invoke,
      submission: port.submission,
      observe: port.observe,
      now,
      newTrace: () => `tr_pump_${++traces}`,
    },
  });
  // Watching the bot is what tells the pump a run ended; a test that only calls `drain`
  // would never see an edge, which is exactly the case `start` exists for.
  if (options.start !== false) pump.start();
  return pump;
};

const trigger = async (
  id: string,
  kind: "schedule" | "webhook" = "webhook",
): Promise<PumpTrigger> => ({
  id,
  kind,
  prompt: `handle ${id}`,
  queue: await TriggerQueue.open({ triggerId: id, journal: memory() }),
});

// The queue's journal is irrelevant here: the pump never writes it.
const memory = () => ({ append: async () => undefined });

const finish = (fake: ReturnType<typeof fakePort>, requestId: string) => {
  fake.settle(requestId, "done");
  fake.setRunning(false);
};

const fire = async (pumpTrigger: PumpTrigger, itemId: string, text = itemId) => {
  await pumpTrigger.queue.enqueue({
    itemId,
    text,
    receivedAt: "2026-10-28T10:00:00.000Z",
  });
};

test("an idle bot cuts one batch and admits it with the trigger origin", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_9f2a1c3d04");
  await fire(webhook, "d_1", "deploy finished");
  await fire(webhook, "d_2", "rollback started");
  const pump = await pumpFor(fake.port, [webhook]);
  await pump.drain();

  assert.equal(fake.invoked.length, 1);
  const admission = fake.invoked[0];
  assert.equal(admission?.botId, botId);
  assert.equal(admission?.requestId, "wh_t_9f2a1c3d04_1");
  assert.equal(admission?.whenBusy, "reject");
  assert.deepEqual(admission?.origin, { kind: "webhook", triggerId: "t_9f2a1c3d04" });
  assert.match(admission?.text ?? "", /^handle t_9f2a1c3d04/);
  assert.match(admission?.text ?? "", /deploy finished/);
  assert.match(admission?.text ?? "", /rollback started/);
  assert.match(admission?.trace ?? "", /^tr_pump_/);
});

test("a running bot is not cut, and its first idle edge is", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  fake.setRunning(true);
  const pump = await pumpFor(fake.port, [webhook]);
  await pump.drain();
  assert.equal(fake.invoked.length, 0, "a busy bot is not interrupted");

  fake.setRunning(false);
  await pump.drain();
  assert.equal(fake.invoked.length, 1);
});

test("a terminal record closes the batch and the next fire becomes the next batch", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  const pump = await pumpFor(fake.port, [webhook]);
  await pump.drain();
  assert.equal(fake.invoked.length, 1);
  assert.equal(webhook.queue.openBatch()?.requestId, "wh_t_1_1");

  finish(fake, "wh_t_1_1");
  await fire(webhook, "d_2");
  await pump.drain();
  assert.equal(webhook.queue.openBatch()?.requestId, "wh_t_1_2", "the next batch has a new key");
  assert.equal(fake.invoked.length, 2);
  assert.match(fake.invoked[1]?.text ?? "", /d_2/);
});

test("a queued batch is reconciled, not re-cut, even when the bot reports idle", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  const pump = await pumpFor(fake.port, [webhook]);
  await pump.drain();
  fake.setRunning(false);
  await fire(webhook, "d_2");
  await pump.drain();
  assert.equal(fake.invoked.length, 1, "the queued run owns its batch");
  assert.equal(webhook.queue.items().length, 1, "the new fire waits for the next batch");
});

test("an unadmitted batch is retried with the same key, never re-cut", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  const pump = await pumpFor(fake.port, [webhook]);
  await pump.drain();
  const first = fake.invoked[0];
  fake.forget("wh_t_1_1"); // a crash between the journal cut and the admission
  fake.setRunning(false);
  await pump.drain();
  assert.equal(fake.invoked.length, 2);
  assert.equal(fake.invoked[1]?.requestId, first?.requestId, "the same admission, retried");
  assert.equal(fake.invoked[1]?.text, first?.text, "the frozen text is never re-rendered");
  assert.equal(webhook.queue.openBatch()?.batchId, 1);
});

test("a refusal keeps the batch frozen and the retry uses the same key", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  const pump = await pumpFor(fake.port, [webhook]);
  fake.failWith(
    () => new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "the bot is busy"),
  );
  await pump.drain();
  assert.equal(
    fake.invoked.length,
    2,
    "a refusal while the bot looks idle gets exactly one more round, then waits",
  );
  assert.deepEqual(
    [...new Set(fake.invoked.map((entry) => entry.requestId))],
    ["wh_t_1_1"],
    "every attempt is the same admission",
  );
  assert.equal(webhook.queue.openBatch()?.batchId, 1, "the batch stays frozen");

  fake.failWith(undefined);
  await pump.drain();
  assert.equal(webhook.queue.openBatch()?.batchId, 1, "still the same batch, now admitted");
  assert.equal(
    fake.invoked.at(-1)?.requestId,
    "wh_t_1_1",
    "the successful retry uses the frozen key",
  );
});

test("two triggers of one bot take turns", async () => {
  const fake = fakePort();
  const first = await trigger("t_a", "schedule");
  const second = await trigger("t_b");
  await fire(first, "s_1");
  await fire(second, "d_1");
  const pump = await pumpFor(fake.port, [first, second]);

  await pump.drain();
  assert.equal(fake.invoked[0]?.requestId, "sh_t_a_1");
  finish(fake, "sh_t_a_1");
  await pump.drain();
  assert.equal(fake.invoked[1]?.requestId, "wh_t_b_1", "the second trigger is not starved");
  finish(fake, "wh_t_b_1");

  await fire(first, "s_2");
  await pump.drain();
  assert.equal(fake.invoked[2]?.requestId, "sh_t_a_2", "and the first one comes back");
});

test("concurrent drains coalesce into one admission", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  const pump = await pumpFor(fake.port, [webhook]);
  await Promise.all([pump.drain(), pump.drain(), pump.drain()]);
  assert.equal(fake.invoked.length, 1, "one batch, one admission");
});

test("start watches the bot, stop detaches, and a restart resumes the backlog", async () => {
  const fake = fakePort();
  const webhook = await trigger("t_1");
  await fire(webhook, "d_1");
  const pump = await pumpFor(fake.port, [webhook], { start: false });
  pump.start();
  await pump.drain();
  assert.equal(fake.invoked.length, 1, "start drains an existing backlog");

  pump.stop();
  finish(fake, "wh_t_1_1");
  await fire(webhook, "d_2");
  await pump.drain();
  assert.equal(
    fake.invoked.length,
    1,
    "a detached pump has no run-state hint, so it does not guess that the bot is idle",
  );

  pump.start();
  await pump.drain();
  assert.equal(fake.invoked.length, 2, "a restart reports the current state and resumes");
  assert.equal(fake.invoked[1]?.requestId, "wh_t_1_2");
});
