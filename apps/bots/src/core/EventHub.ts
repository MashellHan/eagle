// Fanout and revision ownership for one bot (docs/bots/PROTOCOL.md, "Server events").
// The hub numbers every bot-scoped event on a per-bot sequence and is the only place
// that decides what a subscriber receives. It speaks domain events: encoding a frame is
// the wire layer's job, so core never imports protocol.
import type { ConversationSnapshot } from "./domain.ts";
import type { RuntimeEvent } from "./RuntimePort.ts";

/** A runtime event after the hub has given it a revision. */
export type HubEvent = RuntimeEvent & { readonly rev: number };
export type HubSubscriber = (event: HubEvent) => void;

export type HubSubscription = { readonly id: string; detach(): void };

export class EventHub {
  readonly #botId: string;
  readonly #defaultTrace: string;
  readonly #subscribers = new Map<string, HubSubscriber>();
  #rev = 0;
  #nextId = 1;

  constructor(botId: string, trace: string) {
    this.#botId = botId;
    this.#defaultTrace = trace;
  }

  get botId(): string {
    return this.#botId;
  }

  /** The revision of the last event this hub published. */
  get rev(): number {
    return this.#rev;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  subscribe(subscriber: HubSubscriber): HubSubscription {
    const id = `sub_${this.#nextId}`;
    this.#nextId += 1;
    this.#subscribers.set(id, subscriber);
    return { id, detach: () => this.#subscribers.delete(id) };
  }

  /** Publishes a bot-scoped event with the next revision and fans it out. */
  publish(event: RuntimeEvent): HubEvent {
    const stamped: HubEvent = { ...event, rev: this.#nextRevision() };
    for (const subscriber of [...this.#subscribers.values()]) subscriber(stamped);
    return stamped;
  }

  /** A snapshot takes a revision like any other bot-scoped event. */
  publishSnapshot(value: ConversationSnapshot, trace = this.#defaultTrace): HubEvent {
    return this.publish({ type: "snapshot", trace, value });
  }

  /** A connection-scoped reply carries the command trace and no revision. */
  reply(event: RuntimeEvent): RuntimeEvent {
    return event;
  }

  #nextRevision(): number {
    this.#rev += 1;
    return this.#rev;
  }
}
