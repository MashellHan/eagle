// The pi-durable adapter (docs/bots/RUNTIME.md). It owns one Harness per bot, the
// submission ledger, the close deadline and the failure classification; it owns no
// catalog, no transport and no revision.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type AgentEventStream,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  Harness as HarnessFactory,
  type ReportInfo,
  type SessionEnd,
  type Storage,
  type WatchEnd,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ConversationSnapshot, Message, Submission } from "../../core/domain.ts";
import { ClassifiedFailure } from "../../core/domain.ts";
import type {
  RuntimeBotSpec,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeHistory,
  RuntimePort,
  RuntimeSubscription,
  SubmitInput,
} from "../../core/RuntimePort.ts";
import { type DeclaredEvent, declareEvent } from "../../log/events.ts";
import type { Log } from "../../log/log.ts";
import { FailureClassifier, type Minted } from "./classify.ts";
import { entryMessageId } from "./convert.ts";
import { convertSubmission, EventMapper } from "./mapEvents.ts";
import { createPhaseOneRegistry } from "./registry.ts";

const Events = {
  openStart: declareEvent("runtime.open.start"),
  openOk: declareEvent("runtime.open.ok"),
  openFail: declareEvent("runtime.open.fail"),
  subscribeStart: declareEvent("runtime.subscribe.start"),
  subscribeOk: declareEvent("runtime.subscribe.ok"),
  subscribeFail: declareEvent("runtime.subscribe.fail"),
  submitStart: declareEvent("runtime.submit.start"),
  submitOk: declareEvent("runtime.submit.ok"),
  submitFail: declareEvent("runtime.submit.fail"),
  abortStart: declareEvent("runtime.abort.start"),
  abortOk: declareEvent("runtime.abort.ok"),
  abortFail: declareEvent("runtime.abort.fail"),
  recoverStart: declareEvent("runtime.recover.start"),
  recoverOk: declareEvent("runtime.recover.ok"),
  recoverFail: declareEvent("runtime.recover.fail"),
  closeStart: declareEvent("runtime.close.start"),
  closeOk: declareEvent("runtime.close.ok"),
  closeFail: declareEvent("runtime.close.fail"),
  watchEndOk: declareEvent("runtime.watch.end.ok"),
  classify: declareEvent("runtime.failure.classify"),
  piReport: declareEvent("pi.report"),
  piSessionClosed: declareEvent("pi.session.closed"),
} as const;

/** The subset of `HarnessSettings` the adapter decides; pi fills in the rest. */
export type PiSettings = {
  readonly stream?: { readonly timeoutMs?: number; readonly deferred?: boolean };
  readonly retry?: { readonly maxRetries?: number };
  readonly compaction?: { readonly enabled?: boolean };
  readonly progress?: { readonly partialIntervalMs?: number };
  readonly restartLimit?: number;
};

const DEFAULT_SETTINGS: PiSettings = {
  stream: { timeoutMs: 120_000 },
  retry: { maxRetries: 3 },
  // F16: a compacting bot looks idle to the close condition, so phase 1 keeps it off.
  compaction: { enabled: false },
  progress: { partialIntervalMs: 100 },
  restartLimit: 5,
};

/** Entry ids cross as `e_<n>` on the wire and as `<n>` inside pi. */
const piEntryId = (domainId: string): EntryId => Number(domainId.replace(/^e_/, "")) as EntryId;

const defaultStorage = (path: string): Promise<Storage> => openNodeSqliteStorage(path);

export type PiRuntimeOptions = {
  /** One `Models` for the process; a provider swap needs no reopen (F19). */
  readonly models: Models | (() => Models);
  readonly log: Log;
  /** Storage factory, real sqlite by default. Fault injection goes through it. */
  readonly storage?: (path: string) => Promise<Storage>;
  /** Settings per bot; never shared between bots (F19). */
  readonly settings?: (spec: RuntimeBotSpec) => PiSettings;
  readonly now?: () => number;
  readonly clock?: () => Date;
  readonly windowMessages?: number;
  readonly maxMessageBytes?: number;
};

export class PiDurableRuntime implements RuntimePort {
  readonly #options: PiRuntimeOptions;

  constructor(options: PiRuntimeOptions) {
    this.#options = options;
  }

