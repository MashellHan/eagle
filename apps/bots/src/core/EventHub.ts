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

/** A subscriber that falls this far behind is downgraded to snapshot-only. */
export const SUBSCRIBER_QUEUE_LIMIT = 256;
export const SUBSCRIBER_BYTE_LIMIT = 1024 * 1024;

type Slot = {
  readonly id: string;
  readonly send: HubSubscriber;
  readonly manual: boolean;
  queue: HubEvent[];
  bytes: number;
  degraded: boolean;
};

/** Coalescing window for deltas (docs/bots/PROTOCOL.md#limits). */
export const DELTA_FLUSH_MS = 50;

export class EventHub {
  readonly #botId: string;
  readonly #defaultTrace: string;
  readonly #slots = new Map<string, Slot>();
  readonly #clock: () => number;
  readonly #flush: (run: () => void) => void;
  #rev = 0;
  #nextId = 1;
  #pendingDeltas: HubEvent[] = [];
  #pendingBytes = 0;
  #flushScheduled = false;

  constructor(
    botId: string,
    trace: string,
    options: { clock?: () => number; schedule?: (run: () => void) => void } = {},
  ) {
    this.#botId = botId;
    this.#defaultTrace = trace;
    this.#clock = options.clock ?? (() => Date.now());
    this.#flush =
      options.schedule ??
      ((run) => {
        setTimeout(run, DELTA_FLUSH_MS);
      });
  }

  get botId(): string {
    return this.#botId;
  }

  get rev(): number {
    return this.#rev;
  }

  get subscriberCount(): number {
    return this.#slots.size;
  }

  /**
   * `manual` subscribers only queue: a test (or a slow transport) drains them itself,
   * which is what makes backpressure observable.
   */
  subscribe(subscriber: HubSubscriber, options: { manual?: boolean } = {}): HubSubscription {
    const id = `sub_${this.#nextId}`;
    this.#nextId += 1;
    this.#slots.set(id, {
      id,
      send: subscriber,
      manual: options.manual === true,
      queue: [],
      bytes: 0,
      degraded: false,
    });
    return { id, detach: () => this.#slots.delete(id) };
  }

  /** True once the subscriber fell too far behind and was downgraded. */
  degraded(id: string): boolean {
    return this.#slots.get(id)?.degraded === true;
  }

  /** Delivers everything queued for a manual subscriber. */
  pump(id: string): void {
    const slot = this.#slots.get(id);
    if (slot === undefined || slot.degraded) return;
    this.#drain(slot);
  }

  /** Publishes a bot-scoped event with the next revision and fans it out. */
  publish(event: RuntimeEvent): HubEvent {
    const stamped: HubEvent = { ...event, rev: this.#nextRevision() };
    if (event.type === "delta") {
      // Deltas are coalesced inside the window so a streaming answer is not one frame
      // per token; every other event flushes them first, which keeps revision order.
      this.#pendingDeltas.push(stamped);
      this.#pendingBytes += encodedSize(stamped);
      this.#scheduleFlush();
      return stamped;
    }
    this.#flushPendingDeltas();
    this.#deliver(stamped);
    return stamped;
  }

  publishSnapshot(value: ConversationSnapshot, trace = this.#defaultTrace): HubEvent {
    return this.publish({ type: "snapshot", trace, value });
  }

  reply(event: RuntimeEvent): RuntimeEvent {
    return event;
  }

  /** Delivers anything still coalescing. Tests call this instead of waiting. */
  drain(): void {
    this.#flushPendingDeltas();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    this.#flush(() => {
      this.#flushScheduled = false;
      this.#flushPendingDeltas();
    });
  }

  #flushPendingDeltas(): void {
    const pending = this.#pendingDeltas;
    if (pending.length === 0) return;
    this.#pendingDeltas = [];
    this.#pendingBytes = 0;
    const merged = mergeDeltas(pending);
    if (merged !== undefined) this.#deliver(merged);
  }

  #deliver(event: HubEvent): void {
    for (const slot of this.#slots.values()) this.#offer(slot, event);
  }

  #offer(slot: Slot, event: HubEvent): void {
    if (slot.degraded) return; // snapshot-only: nothing else is sent
    const size = encodedSize(event);
    if (
      slot.queue.length + 1 > SUBSCRIBER_QUEUE_LIMIT ||
      slot.bytes + size > SUBSCRIBER_BYTE_LIMIT
    ) {
      // Falling behind downgrades the subscriber instead of stalling the hub.
      slot.degraded = true;
      slot.queue = [];
      slot.bytes = 0;
      return;
    }
    slot.queue.push(event);
    slot.bytes += size;
    if (slot.manual) return;
    this.#drain(slot);
  }

  #drain(slot: Slot): void {
    // A synchronous sink keeps the queue empty; one that throws is dropped from the hub.
    while (slot.queue.length > 0) {
      const next = slot.queue.shift();
      if (next === undefined) break;
      slot.bytes -= encodedSize(next);
      try {
        slot.send(next);
      } catch {
        this.#slots.delete(slot.id);
        return;
      }
    }
  }

  #nextRevision(): number {
    this.#rev += 1;
    return this.#rev;
  }
}

const encodedSize = (event: HubEvent): number => JSON.stringify(event).length;

/**
 * Folds consecutive deltas for one message into a single event, keeping the last
 * revision. Content is preserved: appends concatenate per block index.
 */
const mergeDeltas = (events: readonly HubEvent[]): HubEvent | undefined => {
  const first = events[0];
  if (first === undefined) return undefined;
  const last = events[events.length - 1] as HubEvent;
  if (events.length === 1) return first;
  const groups = new Map<string, { kind: string; index?: number; append?: string }[]>();
  for (const event of events) {
    if (event.type !== "delta") return undefined;
    const bucket = groups.get(event.messageId) ?? [];
    for (const change of event.changes) {
      if (change.kind === "text" || change.kind === "thinking") {
        const prior = bucket.find(
          (entry) => entry.kind === change.kind && entry.index === change.index,
        );
        if (prior) prior.append = (prior.append ?? "") + change.append;
        else bucket.push({ kind: change.kind, index: change.index, append: change.append });
      } else {
        bucket.push({ kind: change.kind });
      }
    }
    groups.set(event.messageId, bucket);
  }
  const [messageId, changes] = [...groups.entries()][0] ?? [];
  if (messageId === undefined || changes === undefined) return undefined;
  return {
    ...last,
    type: "delta",
    messageId,
    changes: changes as never,
  };
};
