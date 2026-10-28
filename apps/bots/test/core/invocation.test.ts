// docs/bots/TRIGGERS.md stage 0: one bot-scoped invocation port for callers that have no
// client connection, proven against a scripted runtime before any caller exists.
import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, ConversationService } from "../../src/core/ConversationService.ts";
import type { ConversationSnapshot, Submission } from "../../src/core/domain.ts";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import { newFailure } from "../../src/core/failures.ts";
import type { InvocationOrigin } from "../../src/core/Invocation.ts";
import { INVOCATION_ID, MAX_INVOCATION_TEXT } from "../../src/core/Invocation.ts";
import type {
  RuntimeBotSpec,
  RuntimeEvent,
  RuntimeHandle,
  RuntimePort,
  SubmitInput,
} from "../../src/core/RuntimePort.ts";
import { MAX_SEND_TEXT, REQUEST_ID } from "../../src/protocol/limits.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";
const botId = "b_1";

const utf8 = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const empty = (id = botId): ConversationSnapshot => ({
  botId: id,
  messages: [],
  streaming: null,
  pending: [],
  inbox: [],
  running: false,
});

const seeds = (count: number): Submission[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `s_${index + 1}`,
    requestId: `r_seed_${index}`,
    status: "queued" as const,
  }));

const invocation = (
  overrides: {
    requestId?: string;
    text?: string;
    origin?: InvocationOrigin;
    whenBusy?: "followUp" | "steer" | "reject";
  } = {},
) => ({
  botId,
  requestId: overrides.requestId ?? requestId,
  text: overrides.text ?? "run the morning check",
  origin: overrides.origin ?? ({ kind: "webhook", triggerId: "t_9f2a1c3d04" } as const),
  ...(overrides.whenBusy === undefined ? {} : { whenBusy: overrides.whenBusy }),
  trace,
});

const deferred = (): { promise: Promise<void>; open(): void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** A runtime whose admissions are counted and can be held open. */
const scriptedRuntime = (
  options: {
    snapshot?: () => ConversationSnapshot;
    fail?: () => unknown;
    hold?: Promise<void>;
  } = {},
) => {
  const submits: SubmitInput[] = [];
  const opened: string[] = [];
  const records = new Map<string, Submission>();
  const sinks = new Map<string, (event: RuntimeEvent) => void>();
  let next = 0;
  const runtime: RuntimePort & {
    emit(bot: string, event: RuntimeEvent): void;
    readonly submits: SubmitInput[];
    readonly opened: string[];
  } = {
    submits,
    opened,
    async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
      opened.push(spec.id);
      const snapshot = options.snapshot?.() ?? empty(spec.id);
      return {
        refreshTools: async () => {},
        subscribe: async (_trace, sink) => {
          sinks.set(spec.id, sink);
          return { snapshot, detach: () => sinks.delete(spec.id) };
        },
        submit: async (input) => {
          submits.push(input);
          const failure = options.fail?.();
          if (failure !== undefined) throw failure;
          if (options.hold !== undefined) await options.hold;
          const head = records.get(input.requestId);
          const record = head ?? {
            id: `s_${++next}`,
            requestId: input.requestId,
            status: "queued" as const,
          };
          records.set(input.requestId, record);
          return record;
        },
        submission: async (key) => ("requestId" in key ? records.get(key.requestId) : undefined),
        history: async () => ({ messages: [], hasMore: false }),
        abort: async () => {},
        recover: async () => {},
        busy: async () => ({ run: false, tasks: false }),
        close: async () => "closed",
      };
    },
    emit(bot, event) {
      sinks.get(bot)?.(event);
    },
  };
  return runtime;
};

type Lease = { acquire(botId: string): boolean; release(botId: string): void };

