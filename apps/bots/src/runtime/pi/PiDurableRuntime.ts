// The pi-durable adapter (docs/bots/RUNTIME.md). It owns one Harness per bot, the
// submission ledger, the close deadline and the failure classification; it owns no
// catalog, no transport and no revision.

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type ConversationId,
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
import type { ConversationSnapshot, Submission } from "../../core/domain.ts";
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
  readonly #sinks = new Set<(event: RuntimeEvent) => void>();
  /** Failure identities already announced: the channels double-report one episode. */
  readonly #announced = new Set<string>();
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
    this.#sinks.add(sink);
    try {
      const stream = await watchEvents(this.#harness, this.#rootId, BACKGROUND_CONTEXT);
      // F8: the acquisition snapshot is the baseline; the listener sees later commits.
      const baseline = this.#mapper.seed(stream.snapshot, trace)[0];
      const snapshot =
        baseline !== undefined && baseline.type === "snapshot"
          ? baseline.value
          : this.#mapper.view();
      stream.start(async (batch) => {
        for (const event of batch) {
          for (const mapped of this.#mapOne(event, trace)) sink(mapped);
        }
      });
      stream.closed.then((end) => this.#watchEnd(end, trace, sink));
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
          this.#sinks.delete(sink);
          void stream.stop();
        },
      };
    } catch (cause) {
      this.#sinks.delete(sink);
      const minted = this.#classifier.classify("subscribe", "internal", "runtime");
      log.emit("error", "runtime", Events.subscribeFail, {
        trace,
        botId: this.#spec.id,
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
  }

  async submit(input: SubmitInput): Promise<Submission> {
    const log = this.#options.log;
    const started = performance.now();
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
      const minted = busy ? this.#classifier.refusedBusy() : this.#classifier.submitFailed(cause);
      this.#logFailure(minted, input.trace, Events.submitFail);
      throw new ClassifiedFailure(
        minted.classification.failure,
        busy ? "not_admitted" : "unknown",
        minted.classification.message,
        { cause },
      );
    }
  }

  async submission(
    key: { submissionId: string } | { requestId: string },
  ): Promise<Submission | undefined> {
    if ("submissionId" in key) {
      const found = await this.#harness.submission(
        Number(key.submissionId) as never,
        BACKGROUND_CONTEXT,
      );
      if (found === undefined) return undefined;
      const record = await found.status(BACKGROUND_CONTEXT);
      return convertSubmission(record as never);
    }
    const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
    const record = inspection.submissions.find((item) => item.requestId === key.requestId);
    return record === undefined ? undefined : convertSubmission(record);
  }

  /** Older messages, oldest first; the newest window is not re-fetched. */
  async history(input: { beforeEntryId?: string; limit: number }): Promise<RuntimeHistory> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    const before = input.beforeEntryId;
    const page = await root.entries(
      {
        order: "descending",
        ...(before === undefined ? {} : { maxEntryId: piEntryId(before) }),
      },
      input.limit + 2,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const messages = page.items
      .map((entry) => this.#mapper.entryMessage(entry))
      .filter((message) => message !== undefined)
      .filter((message) => message.id !== before)
      .slice(0, input.limit)
      .reverse();
    return { messages, hasMore: page.items.length >= input.limit + 2 };
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
      this.#logFailure(minted, trace, Events.abortFail);
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
      this.#logFailure(minted, trace, Events.recoverFail);
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
    log.emit("info", "runtime", Events.closeOk, {
      trace,
      botId: this.#spec.id,
      detail: { quarantined: outcome === "timeout" },
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
    const minted = this.#classifier.report(info);
    const log = this.#options.log;
    if (minted === undefined) {
      log.emit("warn", "pi", Events.piReport, {
        trace: this.#spec.trace,
        botId: this.#spec.id,
        detail: { kind: info.type },
      });
      return;
    }
    this.#logFailure(minted, this.#spec.trace, Events.piReport, "pi");
    const task = "task" in info ? info.task : undefined;
    this.#announce({
      type: "error",
      trace: this.#spec.trace,
      failure: minted.classification.failure,
      message: minted.classification.message,
      ...(task === undefined ? {} : { taskId: String(task.id) }),
    });
  }

  #watchEnd(end: WatchEnd, trace: string, sink: (event: RuntimeEvent) => void): void {
    const minted = this.#classifier.watchEnd(end);
    this.#options.log.emit("warn", "runtime", Events.watchEndOk, {
      trace,
      botId: this.#spec.id,
      detail: { reason: watchReason(end) },
      ...(minted === undefined ? {} : { failure: minted.classification.failure, propagated: true }),
    });
    if (minted !== undefined) {
      this.#logFailure(minted, trace, Events.piReport, "pi");
      this.#announce({
        type: "error",
        trace,
        failure: minted.classification.failure,
        message: minted.classification.message,
      });
      return;
    }
    // A listener error is recoverable: reattach with a fresh snapshot, and let the
    // classifier escalate only at the third occurrence inside a minute.
    if (end.reason === "listener_error") this.#reattach(trace, sink);
  }

  #reattach(trace: string, sink: (event: RuntimeEvent) => void): void {
    void this.subscribe(trace, sink).catch(() => undefined);
  }

  #mapOne(event: AgentEvent, trace: string): RuntimeEvent[] {
    if (event.type !== "task_failed") return this.#mapper.map(event, trace);
    const minted = this.#classifier.taskFailed({
      taskId: String(event.taskId),
      kind: event.kind,
    });
    this.#logFailure(minted, trace, Events.piReport, "pi");
    return [
      {
        type: "error",
        trace,
        failure: minted.classification.failure,
        message: minted.classification.message,
        taskId: String(event.taskId),
      },
    ];
  }

  #broadcast(event: RuntimeEvent): void {
    for (const sink of this.#sinks) sink(event);
  }

  /** One `error` event per failure identity, whatever channel reported it first. */
  #announce(event: Extract<RuntimeEvent, { type: "error" }>): void {
    if (this.#announced.has(event.failure.id)) return;
    this.#announced.add(event.failure.id);
    this.#broadcast(event);
  }

  /**
   * Exactly one `level=error` record per failure identity, on the layer that classified
   * it; a repeat of an episode logs `warn` with the same identity and `propagated`.
   */
  #logFailure(
    minted: Minted,
    trace: string,
    origin: DeclaredEvent,
    layer: "runtime" | "pi" = "runtime",
  ): void {
    const failure = minted.classification.failure;
    const fields = { trace, botId: this.#spec.id, failure };
    if (!minted.minted) {
      this.#options.log.emit("warn", failure.layer, origin, { ...fields, propagated: true });
      return;
    }
    this.#options.log.emit("error", layer, origin, { ...fields, origin: true });
    // The pi layer owns the origin record; the adapter records its classification once.
    if (layer === "pi") this.#options.log.emit("info", "runtime", Events.classify, fields);
  }
}

/** The watch end as a declared log code; free text never reaches `detail.reason`. */
const watchReason = (end: WatchEnd): string => {
  if (end.reason === "listener_error") return "listener_error";
  if (end.reason === "session_failed") return "session_failed";
  return end.reason;
};
