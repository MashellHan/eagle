// Command routing for the daemon (docs/bots/PLAN.md, rows 17-22): a connection sees one
// bot for its whole life, a subscription renders the first snapshot before it is live,
// and a command either reaches the runtime or is refused before admission.
import { randomUUID } from "node:crypto";
import type {
  ConversationSnapshot,
  ErrorDisposition,
  ErrorKind,
  Failure,
  Submission,
} from "./domain.ts";
import { EventHub, type HubSubscriber, type HubSubscription } from "./EventHub.ts";
import type { RuntimeEvent, RuntimeHandle, SubmitInput } from "./RuntimePort.ts";
import { reduceView } from "./view.ts";

/** Opens (or recovers) one bot. The registry owns catalog policy; the service owns routing. */
export type OpenBot = (botId: string, trace: string) => Promise<RuntimeHandle>;

export type ConversationServiceOptions = {
  readonly open: OpenBot;
  /** Encoded bytes of one event, measured by the transport (see EventHub). */
  readonly measure: (event: RuntimeEvent) => number;
  readonly schedule?: (run: () => void) => void;
};

/** Only `not_admitted` lets a client drop its outbox entry (docs/bots/PROTOCOL.md). */
export class CommandError extends Error {
  readonly kind: ErrorKind;
  readonly disposition: ErrorDisposition;
  readonly failure: Failure;
  readonly requestId: string | undefined;

  constructor(
    failure: Failure,
    disposition: ErrorDisposition,
    message: string,
    requestId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CommandError";
    this.kind = failure.kind;
    this.disposition = disposition;
    this.failure = failure;
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
  readonly handle: RuntimeHandle;
  readonly hub: EventHub;
  snapshot: ConversationSnapshot;
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
    const snapshot = bot.snapshot;
    let baseline: number | undefined;
    connection.hub = bot.hub.subscribe((event) => {
      baseline ??= event.rev;
      sink(event);
    });
    connection.bot = bot;
    connection.state = "live";
    bot.hub.publishSnapshot(snapshot, trace);
    bot.release();
    return { rev: baseline ?? bot.hub.rev, snapshot };
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
    const bot = this.#subscribed(connectionId, input.requestId);
    let stored: Submission | undefined;
    try {
      stored = await bot.handle.submission({ requestId: input.requestId });
    } catch (cause) {
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
      return await bot.handle.submit(input);
    } catch (cause) {
      // Admission is unconfirmed, so the client keeps its outbox entry and retries with
      // the same requestId rather than dropping the text.
      throw new CommandError(
        failure("internal"),
        "unknown",
        "admission could not be confirmed",
        input.requestId,
        { cause },
      );
    }
  }

  #refuse(message: string, requestId?: string): CommandError {
    return new CommandError(failure("invalid_command"), "not_admitted", message, requestId);
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
    const handle = await this.#open(botId, trace);
    const hub = new EventHub(botId, trace, this.#hubOptions);
    const buffered: RuntimeEvent[] = [];
    let ready = false;
    let bot: Bot;
    const apply = (event: RuntimeEvent): void => {
      bot.snapshot = reduceView(bot.snapshot, event);
      hub.publish(event);
    };
    const subscription = await handle.subscribe(trace, (event) => {
      if (!ready) {
        buffered.push(event);
        return;
      }
      apply(event);
    });
    bot = {
      handle,
      hub,
      snapshot: subscription.snapshot,
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