const serviceFor = (runtime: RuntimePort, lease?: Lease) =>
  new ConversationService({
    open: (id, openTrace) =>
      runtime.open({
        id,
        dir: `/tmp/${id}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      }),
    measure: utf8,
    ...(lease === undefined
      ? {}
      : { lease: { acquire: (id) => lease.acquire(id), release: lease.release } }),
  });

/** Refusals arrive as `CommandError` from core and as `ClassifiedFailure` from a runtime. */
const refuses = (kind: string, disposition: string) => (error: unknown) => {
  if (error instanceof CommandError) {
    return error.kind === kind && error.disposition === disposition;
  }
  if (error instanceof ClassifiedFailure) {
    return error.failure.kind === kind && error.disposition === disposition;
  }
  return false;
};

const status = (running: boolean): RuntimeEvent => ({
  type: "status",
  trace,
  running,
  streaming: null,
  inbox: [],
});

test("the invocation id and text cap mirror the wire contract", () => {
  assert.equal(INVOCATION_ID.source, REQUEST_ID.source, "one id alphabet for both entries");
  assert.equal(MAX_INVOCATION_TEXT, MAX_SEND_TEXT, "one send budget for both entries");
  assert.equal(INVOCATION_ID.test(requestId), true);
  assert.equal(INVOCATION_ID.test("short"), false);
});

test("the same request id admits once, without a connection", async () => {
  const runtime = scriptedRuntime();
  const service = serviceFor(runtime);
  const first = await service.invoke(invocation());
  const second = await service.invoke(invocation());
  assert.deepEqual(second, first, "a repeat returns the stored record");
  assert.equal(runtime.submits.length, 1, "the runtime saw one admission");
  assert.deepEqual(runtime.opened, [botId], "an invocation opens the bot without a subscribe");
});

test("the internal view is live without a subscriber, so a later baseline has the entry", async () => {
  const runtime = scriptedRuntime();
  const service = serviceFor(runtime);
  await service.invoke(invocation());
  runtime.emit(botId, {
    type: "append",
    trace,
    message: {
      id: "e_1",
      role: "user",
      state: "complete",
      createdAt: "2026-10-28T00:00:00.000Z",
      blocks: [{ type: "text", text: "run the morning check" }],
    },
  });
  const received: HubEvent[] = [];
  const joined = await service.subscribe("c_1", botId, trace, (event) => received.push(event));
  assert.deepEqual(
    joined.snapshot.messages.map((message) => message.id),
    ["e_1"],
    "the bot's own view carried the commit, which only a self-ready view does",
  );
});

test("a full admission budget refuses not_admitted instead of opening a run", async () => {
  const full = scriptedRuntime({ snapshot: () => ({ ...empty(), pending: seeds(32) }) });
  await assert.rejects(
    () => serviceFor(full).invoke(invocation()),
    refuses("limit_exceeded", "not_admitted"),
  );
  assert.equal(full.submits.length, 0);

  const room = scriptedRuntime({ snapshot: () => ({ ...empty(), pending: seeds(31) }) });
  const record = await serviceFor(room).invoke(invocation());
  assert.equal(record.status, "queued");
  assert.equal(room.submits.length, 1);
});

test("a settled key answers from the record even when the budget is full", async () => {
  // The lookup runs before the budget check, so a restart can never turn a duplicate into
  // a refusal: the adapter's durable lookup is what makes that record visible.
  const settled: Submission = { id: "s_9", requestId, status: "done" };
  const runtime = scriptedRuntime({ snapshot: () => ({ ...empty(), pending: seeds(32) }) });
  const original = runtime.open.bind(runtime);
  runtime.open = async (spec: RuntimeBotSpec): Promise<RuntimeHandle> => {
    const handle = await original(spec);
    return { ...handle, submission: async () => settled };
  };
  const record = await serviceFor(runtime).invoke(invocation());
  assert.deepEqual(record, settled, "the stored record wins over a full budget");
  assert.equal(runtime.submits.length, 0, "nothing new was admitted");
});

test("a busy refusal keeps the caller's key usable for the retry", async () => {
  let busy = true;
  const runtime = scriptedRuntime({
    fail: () =>
      busy
        ? new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "the bot is busy")
        : undefined,
  });
  const service = serviceFor(runtime);
  await assert.rejects(
    () => service.invoke(invocation()),
    refuses("limit_exceeded", "not_admitted"),
  );
  busy = false;
  const record = await service.invoke(invocation());
  assert.equal(record.requestId, requestId);
  assert.deepEqual(
    runtime.submits.map((submit) => submit.requestId),
    [requestId, requestId],
    "the retry repeats the key rather than minting a new one",
  );
});

test("an unknown bot refuses before the runtime is reached", async () => {
  const service = new ConversationService({
    open: () => {
      throw new ClassifiedFailure(newFailure("unknown_bot"), "not_admitted", "unknown bot");
    },
    measure: utf8,
  });
  await assert.rejects(() => service.invoke(invocation()), refuses("unknown_bot", "not_admitted"));
  assert.deepEqual(await service.submission({ botId, requestId }).catch(() => "threw"), "threw");
});

test("observe reports the current run and its edges, then detaches", async () => {
  const runtime = scriptedRuntime();
  const service = serviceFor(runtime);
  await service.invoke(invocation());
  runtime.emit(botId, status(true));

  const seen: boolean[] = [];
  const handle = service.observe(botId, (running) => seen.push(running));
  assert.deepEqual(seen, [true], "attach reports the current value, not the next edge");

  runtime.emit(botId, status(false));
  assert.deepEqual(seen, [true, false]);

  handle.detach();
  runtime.emit(botId, status(true));
  assert.deepEqual(seen, [true, false], "a detached observer receives nothing");

  const idle: boolean[] = [];
  const other = service.observe("b_never_opened", (running) => idle.push(running));
  assert.deepEqual(idle, [false], "an unopened bot is not running");
  assert.equal(runtime.opened.includes("b_never_opened"), false, "observe never opens a bot");
  other.detach();
});

test("an invocation holds a balanced lease on success, refusal and a throw", async () => {
  const leases = { acquire: 0, release: 0 };
  const lease: Lease = {
    acquire: () => {
      leases.acquire += 1;
      return true;
    },
    release: () => {
      leases.release += 1;
    },
  };

  await serviceFor(scriptedRuntime(), lease).invoke(invocation());
  assert.deepEqual(leases, { acquire: 1, release: 1 });

  const throwing = scriptedRuntime({
    fail: () => new ClassifiedFailure(newFailure("storage_failed"), "runtime", "boom"),
  });
  await assert.rejects(() => serviceFor(throwing, lease).invoke(invocation()));
  assert.deepEqual(leases, { acquire: 2, release: 2 }, "a throw still releases");

  const refusing = scriptedRuntime({
    fail: () => new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "busy"),
  });
  await assert.rejects(() => serviceFor(refusing, lease).invoke(invocation()));
  assert.deepEqual(leases, { acquire: 3, release: 3 }, "a refusal still releases");

  const denied = serviceFor(scriptedRuntime(), {
    acquire: () => false,
    release: lease.release,
  });
  await assert.rejects(() => denied.invoke(invocation()), refuses("unknown_bot", "not_admitted"));
  assert.deepEqual(leases, { acquire: 3, release: 3 }, "a refused lease is never released");
});

test("a malformed key, an oversized text and a non-human steer never reach the runtime", async () => {
  const runtime = scriptedRuntime();
  const service = serviceFor(runtime);
  await assert.rejects(
    () => service.invoke(invocation({ requestId: "short" })),
    refuses("invalid_command", "not_admitted"),
  );
  await assert.rejects(
    () => service.invoke(invocation({ text: "x".repeat(MAX_INVOCATION_TEXT + 1) })),
    refuses("invalid_command", "not_admitted"),
  );
  await assert.rejects(
    () => service.invoke(invocation({ whenBusy: "steer" })),
    refuses("invalid_command", "not_admitted"),
  );
  assert.equal(runtime.submits.length, 0);
  assert.equal(runtime.opened.length, 0, "validation happens before any open");
});

test("human sends and invocations share one admission chain per bot", async () => {
  const runtime = scriptedRuntime({ snapshot: () => ({ ...empty(), pending: seeds(30) }) });
  const service = serviceFor(runtime);
  await service.subscribe("c_1", botId, trace, () => {});
  const [sent, invoked] = await Promise.all([
    service.send("c_1", { requestId: "r_human_1", text: "hello", whenBusy: "followUp", trace }),
    service.invoke(invocation({ requestId: "r_trigger_1" })),
  ]);
  assert.deepEqual(
    [sent.requestId, invoked.requestId],
    ["r_human_1", "r_trigger_1"],
    "both admissions answered, neither lost",
  );
  assert.equal(runtime.submits.length, 2);
});

test("drain refuses new work and resolves after the admission in flight", async () => {
  const hold = deferred();
  const runtime = scriptedRuntime({ hold: hold.promise });
  const service = serviceFor(runtime);
  const admitted = service.invoke(invocation({ requestId: "r_inflight_1" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.submits.length, 1, "the first admission reached the runtime and is held");

  const drained = service.drain();
  await assert.rejects(
    () => service.invoke(invocation({ requestId: "r_during_drain" })),
    refuses("internal", "not_admitted"),
  );

  let settled = false;
  void drained.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, "drain waits for the admission already in flight");

  hold.open();
  await admitted;
  await drained;
  assert.equal(settled, true);
});

test("a human send still refuses without a subscription, as before", async () => {
  const runtime = scriptedRuntime();
  const service = serviceFor(runtime);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    refuses("invalid_command", "not_admitted"),
  );
  assert.equal(runtime.opened.length, 0);
});

test("submission answers by request id for a bot opened by an invocation", async () => {
  const runtime = scriptedRuntime();
  const service = serviceFor(runtime);
  const record = await service.invoke(invocation());
  assert.deepEqual(await service.submission({ botId, requestId }), record);
  assert.equal(await service.submission({ botId, requestId: "r_unknown_1" }), undefined);
});
