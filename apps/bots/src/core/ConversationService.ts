// Command routing for the daemon (docs/bots/PLAN.md, rows 17-22): a connection sees one
// bot for its whole life, a subscription renders the first snapshot before it is live,
// and a command either reaches the runtime or is refused before admission.
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type {
  ConversationSnapshot,
  EntryId,
  ErrorDisposition,
  ErrorKind,
  Failure,
  Message,
  Submission,
} from "./domain.ts";
import { ClassifiedFailure } from "./domain.ts";
import { EventHub, type HubSubscriber, type HubSubscription } from "./EventHub.ts";
import { newFailure } from "./failures.ts";
import type { RuntimeEvent, RuntimeHandle, RuntimeHistory, SubmitInput } from "./RuntimePort.ts";
import { reduceView, type SubmissionRanks, seedRanks, trimWindow } from "./view.ts";

const Events = {
  subscribeStart: declareEvent("core.subscribe.start"),
  subscribeOk: declareEvent("core.subscribe.ok"),
  subscribeFail: declareEvent("core.subscribe.fail"),
  submitStart: declareEvent("core.submit.start"),
  submitOk: declareEvent("core.submit.ok"),
  submitFail: declareEvent("core.submit.fail"),
  historyStart: declareEvent("core.history.start"),
  historyOk: declareEvent("core.history.ok"),
  historyFail: declareEvent("core.history.fail"),
} as const;

/** A bot fans out to at most this many connections (PROTOCOL.md, "Limits"). */
export const MAX_SUBSCRIBERS_PER_BOT = 8;
/** Admitted-but-unsettled entries, and the runtime inbox, are both bounded (same table). */
export const MAX_PENDING = 32;
export const MAX_INBOX = 32;
/** The newest page a snapshot carries; older messages are reachable through `history`. */
export const MAX_WINDOW_MESSAGES = 200;
/** PROTOCOL.md, "Limits": a page frame is at most this many encoded bytes. */
export const MAX_PAGE_BYTES = 192 * 1024;

/** Opens (or recovers) one bot. The registry owns catalog policy; the service owns routing. */
export type OpenBot = (botId: string, trace: string) => Promise<RuntimeHandle>;

export type ConversationServiceOptions = {
  readonly open: OpenBot;
  /** The handle the registry owns right now; a cached bot whose handle was closed is stale. */
  readonly handleOf?: (botId: string) => RuntimeHandle | undefined;
  /** True while a close or delete owns the bot, so a cached view may be about to die. */
  readonly settlingOf?: (botId: string) => boolean;
  /** Encoded bytes of one event, measured by the transport (see EventHub). */
  readonly measure: (event: RuntimeEvent) => number;
  readonly schedule?: (run: () => void) => void;
  /** Every crossing is recorded; the service owns the core outcome of its commands. */
  readonly log?: Log;
  /** Newest messages kept in a rendered snapshot (PROTOCOL.md, "snapshot.messages page"). */
  readonly windowMessages?: number;
  /** The bot started or stopped working, so the catalog state can follow the run. */
  readonly onRunning?: (botId: string, running: boolean) => void;
  /** The runtime's session died: the handle is dead and the bot must be re-opened. */
  readonly onSessionFailed?: (botId: string, reason: ErrorKind, message: string) => void;
};

/** Only `not_admitted` lets a client drop its outbox entry (docs/bots/PROTOCOL.md). */
export class CommandError extends ClassifiedFailure {
  readonly kind: ErrorKind;
  readonly requestId: string | undefined;

  constructor(
    failure: Failure,
    disposition: ErrorDisposition,
    message: string,
    requestId?: string,
    options?: { cause?: unknown },
  ) {
    super(failure, disposition, message, options);
    this.name = "CommandError";
    this.kind = failure.kind;
    this.requestId = requestId;
  }
}

type Bot = {
  /** Absent while the bot is unavailable: the view still renders, the run cannot. */
  handle: RuntimeHandle | undefined;
  degraded: { readonly reason: ErrorKind; readonly message: string } | undefined;
  readonly hub: EventHub;
  snapshot: ConversationSnapshot;
  readonly ranks: SubmissionRanks;
  /** Admissions in flight, counted until their own submission event arrives. */
  readonly reserved: Set<string>;
  /** Detaches the runtime subscription this bot holds, when it has one. */
  detach: (() => void) | undefined;
  /** Publishes what the runtime delivered while the first subscription was rendering. */
  readonly release: () => void;
};

