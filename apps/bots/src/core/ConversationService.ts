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
  Submission,
} from "./domain.ts";
import { ClassifiedFailure } from "./domain.ts";
import { EventHub, type HubSubscriber, type HubSubscription } from "./EventHub.ts";
import { newFailure } from "./failures.ts";
import type { RuntimeEvent, RuntimeHandle, RuntimeHistory, SubmitInput } from "./RuntimePort.ts";
import { reduceView, type SubmissionRanks, seedRanks } from "./view.ts";

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

/** Opens (or recovers) one bot. The registry owns catalog policy; the service owns routing. */
export type OpenBot = (botId: string, trace: string) => Promise<RuntimeHandle>;

export type ConversationServiceOptions = {
  readonly open: OpenBot;
  /** The handle the registry owns right now; a cached bot whose handle was closed is stale. */
  readonly handleOf?: (botId: string) => RuntimeHandle | undefined;
  /** Encoded bytes of one event, measured by the transport (see EventHub). */
  readonly measure: (event: RuntimeEvent) => number;
  readonly schedule?: (run: () => void) => void;
  /** Every crossing is recorded; the service owns the core outcome of its commands. */
  readonly log?: Log;
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
  readonly #hubOptions: {
    readonly measure: (event: RuntimeEvent) => number;
    readonly schedule?: (run: () => void) => void;
    readonly log?: Log;
  };
  readonly #log: Log | undefined;
  /** Failure ids this service minted: only those may be recorded as an origin here. */
  readonly #minted = new Set<string>();
  readonly #bots = new Map<string, Promise<Bot>>();
  readonly #connections = new Map<string, Connection>();

  constructor(options: ConversationServiceOptions) {
    this.#open = options.open;
    this.#handleOf = options.handleOf;
    this.#log = options.log;
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
    const owner = this.#subscribed(connectionId, input.requestId);
    this.#log?.emit("info", "core", Events.submitStart, {
      trace: input.trace,
      botId: owner,
      connId: connectionId,
      reqId: input.requestId,
    });
    try {
      const record = await this.#admit(connectionId, input);
      this.#log?.emit("info", "core", Events.submitOk, {
        trace: input.trace,
        botId: owner,
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
    if (bot.degraded !== undefined) {
      const rebuilt = await this.#reopen(bot, connection.botId, trace);
      bot.hub.publishSnapshot(rebuilt, trace);
      return;
    }
    await this.#handle(connectionId).recover(trace);
    bot.hub.publishSnapshot(bot.snapshot, trace);
  }

  /** Re-opens an unavailable bot and adopts the new handle in place, so the hub survives. */
  async #reopen(bot: Bot, botId: string, trace: string): Promise<ConversationSnapshot> {
    const handle = await this.#open(botId, trace);
    // Attached onto the same object: the event closure, the connection and the cache all
    // keep pointing at one view, and the hub keeps its subscribers.
    const attached = await this.#attach(handle, bot.hub, trace, bot);
    attached.release();
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
      this.#log?.emit("info", "core", Events.historyOk, {
        trace,
        botId,
        connId: connectionId,
        detail: { count: page.messages.length },
      });
      return page;
    } catch (error) {
      this.#record(Events.historyFail, trace, botId, connectionId, error);
      throw error;
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

  /** Read-then-submit: a stored record answers a retry without admitting anything new. */
  async #admit(connectionId: string, input: SubmitInput): Promise<Submission> {
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
    if (stored !== undefined) return stored;
    const bot = this.#botOf(connectionId, input.requestId);
    if (bot.snapshot.pending.length >= MAX_PENDING || bot.snapshot.inbox.length >= MAX_INBOX) {
      throw new CommandError(
        this.#mint("limit_exceeded"),
        "not_admitted",
        "the bot has no room for another admission",
        input.requestId,
      );
    }
    try {
      return await handle.submit(input);
    } catch (cause) {
      // A failure the runtime already classified keeps its identity and disposition; only
      // an unclassified one becomes "admission unconfirmed", where the client keeps its
      // outbox entry and retries with the same requestId.
      if (cause instanceof ClassifiedFailure) throw cause;
      throw new CommandError(
        this.#mint("internal"),
        "unknown",
        "admission could not be confirmed",
        input.requestId,
        { cause },
      );
    }
  }

  /** One failure episode, one error record: only a failure minted here is an origin. */
  #record(
    evt: FailEvent,
    trace: string,
    botId: string,
    connectionId: string,
    error: unknown,
    requestId?: string,
  ): void {
    const classified = error instanceof ClassifiedFailure ? error : undefined;
    const failure = classified?.failure ?? this.#mint("internal");
    const own = this.#minted.has(failure.id);
    this.#log?.emit(own ? "error" : "warn", "core", evt, {
      trace,
      botId,
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
      // A handle the registry closed is not a handle this service may keep using.
      const live = this.#handleOf?.(botId);
      if (bot !== undefined && (this.#handleOf === undefined || bot.handle === live)) return bot;
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
        release: () => undefined,
      };
    }
  }

  async #attach(handle: RuntimeHandle, hub: EventHub, trace: string, target?: Bot): Promise<Bot> {
    const buffered: RuntimeEvent[] = [];
    let ready = false;
    let bot: Bot;
    const apply = (event: RuntimeEvent): void => {
      const next = reduceView(bot.snapshot, event, bot.ranks);
      bot.snapshot = next;
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
      snapshot: subscription.snapshot,
      ranks,
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
