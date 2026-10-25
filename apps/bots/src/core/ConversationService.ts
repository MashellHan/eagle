// Command routing for the daemon (docs/bots/PLAN.md, rows 17-22): a connection sees one
// bot for its whole life, a subscription renders the first snapshot before it is live,
// and a command either reaches the runtime or is refused before admission.
import { randomUUID } from "node:crypto";
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
import type { RuntimeEvent, RuntimeHandle, RuntimeHistory, SubmitInput } from "./RuntimePort.ts";
import { reduceView, type SubmissionRanks, seedRanks } from "./view.ts";

/** Opens (or recovers) one bot. The registry owns catalog policy; the service owns routing. */
export type OpenBot = (botId: string, trace: string) => Promise<RuntimeHandle>;

export type ConversationServiceOptions = {
  readonly open: OpenBot;
  /** Encoded bytes of one event, measured by the transport (see EventHub). */
  readonly measure: (event: RuntimeEvent) => number;
  readonly schedule?: (run: () => void) => void;
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

/** One failure episode, one identity, minted here because core classified it. */
const failure = (kind: ErrorKind, layer: Failure["layer"] = "core"): Failure => ({
  id: `f_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  kind,
  layer,
});

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

export class ConversationService {
  readonly #open: OpenBot;
  readonly #hubOptions: {
    readonly measure: (event: RuntimeEvent) => number;
    readonly schedule?: (run: () => void) => void;
  };
  readonly #bots = new Map<string, Promise<Bot>>();
  readonly #connections = new Map<string, Connection>();

  constructor(options: ConversationServiceOptions) {
    this.#open = options.open;
    this.#hubOptions =
      options.schedule === undefined
        ? { measure: options.measure }
        : { measure: options.measure, schedule: options.schedule };
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
    if (this.#connections.has(connectionId)) {
      throw this.#refuse("a connection subscribes to one bot for its whole life");
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
      throw error;
    }
    if (connection.state !== "pending") {
      throw new CommandError(failure("internal"), "unknown", "the subscription was cancelled");
    }
    bot.hub.drain();
    // A sink drained by the flush can disconnect this connection; only a connection that
    // is still pending may be attached.
    if (this.#connections.get(connectionId) !== connection || connection.state !== "pending") {
      throw new CommandError(failure("internal"), "unknown", "the subscription was cancelled");
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
    if (baseline === undefined)
      throw new CommandError(failure("internal"), "unknown", "no baseline");
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
    const handle = this.#handle(connectionId, input.requestId);
    let stored: Submission | undefined;
    try {
      stored = await handle.submission({ requestId: input.requestId });
    } catch (cause) {
      if (cause instanceof ClassifiedFailure) throw cause;
      throw new CommandError(
        failure("internal"),
        "unknown",
        "the submission record could not be read",
        input.requestId,
        { cause },
      );
    }
    if (stored !== undefined) return stored;
    try {
      return await handle.submit(input);
    } catch (cause) {
      // A failure the runtime already classified keeps its identity and disposition; only
      // an unclassified one becomes "admission unconfirmed", where the client keeps its
      // outbox entry and retries with the same requestId.
      if (cause instanceof ClassifiedFailure) throw cause;
      throw new CommandError(
        failure("internal"),
        "unknown",
        "admission could not be confirmed",
        input.requestId,
        { cause },
      );
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
    const rebuilt = await this.#attach(handle, bot.hub, trace);
    bot.handle = rebuilt.handle;
    bot.degraded = undefined;
    bot.snapshot = rebuilt.snapshot;
    Object.assign(bot, { ranks: rebuilt.ranks });
    rebuilt.release();
    return bot.snapshot;
  }

  /** Older messages, oldest first. The newest window is not re-fetched. */
  async history(
    connectionId: string,
    input: { readonly beforeEntryId?: EntryId; readonly limit: number },
  ): Promise<RuntimeHistory> {
    return this.#handle(connectionId).history(input);
  }

  /**
   * Answers by broadcasting a snapshot of the current view on this connection. The
   * broadcast is the only reply: the caller must not write a second frame for it, or a
   * later increment could be followed by this older snapshot. The event carries the
   * command's trace and a revision that names exactly its content, because pending
   * deltas are folded in first.
   */
  resync(connectionId: string, trace: string): void {
    const bot = this.#subscribed(connectionId);
    bot.hub.publishSnapshot(bot.snapshot, trace);
  }

  #refuse(message: string, requestId?: string): CommandError {
    return new CommandError(failure("invalid_command"), "not_admitted", message, requestId);
  }

  /** A live bot that can actually run; an unavailable one refuses the command. */
  #handle(connectionId: string, requestId?: string): RuntimeHandle {
    const bot = this.#subscribed(connectionId, requestId);
    if (bot.handle === undefined) {
      throw new CommandError(
        failure(bot.degraded?.reason ?? "storage_failed"),
        "runtime",
        "the bot is unavailable; recover it first",
        requestId,
      );
    }
    return bot.handle;
  }

  #subscribed(connectionId: string, requestId?: string): Bot {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.state !== "live" || connection.bot === undefined) {
      throw this.#refuse("the connection has no subscription", requestId);
    }
    return connection.bot;
  }

  #bot(botId: string, trace: string): Promise<Bot> {
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

  async #attach(handle: RuntimeHandle, hub: EventHub, trace: string): Promise<Bot> {
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
    bot = {
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
    };
    return bot;
  }
}
