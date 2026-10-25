// Ladder rows 17-18: a command needs a subscription, and a send is idempotent by
// requestId while its reply stays connection-scoped.
import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, ConversationService } from "../../src/core/ConversationService.ts";
import type { ConversationSnapshot, Submission } from "../../src/core/domain.ts";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import type { RuntimeEvent, RuntimeHandle, SubmitInput } from "../../src/core/RuntimePort.ts";
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

/**
 * A scripted runtime handle that forwards raw events, so a case observes the service's
 * own fold instead of the fake runtime's copy of it.
 */
const scriptedHandle = (options: {
  readonly snapshot: ConversationSnapshot;
  readonly record?: (input: SubmitInput) => Submission;
  readonly onSubmit?: (input: SubmitInput) => RuntimeEvent[];
}): { handle: RuntimeHandle; emit: (event: RuntimeEvent) => void } => {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const handle: RuntimeHandle = {
    subscribe: async (_trace, next) => {
      sink = next;
      return {
        snapshot: options.snapshot,
        detach: () => {
          sink = undefined;
        },
      };
    },
    submission: async () => undefined,
    submit: async (input) => {
      for (const event of options.onSubmit?.(input) ?? []) sink?.(event);
      return options.record?.(input) ?? { id: "s_1", requestId: input.requestId, status: "queued" };
    },
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => {},
    recover: async () => {},
    busy: async () => ({ run: false, tasks: false }),
    close: async () => "closed",
  };
  return { handle, emit: (event) => sink?.(event) };
};

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

test("a delta flushed for an older connection cannot precede a new baseline", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  let reentered = false;
  await service.subscribe("c_1", "b_1", trace, (event) => {
    if (event.type !== "delta" || reentered) return;
    reentered = true;
    runtime.handle("b_1").emit({
      type: "delta",
      trace,
      messageId: "p_a1",
      changes: [{ kind: "text", index: 0, append: "B" }],
    });
  });
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "A" }],
  });
  const second: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => second.push(event));
  assert.deepEqual(
    second.map((event) => event.type),
    ["snapshot"],
    "the flush and its reentrant sibling stay out of the new connection",
  );
  assert.equal(joined.rev, second[0]?.rev);
});

test("a connection cancelled by a flush is not attached", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await service.subscribe("c_1", "b_1", trace, (event) => {
    if (event.type === "delta") service.unsubscribe("c_2");
  });
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "A" }],
  });
  const received: HubEvent[] = [];
  await assert.rejects(
    () => service.subscribe("c_2", "b_1", trace, (event) => received.push(event)),
    (error: unknown) => error instanceof CommandError && error.kind === "internal",
  );
  assert.deepEqual(received, [], "a cancelled connection never receives a frame");
});

test("a classified failure keeps its identity and disposition", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const storage = new ClassifiedFailure(
    { id: "f_episode", kind: "storage_failed", layer: "runtime" },
    "runtime",
    "disk is full",
  );
  const busy = new ClassifiedFailure(
    { id: "f_busy", kind: "invalid_command", layer: "core" },
    "not_admitted",
    "busy with reject",
  );
  const reading = scriptedHandle({ snapshot });
  const service = new ConversationService({
    open: async () => ({
      ...reading.handle,
      subscribe: async (subscribeTrace, sink) => {
        const subscription = await reading.handle.subscribe(subscribeTrace, sink);
        return subscription;
      },
      submission: async () => {
        throw storage;
      },
      submit: async () => {
        throw busy;
      },
    }),
    measure: utf8,
  });
  await subscribe(service, []);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) => error === storage,
    "a runtime-classified read failure is not rewritten",
  );
  const writing = scriptedHandle({ snapshot });
  const second = new ConversationService({
    open: async () => ({
      ...writing.handle,
      submission: async () => undefined,
      submit: async () => {
        throw busy;
      },
    }),
    measure: utf8,
  });
  await subscribe(second, []);
  await assert.rejects(
    () => second.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) => error === busy,
    "an explicit refusal keeps not_admitted so the outbox entry can be restored",
  );
});