type Connection = {
  readonly botId: string;
  state: "pending" | "live" | "closed";
  bot: Bot | undefined;
  hub: HubSubscription | undefined;
};

type FailEvent = typeof Events.subscribeFail | typeof Events.submitFail | typeof Events.historyFail;

export class ConversationService {
  readonly #open: OpenBot;
  readonly #handleOf: ((botId: string) => RuntimeHandle | undefined) | undefined;
  readonly #settlingOf: ((botId: string) => boolean) | undefined;
  readonly #hubOptions: {
    readonly measure: (event: RuntimeEvent) => number;
    readonly schedule?: (run: () => void) => void;
    readonly log?: Log;
  };
  readonly #log: Log | undefined;
  readonly #window: number;
  readonly #onRunning: ((botId: string, running: boolean) => void) | undefined;
  readonly #onSessionFailed:
    | ((botId: string, reason: ErrorKind, message: string) => void)
    | undefined;
  /** Per-bot admission serialization: check-then-submit is one serial section. */
  readonly #admissions = new Map<string, Promise<unknown>>();
  /** Failure ids this service minted: only those may be recorded as an origin here. */
  readonly #minted = new Set<string>();
  readonly #bots = new Map<string, Promise<Bot>>();
  readonly #connections = new Map<string, Connection>();

  constructor(options: ConversationServiceOptions) {
    this.#open = options.open;
    this.#handleOf = options.handleOf;
    this.#settlingOf = options.settlingOf;
    this.#log = options.log;
    this.#window = options.windowMessages ?? MAX_WINDOW_MESSAGES;
    this.#onRunning = options.onRunning;
    this.#onSessionFailed = options.onSessionFailed;
    this.#hubOptions = {
      measure: options.measure,
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      ...(options.log === undefined ? {} : { log: options.log }),
    };
  }

  /**
   * Opens the bot, renders its current view as the connection's baseline, then goes live.
   * Pending deltas are flushed first and the baseline's own revision is captured, so the
   * first frame a client sees is the snapshot it is told about.
   */
  async subscribe(
    connectionId: string,
    botId: string,
    trace: string,
    sink: HubSubscriber,
  ): Promise<{ readonly rev: number; readonly snapshot: ConversationSnapshot }> {
    this.#log?.emit("info", "core", Events.subscribeStart, {
      trace,
      botId,
      connId: connectionId,
    });
    if (this.#connections.has(connectionId)) {
      throw this.#refuseSubscribed(trace, botId, connectionId);
    }
    // Reserve the id before opening, so a concurrent subscribe or a disconnect during the
    // open cannot slip past the one-bot-per-connection rule.
    const connection: Connection = { botId, state: "pending", bot: undefined, hub: undefined };
    this.#connections.set(connectionId, connection);
    let bot: Bot;
    try {
      bot = await this.#bot(botId, trace);
    } catch (error) {
      if (this.#connections.get(connectionId) === connection)
        this.#connections.delete(connectionId);
      this.#record(Events.subscribeFail, trace, botId, connectionId, error);
      throw error;
    }
    if (connection.state !== "pending") {
      throw this.#cancelled(Events.subscribeFail, trace, botId, connectionId);
    }
    if (bot.hub.subscriberCount >= MAX_SUBSCRIBERS_PER_BOT) {
      // Refused, not closed: the connection can still be used for a different bot.
      this.#connections.delete(connectionId);
      throw this.#refuseWith(
        Events.subscribeFail,
        trace,
        botId,
        connectionId,
        "limit_exceeded",
        "not_admitted",
        "this bot already has the maximum number of subscribers",
      );
    }
    bot.hub.drain();
    // A sink drained by the flush can disconnect this connection; only a connection that
    // is still pending may be attached.
    if (this.#connections.get(connectionId) !== connection || connection.state !== "pending") {
      throw this.#cancelled(Events.subscribeFail, trace, botId, connectionId);
    }
    const snapshot = bot.snapshot;
    let baseline: number | undefined;
    connection.hub = bot.hub.subscribe((event) => {
      // Frames published before the baseline belong to no client yet: the snapshot that
      // follows already contains their effect, so delivering them first would break the
      // first-frame rule and the baseline revision.
      if (baseline === undefined) {
        if (event.type !== "snapshot") return;
        baseline = event.rev;
      }
      sink(event);
    });
    connection.bot = bot;
    connection.state = "live";
    bot.hub.publishSnapshot(snapshot, trace);
    // A bot whose baseline is already running is running, not idle. The catalog event
    // follows the baseline, so the first frame a client sees is still the snapshot.
    this.#onRunning?.(snapshot.botId, snapshot.running);
    bot.release();
    if (baseline === undefined) {
      throw this.#cancelled(Events.subscribeFail, trace, botId, connectionId);
    }
    this.#log?.emit("info", "core", Events.subscribeOk, {
      trace,
      botId,
      connId: connectionId,
      rev: baseline,
      detail: { count: bot.hub.subscriberCount },
    });
    return { rev: baseline, snapshot };
  }

  /** Ends a connection's subscription. The bot stays open for the registry to reclaim. */
  unsubscribe(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) return;
    connection.state = "closed";
    connection.hub?.detach();
    this.#connections.delete(connectionId);
  }

  /**
   * A duplicate `requestId` answers from the stored record without touching the runtime,
   * which is how a lost reply is recovered. The reply is connection-scoped: it carries no
   * revision, and settlements reach everyone through the hub instead.
   */
  async send(connectionId: string, input: SubmitInput): Promise<Submission> {
    const owner = this.#connectionBot(connectionId);
    this.#log?.emit("info", "core", Events.submitStart, {
      trace: input.trace,
      ...(owner === undefined ? {} : { botId: owner }),
      connId: connectionId,
      reqId: input.requestId,
    });
    try {
      const record = await this.#admit(connectionId, input);
      this.#log?.emit("info", "core", Events.submitOk, {
        trace: input.trace,
        ...(owner === undefined ? {} : { botId: owner }),
        connId: connectionId,
        reqId: input.requestId,
        detail: { queued: record.status === "queued", count: 1 },
      });
      return record;
    } catch (error) {
      this.#record(Events.submitFail, input.trace, owner, connectionId, error, input.requestId);
      throw error;
    }
  }

  /** `abort` withdraws the running input and everything queued behind it. */
  async abort(connectionId: string, trace: string): Promise<void> {
    await this.#handle(connectionId).abort(trace);
  }

  /**
   * `recover` never aborts a healthy answer: an unavailable bot is opened again and the
   * connection is handed the new view, a parked task is retried, a healthy bot answers
   * with its snapshot.
   */
  async recover(connectionId: string, trace: string): Promise<void> {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.state !== "live" || connection.bot === undefined) {
      throw this.#refuse("the connection has no subscription");
    }
    const bot = connection.bot;
    // Concurrent recovers must not attach a second watch to one handle: one serial
    // section per bot re-checks the state it saw before it acts.
    await this.#serialize(bot.snapshot.botId, async () => {
      if (bot.degraded !== undefined) {
        const rebuilt = await this.#reopen(bot, connection.botId, trace);
        bot.hub.publishSnapshot(rebuilt, trace);
        return;
      }
      await this.#handle(connectionId).recover(trace);
      bot.hub.publishSnapshot(bot.snapshot, trace);
    });
  }

  /** Re-opens an unavailable bot and adopts the new handle in place, so the hub survives. */
  async #reopen(bot: Bot, botId: string, trace: string): Promise<ConversationSnapshot> {
    // The dead handle's watch is gone with it; keep the view, replace the runtime behind it.
    bot.detach?.();
    const handle = await this.#open(botId, trace);
    // Attached onto the same object: the event closure, the connection and the cache all
    // keep pointing at one view, and the hub keeps its subscribers.
    const attached = await this.#attach(handle, bot.hub, trace, bot);
    attached.release();
    this.#onRunning?.(bot.snapshot.botId, bot.snapshot.running);
    return bot.snapshot;
  }

  /** Older messages, oldest first. The newest window is not re-fetched. */
  async history(
    connectionId: string,
    input: { readonly beforeEntryId?: EntryId; readonly limit: number },
    trace: string,
  ): Promise<RuntimeHistory> {
    const botId = this.#subscribed(connectionId);
    this.#log?.emit("info", "core", Events.historyStart, {
      trace,
      botId,
      connId: connectionId,
    });
    try {
      const page = await this.#handle(connectionId).history(input);
      // A page is bounded by count and encoded bytes. The page must stay contiguous with
      // the cursor, so the *newest* messages are kept and the older ones come next time.
      const kept: Message[] = [];
      let bytes = 0;
      for (let index = page.messages.length - 1; index >= 0; index -= 1) {
        const message = page.messages[index];
        if (message === undefined) break;
        const size = this.#measureMessage(message);
        if (kept.length >= MAX_WINDOW_MESSAGES || bytes + size > MAX_PAGE_BYTES) break;
        kept.push(message);
        bytes += size;
      }
      const messages = kept.reverse();
      const bounded = {
        messages,
        hasMore: page.hasMore || messages.length < page.messages.length,
      };
      this.#log?.emit("info", "core", Events.historyOk, {
        trace,
        botId,
        connId: connectionId,
        detail: { count: bounded.messages.length },
      });
      return bounded;
    } catch (error) {
      if (error instanceof ClassifiedFailure) {
        this.#record(Events.historyFail, trace, botId, connectionId, error);
        throw error;
      }
      const failure = this.#mint("storage_failed");
      const classified = new ClassifiedFailure(failure, "runtime", "the page could not be read", {
        cause: error,
      });
      this.#record(Events.historyFail, trace, botId, connectionId, classified);
      throw classified;
    }
  }

  /**
   * Answers by broadcasting a snapshot of the current view on this connection. The
   * broadcast is the only reply: the caller must not write a second frame for it, or a
   * later increment could be followed by this older snapshot. The event carries the
   * command's trace and a revision that names exactly its content, because pending
   * deltas are folded in first.
   */
  resync(connectionId: string, trace: string): void {
    const bot = this.#botOf(connectionId);
    bot.hub.publishSnapshot(bot.snapshot, trace);
  }

  /**
   * Read-then-submit as one serial section per bot: a stored record answers a retry
   * without admitting anything new, and the budget check cannot interleave with another
   * admission. A reservation is held until that submission's own event arrives, because
   * the view only learns about the work after the runtime commits it.
   */
  async #admit(connectionId: string, input: SubmitInput): Promise<Submission> {
    const bot = this.#botOf(connectionId, input.requestId);
    return this.#serialize(bot.snapshot.botId, async () => {
      const handle = this.#handle(connectionId, input.requestId);
      let stored: Submission | undefined;
      try {
        stored = await handle.submission({ requestId: input.requestId });
      } catch (cause) {
        if (cause instanceof ClassifiedFailure) throw cause;
        throw new CommandError(
          this.#mint("internal"),
          "unknown",
          "the submission record could not be read",
          input.requestId,
          { cause },
        );
      }
      if (stored !== undefined) {
        // The retry found the record: whatever admission it was waiting for has settled.
        bot.reserved.delete(input.requestId);
        return stored;
      }
      if (
        bot.snapshot.pending.length + bot.reserved.size >= MAX_PENDING ||
        bot.snapshot.inbox.length >= MAX_INBOX
      ) {
        throw new CommandError(
          this.#mint("limit_exceeded"),
          "not_admitted",
          "the bot has no room for another admission",
          input.requestId,
        );
      }
      bot.reserved.add(input.requestId);
      try {
        const record = await handle.submit(input);
        if (record.status === "done" || record.status === "unanswered") {
          bot.reserved.delete(input.requestId);
        }
        return record;
      } catch (cause) {
        // A refusal is known not to be admitted, so its slot is free again. An "unknown"
        // disposition may still have been admitted: the slot stays reserved until the
        // retry of the same requestId resolves it.
        const known =
          cause instanceof ClassifiedFailure &&
          (cause.disposition === "not_admitted" || cause.disposition === "runtime");
        if (known) bot.reserved.delete(input.requestId);
        // A failure the runtime already classified keeps its identity and disposition;
        // only an unclassified one becomes "admission unconfirmed", where the client
        // keeps its outbox entry and retries with the same requestId.
        if (cause instanceof ClassifiedFailure) throw cause;
        throw new CommandError(
          this.#mint("internal"),
          "unknown",
          "admission could not be confirmed",
          input.requestId,
          { cause },
        );
      }
    });
  }

  /** One bot's admissions never interleave, so a budget check is atomic with its submit. */
  #serialize<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#admissions.get(botId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#admissions.set(
      botId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Trims a page against the whole snapshot frame, envelope and state included. */
  #fitPage(view: ConversationSnapshot): ConversationSnapshot {
    const overhead = this.#hubOptions.measure({
      type: "snapshot",
      trace: "tr_measure",
      value: { ...view, messages: [] },
    });
    return trimWindow(
      view,
      this.#window,
      this.#measureMessage,
      Math.max(0, MAX_PAGE_BYTES - overhead),
    );
  }

  /** Encoded bytes of one message in the frame a client would receive it in. */
  #measureMessage = (message: ConversationSnapshot["messages"][number]): number =>
    this.#hubOptions.measure({ type: "append", trace: "tr_measure", message });

  /** One failure episode, one error record: only a failure minted here is an origin. */
  #record(
    evt: FailEvent,
    trace: string,
    botId: string | undefined,
    connectionId: string,
    error: unknown,
    requestId?: string,
  ): void {
    const classified = error instanceof ClassifiedFailure ? error : undefined;
    const failure = classified?.failure ?? this.#mint("internal");
    const own = this.#minted.has(failure.id);
    this.#log?.emit(own ? "error" : "warn", "core", evt, {
      trace,
      ...(botId === undefined ? {} : { botId }),
      connId: connectionId,
      ...(requestId === undefined ? {} : { reqId: requestId }),
      failure,
      ...(own ? { origin: true as const } : { propagated: true }),
    });
  }

  /** A failure this service owns: minted once, recorded once, carried unchanged. */
  #mint(kind: ErrorKind): Failure {
    const minted = newFailure(kind, "core");
    this.#minted.add(minted.id);
    return minted;
  }

  #refuse(message: string, requestId?: string): CommandError {
    return new CommandError(this.#mint("invalid_command"), "not_admitted", message, requestId);
  }

  /** A refusal the service mints: recorded at error, because core is its origin. */
  #refuseWith(
    evt: FailEvent,
    trace: string,
    botId: string,
    connectionId: string,
    kind: ErrorKind,
    disposition: ErrorDisposition,
    message: string,
    requestId?: string,
  ): CommandError {
    const failure = this.#mint(kind);
    this.#record(
      evt,
      trace,
      botId,
      connectionId,
      new ClassifiedFailure(failure, disposition, message),
      requestId,
    );
    return new CommandError(failure, disposition, message, requestId);
  }

  #refuseSubscribed(trace: string, botId: string, connectionId: string): CommandError {
    return this.#refuseWith(
      Events.subscribeFail,
      trace,
      botId,
      connectionId,
      "invalid_command",
      "not_admitted",
      "a connection subscribes to one bot for its whole life",
    );
  }

  #cancelled(evt: FailEvent, trace: string, botId: string, connectionId: string): CommandError {
    return this.#refuseWith(
      evt,
      trace,
      botId,
      connectionId,
      "internal",
      "unknown",
      "the subscription was cancelled",
    );
  }

  /** A live bot that can actually run; an unavailable one refuses the command. */
  #handle(connectionId: string, requestId?: string): RuntimeHandle {
    const bot = this.#botOf(connectionId, requestId);
    if (bot.handle === undefined) {
      throw new CommandError(
        this.#mint(bot.degraded?.reason ?? "storage_failed"),
        "runtime",
        "the bot is unavailable; recover it first",
        requestId,
      );
    }
    return bot.handle;
  }

  #subscribed(connectionId: string, requestId?: string): string {
    return this.#botOf(connectionId, requestId).snapshot.botId;
  }

  #connectionBot(connectionId: string): string | undefined {
    return this.#connections.get(connectionId)?.botId;
  }

  #botOf(connectionId: string, requestId?: string): Bot {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.state !== "live" || connection.bot === undefined) {
      throw this.#refuse("the connection has no subscription", requestId);
    }
    return connection.bot;
  }

  async #bot(botId: string, trace: string): Promise<Bot> {
    const cached = this.#bots.get(botId);
    if (cached !== undefined) {
      const bot = await cached.catch(() => undefined);
      if (bot !== undefined) {
        const live = this.#handleOf?.(botId);
        const settling = this.#settlingOf?.(botId) === true;
        // A live handle that the registry still owns is this view's handle: no extra open.
        if (!settling && (this.#handleOf === undefined || bot.handle === live)) return bot;
        // A close or delete in flight owns the handle: ask the registry, which waits for
        // it, so a subscribe can never hold a handle the registry is about to drop.
        const opened = await this.#open(botId, trace).catch((error: unknown) => {
          if (error instanceof ClassifiedFailure && error.failure.kind === "unknown_bot") {
            throw error;
          }
          return undefined;
        });
        if (opened !== undefined && bot.handle === opened) return bot;
        if (opened === undefined && bot.handle === undefined) return bot;
      }
      this.#bots.delete(botId);
    }
    return this.#openBotCached(botId, trace);
  }

  #openBotCached(botId: string, trace: string): Promise<Bot> {
    const existing = this.#bots.get(botId);
    if (existing !== undefined) return existing;
    const created = this.#openBot(botId, trace);
    this.#bots.set(botId, created);
    created.catch(() => {
      // A failed open must not poison every later attempt.
      if (this.#bots.get(botId) === created) this.#bots.delete(botId);
    });
    return created;
  }

  async #openBot(botId: string, trace: string): Promise<Bot> {
    const hub = new EventHub(botId, trace, this.#hubOptions);
    try {
      const handle = await this.#open(botId, trace);
      return await this.#attach(handle, hub, trace);
    } catch (error) {
      // A bot that cannot open is `unavailable`, not a failed connection: the client
      // renders the reason and can `recover` it.
      if (error instanceof ClassifiedFailure && error.failure.kind === "unknown_bot") throw error;
      if (error instanceof CommandError && error.disposition === "not_admitted") throw error;
      const classified = error instanceof ClassifiedFailure ? error : undefined;
      const reason = classified?.failure.kind ?? "storage_failed";
      const message = classified?.message ?? "the bot could not be opened";
      return {
        handle: undefined,
        degraded: { reason, message },
        hub,
        snapshot: {
          botId,
          messages: [],
          pending: [],
          inbox: [],
          running: false,
          streaming: null,
          unavailable: { reason, message },
        },
        ranks: new Map(),
        reserved: new Set<string>(),
        detach: undefined,
        release: () => undefined,
      };
    }
  }

  async #attach(handle: RuntimeHandle, hub: EventHub, trace: string, target?: Bot): Promise<Bot> {
    const buffered: RuntimeEvent[] = [];
    let ready = false;
    let bot: Bot;
    const apply = (event: RuntimeEvent): void => {
      const wasRunning = bot.snapshot.running;
      if (event.type === "submission") bot.reserved.delete(event.record.requestId);
      if (event.type === "snapshot") {
        // A lost settlement event cannot hold a slot forever: a snapshot that no longer
        // lists the submission is the daemon's own reconciliation.
        for (const requestId of [...bot.reserved]) {
          const listed =
            event.value.pending.some((record) => record.requestId === requestId) ||
            event.value.messages.some(
              (message) => message.requestId === requestId && message.state !== "complete",
            );
          if (!listed) bot.reserved.delete(requestId);
        }
      }
      let next = reduceView(bot.snapshot, event, bot.ranks);
      if (
        event.type === "error" &&
        (event.failure.kind === "storage_failed" || event.failure.kind === "internal")
      ) {
        // The harness closed itself or the watch escalated: the handle is dead, so the bot
        // is unavailable until `recover` opens it again (ARCHITECTURE.md, "Failure
        // containment"). An unavailable snapshot's collections are unknown, so they are
        // empty — the production decoder refuses anything else (PROTOCOL.md).
        const { truncatedBefore: _dropped, ...rest } = next;
        next = {
          ...rest,
          messages: [],
          running: false,
          streaming: null,
          pending: [],
          inbox: [],
          unavailable: { reason: event.failure.kind, message: event.message },
        };
        bot.handle = undefined;
        bot.degraded = { reason: event.failure.kind, message: event.message };
        this.#onSessionFailed?.(next.botId, event.failure.kind, event.message);
      }
      next = this.#fitPage(next);
      bot.snapshot = next;
      if (next.running !== wasRunning) this.#onRunning?.(next.botId, next.running);
      // A snapshot from the runtime may carry a stale pending list; broadcast the one the
      // bot actually holds so a client never adopts a downgraded submission.
      hub.publish(
        event.type === "snapshot" && next !== event.value ? { ...event, value: next } : event,
      );
    };
    const ranks: SubmissionRanks = new Map();
    const subscription = await handle.subscribe(trace, (event) => {
      if (!ready) {
        buffered.push(event);
        return;
      }
      apply(event);
    });
    seedRanks(ranks, subscription.snapshot.pending);
    bot = target ?? ({} as Bot);
    Object.assign(bot, {
      handle,
      degraded: undefined,
      hub,
      detach: () => subscription.detach(),
      // The runtime's own baseline is a page too: it is trimmed before any client sees it.
      snapshot: this.#fitPage(subscription.snapshot),
      ranks,
      reserved: new Set<string>(),
      release: () => {
        // Stay buffering while draining: an event produced by a sink mid-release must
        // queue behind the earlier ones instead of overtaking them.
        while (!ready) {
          const event = buffered.shift();
          if (event === undefined) {
            ready = true;
            break;
          }
          apply(event);
        }
      },
    });
    return bot;
  }
}
