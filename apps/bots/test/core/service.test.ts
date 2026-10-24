// Ladder rows 17-18: a command needs a subscription, and a send is idempotent by
// requestId while its reply stays connection-scoped.
import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, ConversationService } from "../../src/core/ConversationService.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const utf8 = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const serviceFor = (runtime: FakeRuntime): ConversationService =>
  new ConversationService({
    open: (botId, openTrace) =>
      runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      }),
    measure: utf8,
  });

const subscribe = async (service: ConversationService, received: HubEvent[], botId = "b_1") =>
  service.subscribe("c_1", botId, trace, (event) => received.push(event));

test("send requires a subscription and answers a connection-scoped record", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.kind === "invalid_command" &&
      error.disposition === "not_admitted" &&
      error.requestId === requestId,
  );
  assert.equal(runtime.handles.size, 0, "an unsubscribed command opens no bot");

  const received: HubEvent[] = [];
  const joined = await subscribe(service, received);
  assert.deepEqual(
    received.map((event) => [event.type, event.rev]),
    [["snapshot", 1]],
    "the subscription starts from a snapshot at the current revision",
  );
  assert.equal(joined.rev, 1);
  assert.deepEqual(joined.snapshot.messages, []);

  const record = await service.send("c_1", {
    requestId,
    text: "hi",
    whenBusy: "followUp",
    trace,
  });
  assert.deepEqual(record, { id: "s_1", requestId, status: "queued" });
  assert.equal("rev" in record, false, "a connection-scoped reply carries no revision");
});

test("a repeated send with the same requestId returns the stored record and emits nothing", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "placed", entryId: "e_1" },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);

  const first = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  assert.deepEqual(first, { id: "s_1", requestId, status: "placed", entryId: "e_1" });
  const eventsAfterFirst = received.length;
  assert.deepEqual(
    received.map((event) => [event.type, event.rev]),
    [
      ["snapshot", 1],
      ["submission", 2],
    ],
    "admission is broadcast on the hub",
  );

  const second = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  assert.deepEqual(second, first, "the stored record is the reply");
  assert.equal(received.length, eventsAfterFirst, "a duplicate emits no new event");
  assert.equal(runtime.handle("b_1").snapshot.pending.length, 1);
});

test("one connection cannot subscribe twice", async () => {
  const service = serviceFor(new FakeRuntime());
  await subscribe(service, []);
  await assert.rejects(
    () => subscribe(service, [], "b_2"),
    (error: unknown) => error instanceof CommandError && error.kind === "invalid_command",
  );
});

test("an unsubscribed connection is refused and receives nothing more", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  service.unsubscribe("c_1");
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.disposition === "not_admitted" &&
      error.requestId === requestId,
  );
  runtime.handle("b_1").emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot"],
    "a detached sink stops receiving",
  );
});

test("a failed open does not poison the next attempt", async () => {
  let attempts = 0;
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      attempts += 1;
      if (attempts === 1) throw new Error("sqlite is busy");
      return runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
    },
    measure: utf8,
  });
  await assert.rejects(() => subscribe(service, []));
  const received: HubEvent[] = [];
  await subscribe(service, received);
  assert.equal(attempts, 2);
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot"],
  );
});

test("an event delivered while subscribing is published after the first snapshot", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return {
        ...handle,
        subscribe: async (subscribeTrace, sink) => {
          const subscription = await handle.subscribe(subscribeTrace, sink);
          sink({
            type: "status",
            trace: subscribeTrace,
            running: true,
            streaming: null,
            inbox: [],
          });
          return subscription;
        },
      };
    },
    measure: utf8,
  });
  const received: HubEvent[] = [];
  const joined = await subscribe(service, received);
  assert.deepEqual(
    received.map((event) => [event.type, event.rev]),
    [
      ["snapshot", 1],
      ["status", 2],
    ],
    "the baseline is numbered before anything that arrived during subscribe",
  );
  assert.equal(joined.rev, 1);
});