test("a stale snapshot cannot downgrade a settlement for the connection or a new one", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const settled = (input: SubmitInput): Submission => ({
    id: "s_1",
    requestId: input.requestId,
    status: "done",
    entryId: "e_1",
    answerEntryId: "e_2",
  });
  const scripted = scriptedHandle({
    snapshot,
    record: settled,
    onSubmit: (input) => [{ type: "submission", trace: input.trace, record: settled(input) }],
  });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  scripted.emit({
    type: "snapshot",
    trace,
    value: { ...snapshot, pending: [{ id: "s_1", requestId, status: "queued" }] },
  });
  const broadcast = received.filter((event) => event.type === "snapshot").at(-1);
  assert.deepEqual(
    broadcast?.type === "snapshot" ? broadcast.value.pending : ["unchecked"],
    [],
    "the existing connection is broadcast a normalized snapshot",
  );
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, [], "a new connection's baseline stays settled");
});

test("a stale snapshot keeps the placed record with its entry id", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const placed = (input: SubmitInput): Submission => ({
    id: "s_1",
    requestId: input.requestId,
    status: "placed",
    entryId: "e_1",
  });
  const scripted = scriptedHandle({
    snapshot,
    record: placed,
    onSubmit: (input) => [{ type: "submission", trace: input.trace, record: placed(input) }],
  });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  scripted.emit({
    type: "snapshot",
    trace,
    value: { ...snapshot, pending: [{ id: "s_1", requestId, status: "queued" }] },
  });
  const expected = [{ id: "s_1", requestId, status: "placed", entryId: "e_1" }];
  const broadcast = received.filter((event) => event.type === "snapshot").at(-1);
  assert.deepEqual(
    broadcast?.type === "snapshot" ? broadcast.value.pending : ["unchecked"],
    expected,
  );
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, expected);
});

test("the rank of the initial snapshot is seeded, so a duplicate cannot downgrade it", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [{ id: "s_9", requestId, status: "placed", entryId: "e_1" }],
    inbox: [],
    running: false,
  };
  const scripted = scriptedHandle({ snapshot });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  await subscribe(service, []);
  scripted.emit({
    type: "submission",
    trace,
    record: { id: "s_9", requestId, status: "queued" },
  });
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, snapshot.pending);
});

test("a runtime snapshot seeds ranks for records a connection never saw", async () => {
  const base: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const scripted = scriptedHandle({ snapshot: base });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  scripted.emit({
    type: "snapshot",
    trace,
    value: {
      ...base,
      pending: [{ id: "s_4", requestId, status: "placed", entryId: "e_7" }],
    },
  });
  scripted.emit({
    type: "submission",
    trace,
    record: { id: "s_4", requestId, status: "queued" },
  });
  const expected = [{ id: "s_4", requestId, status: "placed", entryId: "e_7" }];
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, expected);
  const broadcast = received.filter((event) => event.type === "snapshot").at(-1);
  assert.deepEqual(
    broadcast?.type === "snapshot" ? broadcast.value.pending : ["unchecked"],
    expected,
  );
});

test("queued, placed and done keep one submission id and settle the pending list", async () => {
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
            status: "placed",
            entryId: "e_1",
          },
        },
        {
          type: "submission",
          trace: input.trace,
          record: {
            id: "s_1",
            requestId: input.requestId,
            status: "done",
            entryId: "e_1",
            answerEntryId: "e_2",
          },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const reply = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  const records = received.flatMap((event) => (event.type === "submission" ? [event.record] : []));
  assert.deepEqual(
    records.map((record) => [record.id, record.status]),
    [
      ["s_1", "queued"],
      ["s_1", "placed"],
      ["s_1", "done"],
    ],
    "one submission id across every status",
  );
  assert.equal(reply.id, "s_1");
  assert.equal(reply.status, "done", "the reply may already carry the settlement");

  const later: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => later.push(event));
  assert.deepEqual(
    joined.snapshot.pending,
    [],
    "a settled submission is not pending for a new joiner",
  );
  assert.deepEqual(
    later.map((event) => event.type),
    ["snapshot"],
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
test("a runtime error never fabricates a settlement", async () => {
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
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  runtime.handle("b_1").emit({
    type: "error",
    trace,
    failure: { id: "f_7f3a", kind: "task_parked", layer: "runtime" },
    message: "a task is parked",
  });
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.pending.map((record) => [record.id, record.status]),
    [["s_1", "queued"]],
    "an error does not settle the submission",
  );
  assert.deepEqual(
    received.flatMap((event) => (event.type === "submission" ? [event.record.status] : [])),
    ["queued"],
  );
});