  async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
    const log = this.#options.log;
    const started = performance.now();
    log.emit("info", "runtime", Events.openStart, { trace: spec.trace, botId: spec.id });
    const classifier = new FailureClassifier({ now: this.#options.now ?? Date.now });
    let handle: PiRuntimeHandle | undefined;
    // A park discovered by `open()`'s recovery has no handle yet, so its report is
    // buffered and replayed rather than dropped.
    const pending: ReportInfo[] = [];
    try {
      const storage = await (this.#options.storage ?? defaultStorage)(
        join(spec.dir, "session.sqlite"),
      );
      const harness = await HarnessFactory.open(
        storage,
        {
          models: this.#options.models,
          registry: createPhaseOneRegistry(),
          settings: { ...DEFAULT_SETTINGS, ...this.#options.settings?.(spec) } as never,
          onReport: (_error, info) => {
            if (handle === undefined) pending.push(info);
            else handle.report(info);
          },
        },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: spec.model.provider, modelId: spec.model.modelId } },
      });
      handle = new PiRuntimeHandle({
        spec,
        harness,
        rootId: root.id,
        classifier,
        options: this.#options,
      });
      harness.closed.then((end) => handle?.sessionEnd(end));
      for (const info of pending.splice(0)) handle.report(info);
      // `open()` already recovered; resuming only enables scheduling (RUNTIME.md).
      harness.resume();
    } catch (cause) {
      const minted = classifier.classify("open", "storage_failed", "runtime");
      log.emit("error", "runtime", Events.openFail, {
        trace: spec.trace,
        botId: spec.id,
        failure: minted.classification.failure,
        origin: true,
        durMs: Math.round(performance.now() - started),
      });
      throw new ClassifiedFailure(
        minted.classification.failure,
        "runtime",
        minted.classification.message,
        { cause },
      );
    }
    log.emit("info", "runtime", Events.openOk, {
      trace: spec.trace,
      botId: spec.id,
      durMs: Math.round(performance.now() - started),
    });
    return handle;
  }
}

/** One logical subscription: the sink stays, the stream behind it is replaced on reattach. */
type Subscription = {
  readonly sink: (event: RuntimeEvent) => void;
  /** Episode key of the current stream: both notifications of one fault share it. */
  episode: string;
  stream?: AgentEventStream;
  detached: boolean;
};

type HandleOptions = {
  readonly spec: RuntimeBotSpec;
  readonly harness: Harness;
  readonly rootId: ConversationId;
  readonly classifier: FailureClassifier;
  readonly options: PiRuntimeOptions;
};

class PiRuntimeHandle implements RuntimeHandle {
  readonly #spec: RuntimeBotSpec;
  readonly #harness: Harness;
  readonly #rootId: ConversationId;
  readonly #classifier: FailureClassifier;
  readonly #options: PiRuntimeOptions;
  readonly #mapper: EventMapper;
  /** One logical subscription per sink, holding whichever stream is current. */
  readonly #subscriptions = new Map<(event: RuntimeEvent) => void, Subscription>();
  /** Failure identities already announced: the channels double-report one episode. */
  readonly #announced = new Set<string>();
  /** Failures that happened before anyone was listening, delivered on the first subscribe. */
  readonly #undelivered: Extract<RuntimeEvent, { type: "error" }>[] = [];
  /** Submission ledger: both ids resolve, and settlement does not remove the entry. */
  readonly #submissionIds = new Map<string, string>();
  /** The reverse edge, so an id found in a snapshot can be resolved to its send. */
  readonly #requestIds = new Map<string, string>();
  readonly #traces = new Map<string, string>();
  /** Admitted submissions no run has claimed yet: one of them owns pre-run progress. */
  readonly #unclaimed = new Set<string>();
  /** Sends whose admission is still in flight: the first of them owns the commits it makes. */
  readonly #admitting: string[] = [];
  #runTrace: string | undefined;
  /** The submission id of a run whose send is not yet known, when one is waiting. */
  #unresolvedRun: string | undefined;
  /** Episode key of the current stream, shared by that fault's two notifications. */
  #currentEpisode = "listener:0";
  #watchSequence = 0;
  #closing: Promise<void> | undefined;
  #resubscribed = false;

