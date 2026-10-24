// Command routing for the daemon (docs/bots/PLAN.md, rows 17-22): a connection sees one
// bot for its whole life, a subscription renders the first snapshot before it is live,
// and a command either reaches the runtime or is refused before admission.
import type { ConversationSnapshot, ErrorDisposition, ErrorKind, Submission } from "./domain.ts";
import { EventHub, type HubSubscriber, type HubSubscription } from "./EventHub.ts";
import type { RuntimeEvent, RuntimeHandle, SubmitInput } from "./RuntimePort.ts";

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
  readonly requestId: string | undefined;

  constructor(kind: ErrorKind, disposition: ErrorDisposition, message: string, requestId?: string) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
    this.disposition = disposition;
    this.requestId = requestId;
  }
}

type Bot = {
  readonly handle: RuntimeHandle;
  readonly hub: EventHub;
  readonly snapshot: ConversationSnapshot;
  /** Publishes what arrived while the first subscription was still rendering. */
  readonly release: () => void;
};

type Connection = { readonly bot: Bot; readonly hub: HubSubscription };

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
   * Opens the bot, subscribes this connection and publishes the snapshot it starts from.
   * The runtime sink is only forwarded after that snapshot, so a late joiner can never
   * see an event numbered before its own baseline.
   */
  async subscribe(
    connectionId: string,
    botId: string,
    trace: string,
    sink: HubSubscriber,
  ): Promise<{ readonly rev: number; readonly snapshot: ConversationSnapshot }> {
    if (this.#connections.has(connectionId)) {
      throw new CommandError(
        "invalid_command",
        "not_admitted",
        "a connection subscribes to one bot for its whole life",
      );
    }
    const bot = await this.#bot(botId, trace);
    const subscription = bot.hub.subscribe(sink);
    this.#connections.set(connectionId, { bot, hub: subscription });
    bot.hub.publishSnapshot(bot.snapshot, trace);
    const rev = bot.hub.rev;
    bot.release();
    return { rev, snapshot: bot.snapshot };
  }

  /** Ends a connection's subscription. The bot stays open for the registry to reclaim. */
  unsubscribe(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) return;
    connection.hub.detach();
    this.#connections.delete(connectionId);
  }

  /**
   * A duplicate `requestId` answers from the stored record without touching the runtime,
   * which is how a lost reply is recovered. The reply is connection-scoped: it carries no
   * revision, and settlements reach everyone through the hub instead.
   */
  async send(connectionId: string, input: SubmitInput): Promise<Submission> {
    const bot = await this.#subscribed(connectionId, input.requestId);
    const stored = await bot.handle.submission({ requestId: input.requestId });
    if (stored !== undefined) return stored;
    return bot.handle.submit(input);
  }

  async #subscribed(connectionId: string, requestId?: string): Promise<Bot> {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      throw new CommandError(
        "invalid_command",
        "not_admitted",
        "the connection has no subscription",
        requestId,
      );
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
    const subscription = await handle.subscribe(trace, (event) => {
      if (!ready) {
        buffered.push(event);
        return;
      }
      hub.publish(event);
    });
    return {
      handle,
      hub,
      snapshot: subscription.snapshot,
      release: () => {
        if (ready) return;
        ready = true;
        for (const event of buffered) hub.publish(event);
      },
    };
  }
}
