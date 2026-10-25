// Ladder rows 17-18: a command needs a subscription, and a send is idempotent by
// requestId while its reply stays connection-scoped.
import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, ConversationService } from "../../src/core/ConversationService.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
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

const subscribe = async (
  service: ConversationService,
  received: HubEvent[],
  connectionId = "c_1",
  botId = "b_1",
) => service.subscribe(connectionId, botId, trace, (event) => received.push(event));

const message = (id: string) => ({
  id,
  role: "user" as const,
  state: "complete" as const,
  createdAt: "x",
  blocks: [{ type: "text" as const, text: id }],
});

/** A delegating handle: spreading a class instance would lose its private fields. */
const proxyHandle = (
  handle: RuntimeHandle,
  overrides: Partial<RuntimeHandle> = {},
): RuntimeHandle => ({
  subscribe: (subscribeTrace, sink) => handle.subscribe(subscribeTrace, sink),
  submit: (input) => handle.submit(input),
  submission: (key) => handle.submission(key),
  history: (input) => handle.history(input),
  abort: (abortTrace) => handle.abort(abortTrace),
  recover: (recoverTrace) => handle.recover(recoverTrace),
  busy: () => handle.busy(),
  close: (closeTrace, deadlineMs) => handle.close(closeTrace, deadlineMs),
  ...overrides,
});

test("send requires a subscription and answers a connection-scoped record", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.kind === "invalid_command" &&
      error.disposition === "not_admitted" &&
      error.requestId === requestId &&
      /^f_[A-Za-z0-9_-]{1,32}$/.test(error.failure.id) &&
      error.failure.kind === "invalid_command",
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
    () => subscribe(service, [], "c_1", "b_2"),
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

test("a later connection starts from the current view, not the open-time snapshot", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const first: HubEvent[] = [];
  await subscribe(service, first);
  runtime.handle("b_1").emit({ type: "append", trace, message: message("e_1") });

  const second: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => second.push(event));
  assert.deepEqual(
    joined.snapshot.messages.map((entry) => entry.id),
    ["e_1"],
    "the baseline is the current view",
  );
  assert.deepEqual(
    second.map((event) => event.type),
    ["snapshot"],
  );
  assert.deepEqual(
    second[0]?.type === "snapshot" ? second[0].value.messages.map((entry) => entry.id) : [],
    ["e_1"],
    "the new connection is told about the message, not shown an empty snapshot",
  );
});

test("a concurrent second subscribe on one connection is refused", async () => {
  const service = serviceFor(new FakeRuntime());
  const first = service.subscribe("c_1", "b_1", trace, () => {});
  const second = service.subscribe("c_1", "b_2", trace, () => {});
  await assert.rejects(
    second,
    (error: unknown) => error instanceof CommandError && error.disposition === "not_admitted",
  );
  await first;
});

test("unsubscribing while the open is in flight cancels the subscription", async () => {
  const runtime = new FakeRuntime();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      await gate;
      return runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
    },
    measure: utf8,
  });
  const received: HubEvent[] = [];
  const pending = service.subscribe("c_1", "b_1", trace, (event) => received.push(event));
  service.unsubscribe("c_1");
  release?.();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CommandError && error.kind === "internal",
  );
  runtime.handle("b_1").emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  assert.deepEqual(received, [], "a cancelled subscription is never attached");
});

test("the baseline snapshot is the first frame and its revision is returned", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await subscribe(service, []);
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "x" }],
  });
  const second: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => {
    second.push(event);
    if (event.type === "snapshot") {
      runtime
        .handle("b_1")
        .emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
    }
  });
  assert.equal(second[0]?.type, "snapshot", "the coalescing window cannot precede the baseline");
  assert.equal(
    joined.rev,
    second[0]?.rev,
    "the returned revision is the baseline's, not the latest",
  );
  assert.deepEqual(
    second.map((event) => event.type),
    ["snapshot", "status"],
    "an event published from the snapshot callback lands after the baseline",
  );
});

test("events produced while the buffer is releasing keep their order", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        subscribe: async (subscribeTrace, sink) => {
          const subscription = await handle.subscribe(subscribeTrace, sink);
          sink({ type: "append", trace: subscribeTrace, message: message("e_1") });
          sink({
            type: "snapshot",
            trace: subscribeTrace,
            value: {
              botId,
              messages: [message("e_1"), message("e_2")],
              streaming: null,
              pending: [],
              inbox: [],
              running: false,
            },
          });
          return subscription;
        },
      });
    },
    measure: utf8,
  });
  const seen: string[] = [];
  await service.subscribe("c_1", "b_1", trace, (event) => {
    seen.push(event.type === "append" ? event.message.id : event.type);
    if (event.type === "append" && event.message.id === "e_1") {
      runtime.handle("b_1").emit({ type: "append", trace, message: message("e_3") });
    }
  });
  assert.deepEqual(
    seen,
    ["snapshot", "e_1", "snapshot", "e_3"],
    "an event produced inside the release lands after the buffered ones, not before",
  );
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.messages.map((entry) => entry.id),
    ["e_1", "e_2", "e_3"],
    "the view kept the event that arrived during the release",
  );
});

test("a failed admission answers an unknown disposition instead of escaping", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        submission: async () => {
          throw new Error("sqlite is busy");
        },
        submit: async () => {
          throw new Error("save failed");
        },
      });
    },
    measure: utf8,
  });
  await subscribe(service, []);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.kind === "internal" &&
      error.disposition === "unknown" &&
      error.requestId === requestId &&
      /^f_[A-Za-z0-9_-]{1,32}$/.test(error.failure.id),
  );
});

test("a submit that fails after the read is unconfirmed admission, not a refusal", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        submission: async () => undefined,
        submit: async () => {
          throw new Error("save failed");
        },
      });
    },
    measure: utf8,
  });
  await subscribe(service, []);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.disposition === "unknown" &&
      error.requestId === requestId &&
      error.cause instanceof Error,
  );
});

test("unanswered keeps its reason and a late queued record cannot resurrect it", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "queued" },
        },
        {
          type: "submission",
          trace: input.trace,
          record: {
            id: "s_1",
            requestId: input.requestId,
            status: "unanswered",
            reason: "model_error",
          },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const reply = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  assert.equal(reply.status, "unanswered");
  assert.equal(reply.reason, "model_error");
  assert.equal(reply.answerEntryId, undefined, "no settlement is invented");
  const statuses = received.flatMap((event) =>
    event.type === "submission" ? [event.record.status] : [],
  );
  assert.deepEqual(statuses, ["queued", "unanswered"]);
  assert.equal(statuses.includes("done"), false);

  runtime.handle("b_1").emit({
    type: "submission",
    trace,
    record: { id: "s_1", requestId, status: "queued" },
  });
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.pending,
    [],
    "a ranked-lower duplicate never becomes pending again",
  );
});