  constructor(options: HandleOptions) {
    this.#spec = options.spec;
    this.#harness = options.harness;
    this.#rootId = options.rootId;
    this.#classifier = options.classifier;
    this.#options = options.options;
    this.#mapper = new EventMapper({
      botId: options.spec.id,
      now: options.options.clock ?? (() => new Date()),
      ...(options.options.windowMessages === undefined
        ? {}
        : { windowMessages: options.options.windowMessages }),
      ...(options.options.maxMessageBytes === undefined
        ? {}
        : { maxMessageBytes: options.options.maxMessageBytes }),
    });
  }

  /** The committed view without publishing anything. */
  snapshot(): ConversationSnapshot {
    return this.#mapper.view();
  }

  async subscribe(
    trace: string,
    sink: (event: RuntimeEvent) => void,
  ): Promise<RuntimeSubscription> {
    const log = this.#options.log;
    const started = performance.now();
    log.emit("info", "runtime", Events.subscribeStart, { trace, botId: this.#spec.id });
    const state: Subscription = {
      sink,
      detached: false,
      episode: `listener:${++this.#watchSequence}`,
    };
    this.#currentEpisode = state.episode;
    this.#subscriptions.set(sink, state);
    try {
      const snapshot = await this.#acquire(state, trace, { deferDelivery: true });
      this.#flushUndelivered(state);
      log.emit("info", "runtime", Events.subscribeOk, {
        trace,
        botId: this.#spec.id,
        durMs: Math.round(performance.now() - started),
        detail: { reattach: this.#resubscribed },
      });
      this.#resubscribed = true;
      return {
        snapshot,
        detach: () => {
          state.detached = true;
          this.#subscriptions.delete(sink);
          void state.stream?.stop();
        },
      };
    } catch (cause) {
      this.#subscriptions.delete(sink);
      const minted = this.#classifier.classify("subscribe", "internal", "runtime");
      this.#logFailure(minted, trace, Events.subscribeFail, "runtime");
      throw new ClassifiedFailure(
        minted.classification.failure,
        "runtime",
        minted.classification.message,
        { cause },
      );
    }
  }

  async submit(input: SubmitInput): Promise<Submission> {
    const log = this.#options.log;
    const started = performance.now();
    // The admission commit can be published before `submit` returns, so the request id
    // knows its trace first; the submission id is filled in once it exists.
    this.#traces.set(input.requestId, input.trace);
    this.#admitting.push(input.trace);
    log.emit("info", "runtime", Events.submitStart, {
      trace: input.trace,
      botId: this.#spec.id,
      reqId: input.requestId,
    });
    try {
      const root = await this.#harness.root(BACKGROUND_CONTEXT);
      const admitted = await root.submit(
        {
          type: "input",
          content: input.text,
          requestId: input.requestId,
          whenBusy: input.whenBusy,
        },
        BACKGROUND_CONTEXT,
      );
      // F24: admission starts the run, so the record read here can already be `done`.
      const record = await admitted.status(BACKGROUND_CONTEXT);
      this.#mapper.observe(record);
      this.#submissionIds.set(input.requestId, String(record.id));
      this.#submissionIds.set(String(record.id), String(record.id));
      this.#requestIds.set(String(record.id), input.requestId);
      this.#traces.set(input.requestId, input.trace);
      this.#traces.set(String(record.id), input.trace);
      this.#unclaimed.add(String(record.id));
      // A run that started before its admission record existed is waiting for this id;
      // a settled duplicate belongs to no run and must not adopt one.
      if (this.#unresolvedRun === String(record.id)) {
        this.#runTrace = input.trace;
        this.#unresolvedRun = undefined;
      }
      const converted = convertSubmission(record);
      if (converted === undefined) {
        throw new ClassifiedFailure(
          this.#classifier.classify("submit:write", "internal", "runtime").classification.failure,
          "unknown",
          "the admitted input produced no record",
        );
      }
      log.emit("info", "runtime", Events.submitOk, {
        trace: input.trace,
        botId: this.#spec.id,
        reqId: input.requestId,
        durMs: Math.round(performance.now() - started),
        detail: { queued: converted.status === "queued", count: 1 },
      });
      return converted;
    } catch (cause) {
      if (cause instanceof ClassifiedFailure) throw cause;
      const busy = cause instanceof Error && cause.name === "ConversationBusy";
      const minted = busy
        ? this.#classifier.refusedBusy()
        : (this.#classifier.sessionEpisode() ?? this.#classifier.submitFailed(cause));
      this.#logFailure(minted, input.trace, Events.submitFail, "runtime");
      throw new ClassifiedFailure(
        minted.classification.failure,
        busy ? "not_admitted" : "unknown",
        minted.classification.message,
        { cause },
      );
    } finally {
      const at = this.#admitting.indexOf(input.trace);
      if (at !== -1) this.#admitting.splice(at, 1);
    }
  }

  /**
   * Resolves by either id. A settled input is gone from the live inspection list, so the
   * ledger carries `requestId → submissionId` and pi reacquires the record by id (F12).
   */
  async submission(
    key: { submissionId: string } | { requestId: string },
  ): Promise<Submission | undefined> {
    const id = "submissionId" in key ? key.submissionId : this.#submissionIds.get(key.requestId);
    if (id !== undefined) {
      const found = await this.#harness.submission(Number(id) as never, BACKGROUND_CONTEXT);
      if (found !== undefined) {
        const record = await found.status(BACKGROUND_CONTEXT);
        return convertSubmission(record as never);
      }
    }
    if ("submissionId" in key) return undefined;
    const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
    const record = inspection.submissions.find((item) => item.requestId === key.requestId);
    return record === undefined ? undefined : convertSubmission(record);
  }

  /** Older messages, oldest first; the newest window is not re-fetched. */
  async history(input: { beforeEntryId?: string; limit: number }): Promise<RuntimeHistory> {
    try {
      return await this.#history(input);
    } catch (cause) {
      if (cause instanceof ClassifiedFailure) throw cause;
      const minted = this.#classifier.classify("history", "storage_failed", "runtime");
      this.#logFailure(minted, this.#spec.trace, Events.classify, "runtime");
      throw new ClassifiedFailure(
        minted.classification.failure,
        "runtime",
        minted.classification.message,
        {
          cause,
        },
      );
    }
  }

  async #history(input: { beforeEntryId?: string; limit: number }): Promise<RuntimeHistory> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    const before = input.beforeEntryId;
    const collected: Message[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await root.entries(
        {
          order: "descending",
          ...(before === undefined || cursor !== undefined
            ? {}
            : { maxEntryId: piEntryId(before) }),
        },
        input.limit + 2,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        const message = this.#mapper.entryMessage(entry);
        // Hidden entries (a tool result, a system prompt) must not count against the page.
        if (message === undefined || message.id === before) continue;
        collected.push(message);
        if (collected.length > input.limit) break;
      }
      if (collected.length > input.limit) break;
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const hasMore = collected.length > input.limit;
    return { messages: collected.slice(0, input.limit).reverse(), hasMore };
  }

  async abort(trace: string): Promise<void> {
    const log = this.#options.log;
    log.emit("info", "runtime", Events.abortStart, { trace, botId: this.#spec.id });
    try {
      const root = await this.#harness.root(BACKGROUND_CONTEXT);
      await root.abort(BACKGROUND_CONTEXT);
      log.emit("info", "runtime", Events.abortOk, {
        trace,
        botId: this.#spec.id,
        detail: { finished: "aborted" },
      });
    } catch (cause) {
      const minted = this.#classifier.classify("abort", "internal", "runtime");
      this.#logFailure(minted, trace, Events.abortFail, "runtime");
      throw new ClassifiedFailure(
        minted.classification.failure,
        "runtime",
        minted.classification.message,
        { cause },
      );
    }
  }

  /** Retries parked tasks; a running answer is never touched (RUNTIME.md, "Recovery"). */
  async recover(trace: string): Promise<void> {
    const log = this.#options.log;
    log.emit("info", "runtime", Events.recoverStart, { trace, botId: this.#spec.id });
    try {
      const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
      let retried = 0;
      for (const task of inspection.tasks) {
        if (task.state.kind !== "blocked" || task.state.reason !== "restart_limit") continue;
        await this.#harness.retryTask(task.record.id as never, BACKGROUND_CONTEXT);
        retried += 1;
      }
      log.emit("info", "runtime", Events.recoverOk, {
        trace,
        botId: this.#spec.id,
        detail: { count: retried },
      });
    } catch (cause) {
      const minted = this.#classifier.classify("recover", "internal", "runtime");
      this.#logFailure(minted, trace, Events.recoverFail, "runtime");
      throw new ClassifiedFailure(
        minted.classification.failure,
        "runtime",
        minted.classification.message,
        { cause },
      );
    }
  }

  async busy(): Promise<{ run: boolean; tasks: boolean }> {
    const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
    return { run: inspection.submissions.length > 0, tasks: inspection.tasks.length > 0 };
  }

  /** Resolves `timeout` without dropping the handle: the close keeps joining. */
  async close(trace: string, deadlineMs: number): Promise<"closed" | "timeout"> {
    const log = this.#options.log;
    log.emit("info", "runtime", Events.closeStart, { trace, botId: this.#spec.id });
    this.#closing ??= this.#harness.close(BACKGROUND_CONTEXT);
    const closing = this.#closing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deadlineMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([closing.then(() => "closed" as const), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "timeout") {
      // A close that did not finish is a failure, not a success: the handle stays owned
      // by the registry, which quarantines the bot (ARCHITECTURE.md, "Bot lifecycle").
      log.emit("warn", "runtime", Events.closeFail, {
        trace,
        botId: this.#spec.id,
        failure: {
          id: `f_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          kind: "internal",
          layer: "runtime",
        },
        detail: { reason: "timeout" },
      });
      return outcome;
    }
    log.emit("info", "runtime", Events.closeOk, {
      trace,
      botId: this.#spec.id,
      detail: { quarantined: false },
    });
    return outcome;
  }

  /** `harness.closed`: a close we asked for is not a failure, a failed session is. */
  sessionEnd(end: SessionEnd): void {
    const minted = this.#classifier.sessionEnd(end);
    if (minted === undefined) return;
    this.#logFailure(minted, this.#spec.trace, Events.piSessionClosed, "pi");
    this.#announce({
      type: "error",
      trace: this.#spec.trace,
      failure: minted.classification.failure,
      message: minted.classification.message,
    });
  }

  /** `HarnessOptions.onReport`, off the Session line; the channel never mints by itself. */
  report(info: ReportInfo): void {
    const minted = this.#classifier.report(info, this.#currentEpisode);
    const trace = this.#runTrace ?? this.#spec.trace;
    const log = this.#options.log;
    if (minted === undefined) {
      log.emit("warn", "pi", Events.piReport, {
        trace,
        botId: this.#spec.id,
        detail: { kind: info.type },
      });
      return;
    }
    this.#logFailure(minted, trace, Events.piReport, "pi");
    const task = "task" in info ? info.task : undefined;
    this.#announce({
      type: "error",
      trace,
      failure: minted.classification.failure,
      message: minted.classification.message,
      ...(task === undefined ? {} : { taskId: String(task.id) }),
    });
  }

  /**
   * Acquires a watch, hands over its baseline and only then delivers live commits.
   * Delivery opens after the caller has the baseline: for a first subscription that
   * means the next macrotask, because the caller applies the returned snapshot right
   * after its `await`. A sink that throws while the baseline or the buffer is being
   * delivered is one lost listener episode, exactly like one that throws on a live batch.
   */
  async #acquire(
    state: Subscription,
    trace: string,
    options: {
      readonly deliverBaseline?: (snapshot: ConversationSnapshot) => void;
      readonly deferDelivery?: boolean;
    } = {},
  ): Promise<ConversationSnapshot> {
    // Read before the acquisition: a record set that is slightly older can only describe
    // work the snapshot still names, while one read afterwards can already have lost it.
    const active = await this.#activeRecords();
    const stream = await watchEvents(this.#harness, this.#rootId, BACKGROUND_CONTEXT);
    let ready = false;
    const buffered: (readonly AgentEvent[])[] = [];
    stream.start(async (batch) => {
      if (!ready) {
        buffered.push(batch);
        return;
      }
      await this.#consumeGuarded(state, batch, trace);
    });
    const records = await this.#namedRecords(stream.snapshot, active);
    for (const record of records) this.#rememberId(record);
    const baseline = this.#mapper.seed(stream.snapshot, trace, records)[0];
    const snapshot =
      baseline !== undefined && baseline.type === "snapshot" ? baseline.value : this.#mapper.view();
    this.#resumeRunTrace(stream.snapshot);
    if (state.stream !== undefined) void state.stream.stop();
    state.stream = stream;
    stream.closed.then((end) => this.#watchEnd(end, trace, state));
    try {
      options.deliverBaseline?.(snapshot);
    } catch {
      this.#listenerFault(state, trace);
      return snapshot;
    }
    const open = (): void => {
      if (state.detached || state.stream !== stream) return;
      ready = true;
      void (async () => {
        for (const batch of buffered.splice(0)) {
          if (!(await this.#consumeGuarded(state, batch, trace))) return;
        }
      })();
    };
    if (options.deferDelivery === true) setImmediate(open);
    else open();
    return snapshot;
  }

  /** Records the live submissions, so a cold start can describe the work it inherits. */
  async #activeRecords(): Promise<Submission[]> {
    const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
    return inspection.submissions
      .map((record) => convertSubmission(record))
      .filter((record): record is Submission => record !== undefined);
  }

  /**
   * Completes the record set for the ids a snapshot names. Work admitted between the
   * record read and the acquisition is named by the snapshot but absent from the earlier
   * read, so each missing id is read again. A record that settled while the projection
   * was being prepared still describes work the snapshot called active, so it keeps the
   * status the snapshot implies (a run input is placed, an inbox item is queued) instead
   * of vanishing; the next settlement event moves it up, and it is never downgraded.
   */
  async #namedRecords(
    snapshot: {
      readonly run?: { readonly inputs: readonly unknown[] };
      readonly inbox: readonly { readonly id: unknown }[];
    },
    known: readonly Submission[],
  ): Promise<Submission[]> {
    const have = new Set(known.map((record) => record.id));
    const named = [
      ...(snapshot.run?.inputs ?? []).map((id) => String(id)),
      ...snapshot.inbox.map((item) => String(item.id)),
    ];
    const inRun = new Set((snapshot.run?.inputs ?? []).map((id) => String(id)));
    const completed = [...known];
    for (const id of named) {
      if (have.has(id)) continue;
      have.add(id);
      const found = await this.#harness.submission(Number(id) as never, BACKGROUND_CONTEXT);
      if (found === undefined) continue;
      const record = convertSubmission(await found.status(BACKGROUND_CONTEXT));
      if (record === undefined) continue;
      if (record.status === "queued" || record.status === "placed") {
        completed.push(record);
        continue;
      }
      completed.push(
        inRun.has(id)
          ? {
              id: record.id,
              requestId: record.requestId,
              status: "placed",
              ...(record.entryId === undefined ? {} : { entryId: record.entryId }),
            }
          : { id: record.id, requestId: record.requestId, status: "queued" },
      );
    }
    return completed;
  }

  /** A run interrupted by a reconnect keeps the trace of the send that started it. */
  #resumeRunTrace(snapshot: { readonly run?: { readonly inputs: readonly unknown[] } }): void {
    const first = snapshot.run?.inputs[0];
    if (first === undefined) return;
    const id = String(first);
    const requestId = this.#requestIds.get(id);
    const own =
      this.#traces.get(id) ?? (requestId === undefined ? undefined : this.#traces.get(requestId));
    if (own !== undefined) this.#runTrace = own;
    else this.#unresolvedRun = id;
  }

  /** Delivers one batch; a throw is a lost listener, never a silent subscription. */
  async #consumeGuarded(
    state: Subscription,
    batch: readonly AgentEvent[],
    trace: string,
  ): Promise<boolean> {
    try {
      await this.#consume(state, batch, trace);
      return true;
    } catch {
      this.#listenerFault(state, trace);
      return false;
    }
  }

  /** Classifies one listener episode, then either escalates or reattaches. */
  #listenerFault(state: Subscription, trace: string): void {
    // The failing stream is isolated first: it must not deliver into a subscriber that
    // is about to receive a fresh baseline, or the same answer would arrive twice.
    void state.stream?.stop();
    const minted = this.#classifier.listenerError(state.episode);
    this.#options.log.emit("warn", "runtime", Events.watchEndOk, {
      trace,
      botId: this.#spec.id,
      detail: { reason: "listener_error" },
      ...(minted === undefined ? {} : { failure: minted.classification.failure }),
    });
    if (minted !== undefined) {
      this.#logFailure(minted, trace, Events.watchEndOk, minted.classification.failure.layer);
      this.#announce({
        type: "error",
        trace,
        failure: minted.classification.failure,
        message: minted.classification.message,
      });
      return;
    }
    this.#reattach(state, trace);
  }

  async #consume(state: Subscription, batch: readonly AgentEvent[], trace: string): Promise<void> {
    // A user entry is published before the record that names its send, so attribute the
    // whole batch first and then map it.
    const byEntry = new Map<string, string>();
    for (const event of batch) {
      if (event.type !== "submission") continue;
      const record = convertSubmission(event.record);
      this.#rememberId(record);
      const own = this.#traceOf(event.record.id, event.record.requestId);
      if (own !== undefined && record?.entryId !== undefined) byEntry.set(record.entryId, own);
    }
    // A snapshot names work but cannot describe it: read the records it names first.
    let active = batch.some((event) => event.type === "snapshot")
      ? await this.#activeRecords()
      : [];
    for (const event of batch) {
      if (event.type === "snapshot") active = await this.#namedRecords(event, active);
    }
    for (const record of active) this.#rememberId(record);
    for (const event of batch) {
      for (const mapped of this.#mapOne(event, trace, byEntry, active)) {
        this.#deliver(state, mapped);
      }
    }
    // The commit belongs to the run it ends, including the settlement that follows
    // `run_end` in the same batch; a run that starts in this batch sets its own trace.
    const started = batch.some((event) => event.type === "run_start");
    if (!started && batch.some((event) => event.type === "run_end")) this.#runTrace = undefined;
  }

  #traceOf(submissionId: unknown, requestId?: string): string | undefined {
    const byId = this.#traces.get(String(submissionId));
    if (byId !== undefined) return byId;
    return requestId === undefined ? undefined : this.#traces.get(requestId);
  }

  #deliver(state: Subscription, event: RuntimeEvent): void {
    if (state.detached) return;
    state.sink(event);
  }

  #watchEnd(end: WatchEnd, trace: string, state: Subscription): void {
    const minted = this.#classifier.watchEnd(end, state.episode);
    this.#options.log.emit("warn", "runtime", Events.watchEndOk, {
      trace,
      botId: this.#spec.id,
      detail: { reason: watchReason(end) },
      ...(minted === undefined ? {} : { failure: minted.classification.failure, propagated: true }),
    });
    if (minted !== undefined) {
      // An escalated listener is a runtime failure; a failed session belongs to pi.
      const layer = minted.classification.failure.layer;
      this.#logFailure(minted, trace, layer === "pi" ? Events.piReport : Events.watchEndOk, layer);
      this.#announce({
        type: "error",
        trace,
        failure: minted.classification.failure,
        message: minted.classification.message,
      });
      return;
    }
    // A listener error and a retired watch are recoverable: reattach, and let the
    // classifier escalate only at the third episode inside a minute.
    if (end.reason === "listener_error" || end.reason === "retired") {
      this.#reattach(state, trace);
    }
  }

  /** Reacquires the watch and hands the subscriber the fresh baseline the port promises. */
  #reattach(state: Subscription, trace: string): void {
    if (state.detached) return;
    state.episode = `listener:${++this.#watchSequence}`;
    this.#currentEpisode = state.episode;
    void this.#acquire(state, trace, {
      // Handed over before any buffered commit, so a subscriber that missed frames can
      // never have an older snapshot replace a newer one.
      deliverBaseline: (snapshot) =>
        this.#deliver(state, { type: "snapshot", trace, value: snapshot }),
    }).catch(() => undefined);
  }

  /**
   * The trace that owns an event: the send behind its own submission, else the send that
   * started the run, else the connection watching it.
   */
  #traceFor(
    event: AgentEvent,
    trace: string,
    byEntry: ReadonlyMap<string, string>,
    active: readonly Submission[] = [],
  ): string {
    if (event.type === "submission") {
      const own = this.#traceOf(event.record.id, event.record.requestId);
      if (own !== undefined) return own;
    }
    if (event.type === "run_start") {
      for (const input of event.inputs) this.#unclaimed.delete(String(input));
      const first = event.inputs[0];
      const own = first === undefined ? undefined : this.#traces.get(String(first));
      if (own !== undefined) {
        this.#runTrace = own;
        this.#unresolvedRun = undefined;
        return own;
      }
      // Its admission record has not been written yet: the submit that owns this run
      // supplies the trace as soon as the id exists.
      this.#unresolvedRun = first === undefined ? undefined : String(first);
    }
    if (event.type === "message_end") {
      const own = byEntry.get(entryMessageId(event.entry.id));
      if (own !== undefined) return own;
    }
    if (this.#runTrace !== undefined) return this.#runTrace;
    // `run_start` may not have named the run yet (a placement or queue change can arrive
    // first). While exactly one send is in flight, that send owns the progress it caused
    // (OBSERVABILITY.md, trace ownership rule 2).
    const only = active.length === 1 ? active[0] : undefined;
    const own = only === undefined ? undefined : this.#traceOf(only.id, only.requestId);
    if (own !== undefined) return own;
    const admitting = this.#admitting[0];
    if (admitting !== undefined) return admitting;
    if (this.#unclaimed.size === 1) {
      const [first] = this.#unclaimed;
      const pending = first === undefined ? undefined : this.#traces.get(first);
      if (pending !== undefined) return pending;
    }
    return trace;
  }

  #mapOne(
    event: AgentEvent,
    trace: string,
    byEntry: ReadonlyMap<string, string> = new Map(),
    active: readonly Submission[] = [],
  ): RuntimeEvent[] {
    const owned = this.#traceFor(event, trace, byEntry, active);
    if (event.type === "submission") {
      const record = convertSubmission(event.record);
      this.#rememberId(record);
      if (record?.status === "done" || record?.status === "unanswered") {
        this.#unclaimed.delete(String(event.record.id));
      }
    }
    if (event.type !== "task_failed") return this.#mapper.map(event, owned, active);
    const minted = this.#classifier.taskFailed({
      taskId: String(event.taskId),
      kind: event.kind,
    });
    this.#logFailure(minted, owned, Events.piReport, "pi");
    const error: Extract<RuntimeEvent, { type: "error" }> = {
      type: "error",
      trace: owned,
      failure: minted.classification.failure,
      message: minted.classification.message,
      taskId: String(event.taskId),
    };
    this.#announce(error);
    return [];
  }

  /** Teaches the ledger both ids, so a settled input stays readable by request id. */
  #rememberId(record: Submission | undefined): void {
    if (record === undefined) return;
    this.#submissionIds.set(record.id, record.id);
    if (record.requestId.length === 0) return;
    this.#submissionIds.set(record.requestId, record.id);
    this.#requestIds.set(record.id, record.requestId);
  }

  #broadcast(event: RuntimeEvent): void {
    for (const state of this.#subscriptions.values()) this.#deliver(state, event);
  }

  /** One `error` event per failure identity, whatever channel reported it first. */
  #announce(event: Extract<RuntimeEvent, { type: "error" }>): void {
    if (this.#announced.has(event.failure.id)) return;
    this.#announced.add(event.failure.id);
    if (this.#subscriptions.size === 0) {
      this.#undelivered.push(event);
      return;
    }
    this.#broadcast(event);
  }

  /** Delivers what failed while nobody was listening, now that somebody is. */
  #flushUndelivered(state: Subscription): void {
    if (this.#undelivered.length === 0) return;
    for (const event of this.#undelivered.splice(0)) this.#deliver(state, event);
  }

  /**
   * Exactly one `level=error` record per failure identity, on the layer that classified
   * it. A channel that classifies another layer's failure logs a propagation instead, so
   * an origin record can never be attributed to the wrong layer.
   */
  #logFailure(
    minted: Minted,
    trace: string,
    local: DeclaredEvent,
    localLayer: "runtime" | "pi",
  ): void {
    const failure = minted.classification.failure;
    const fields = { trace, botId: this.#spec.id, failure };
    if (!minted.minted || failure.layer !== localLayer) {
      this.#options.log.emit("warn", localLayer, local, { ...fields, propagated: true });
      if (minted.minted) {
        // The channel that classified it is not the layer that will log it, so this is
        // the only place the origin record can come from: emit it on the owning layer.
        const origin = failure.layer === "pi" ? Events.piReport : Events.classify;
        this.#options.log.emit("error", failure.layer, origin, { ...fields, origin: true });
      }
      return;
    }
    this.#options.log.emit("error", localLayer, local, { ...fields, origin: true });
    // The pi layer owns the origin record; the adapter records the classification once.
    if (localLayer === "pi") this.#options.log.emit("info", "runtime", Events.classify, fields);
  }
}

/** The watch end as a declared log code; free text never reaches `detail.reason`. */
const watchReason = (end: WatchEnd): string => {
  if (end.reason === "listener_error") return "listener_error";
  if (end.reason === "session_failed") return "session_failed";
  return end.reason;
};
