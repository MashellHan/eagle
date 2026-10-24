// Fanout and revision ownership for one bot (docs/bots/PROTOCOL.md, "Server events").
// The hub numbers every bot-scoped event on a per-bot sequence and is the only place
// that decides what a subscriber receives. It speaks domain events: encoding a frame is
// the wire layer's job, so core never imports protocol and the byte measurement is
// injected by the layer that encodes.
import type { ConversationSnapshot } from "./domain.ts";
import type { RuntimeEvent } from "./RuntimePort.ts";

/** A runtime event after the hub has given it a revision. */
export type HubEvent = RuntimeEvent & { readonly rev: number };
export type HubSubscriber = (event: HubEvent) => void;

export type HubSubscription = { readonly id: string; detach(): void };

/** A subscriber that falls this far behind is downgraded to snapshot-only. */
export const SUBSCRIBER_QUEUE_LIMIT = 256;
export const SUBSCRIBER_BYTE_LIMIT = 1024 * 1024;

/** Soft batch limit for coalesced deltas (docs/bots/PROTOCOL.md#limits). */
export const DELTA_BATCH_BYTE_LIMIT = 96 * 1024;
export const DELTA_FLUSH_MS = 50;

export type HubOptions = {
  readonly schedule?: (run: () => void) => void;
  /** Encoded bytes of one event, measured by the transport that will write it. */
  readonly measure?: (event: RuntimeEvent) => number;
};

type Queued = { readonly event: HubEvent; readonly bytes: number };

type Slot = {
  readonly id: string;
  readonly send: HubSubscriber;
  readonly manual: boolean;
  queue: Queued[];
  bytes: number;
  degraded: boolean;
};

const wireBytes = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

export class EventHub {
  readonly #botId: string;
  readonly #defaultTrace: string;
  readonly #slots = new Map<string, Slot>();
  readonly #schedule: (run: () => void) => void;
  readonly #measure: (event: RuntimeEvent) => number;
  #rev = 0;
  #nextId = 1;
  /** Deltas still inside the coalescing window; they do not consume a revision yet. */
  #pendingDeltas: (RuntimeEvent & { type: "delta" })[] = [];
  #pendingBytes = 0;
  #flushScheduled = false;
  /** Events numbered and waiting for their turn on the per-bot serial queue. */
  #dispatch: HubEvent[] = [];
  #delivering = false;

  constructor(botId: string, trace: string, options: HubOptions = {}) {
    this.#botId = botId;
    this.#defaultTrace = trace;
    this.#schedule =
      options.schedule ??
      ((run) => {
        setTimeout(run, DELTA_FLUSH_MS);
      });
    this.#measure = options.measure ?? wireBytes;
  }

  get botId(): string {
    return this.#botId;
  }

  /** The revision of the last event this hub numbered. */
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
    return {
      id,
      detach: () => {
        const slot = this.#slots.get(id);
        if (slot !== undefined) {
          slot.queue = [];
          slot.bytes = 0;
        }
        this.#slots.delete(id);
      },
    };
  }

  /** True once the subscriber fell too far behind and was downgraded. */
  degraded(id: string): boolean {
    return this.#slots.get(id)?.degraded === true;
  }

  /** Delivers everything queued for a manual subscriber. */
  pump(id: string): void {
    const slot = this.#slots.get(id);
    if (slot === undefined) return;
    if (this.#delivering) {
      this.#drain(slot);
      return;
    }
    this.#delivering = true;
    try {
      this.#drain(slot);
    } finally {
      this.#delivering = false;
    }
    this.#runDispatch();
  }

  /**
   * Publishes a bot-scoped event. A delta only enters the coalescing window here; its
   * revision is assigned when the batch it lands in is actually broadcast, so no
   * subscriber ever observes a numbered event that was folded away.
   */
  publish(event: RuntimeEvent): void {
    if (event.type === "delta") {
      this.#queueDelta(event);
      return;
    }
    this.#flushDeltas();
    this.#enqueue({ ...event, rev: this.#nextRevision() });
  }

  publishSnapshot(value: ConversationSnapshot, trace = this.#defaultTrace): void {
    this.publish({ type: "snapshot", trace, value });
  }

  /** Delivers anything still coalescing. Tests call this instead of waiting. */
  drain(): void {
    this.#flushDeltas();
    this.#runDispatch();
  }

  #queueDelta(event: RuntimeEvent & { type: "delta" }): void {
    const bytes = this.#measure(event);
    // A batch never grows past the soft limit: flushes happen between whole changes, so
    // a single oversized change still travels alone instead of being split.
    if (this.#pendingDeltas.length > 0 && this.#pendingBytes + bytes > DELTA_BATCH_BYTE_LIMIT) {
      this.#flushDeltas();
    }
    this.#pendingDeltas.push(event);
    this.#pendingBytes += bytes;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    this.#schedule(() => {
      this.#flushScheduled = false;
      this.#flushDeltas();
      this.#runDispatch();
    });
  }

  #flushDeltas(): void {
    const pending = this.#pendingDeltas;
    if (pending.length === 0) return;
    this.#pendingDeltas = [];
    this.#pendingBytes = 0;
    for (const group of groupByMessage(pending)) {
      this.#enqueue({ ...mergeDeltas(group), rev: this.#nextRevision() });
    }
  }

  #enqueue(event: HubEvent): void {
    this.#dispatch.push(event);
    this.#runDispatch();
  }

  #runDispatch(): void {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      while (this.#dispatch.length > 0) {
        const event = this.#dispatch.shift();
        if (event === undefined) break;
        this.#fanout(event);
      }
    } finally {
      this.#delivering = false;
    }
  }

  #fanout(event: HubEvent): void {
    const bytes = this.#measure(event);
    for (const slot of this.#slots.values()) this.#offer(slot, event, bytes);
  }

  #offer(slot: Slot, event: HubEvent, bytes: number): void {
    if (slot.degraded) {
      // Snapshot-only: increments are dropped, and the newest snapshot is kept as the
      // recovery anchor until it is delivered. That anchor is never evicted by later
      // increments, so a behind subscriber always has a way back.
      if (event.type !== "snapshot") return;
      slot.queue = [{ event, bytes }];
      slot.bytes = bytes;
    } else if (
      slot.queue.length + 1 > SUBSCRIBER_QUEUE_LIMIT ||
      slot.bytes + bytes > SUBSCRIBER_BYTE_LIMIT
    ) {
      // Falling behind downgrades the subscriber instead of stalling the hub.
      slot.degraded = true;
      slot.queue = [];
      slot.bytes = 0;
      return;
    } else {
      slot.queue.push({ event, bytes });
      slot.bytes += bytes;
    }
    if (!slot.manual) this.#drain(slot);
  }

  #drain(slot: Slot): void {
    // A synchronous sink keeps the queue empty; one that throws is dropped from the hub.
    while (slot.queue.length > 0) {
      // A sink may detach itself (or be dropped) in the middle of a pump.
      if (this.#slots.get(slot.id) !== slot) return;
      const next = slot.queue.shift();
      if (next === undefined) return;
      slot.bytes -= next.bytes;
      // Delivering the anchor makes the subscriber contiguous again.
      if (next.event.type === "snapshot") slot.degraded = false;
      try {
        slot.send(next.event);
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

/** Consecutive deltas for one message travel together; a different message starts a group. */
type DeltaEvent = RuntimeEvent & { type: "delta" };

const groupByMessage = (events: readonly DeltaEvent[]): DeltaEvent[][] => {
  const groups: DeltaEvent[][] = [];
  let current: DeltaEvent[] = [];
  let target: string | undefined;
  for (const event of events) {
    if (current.length > 0 && event.messageId !== target) {
      groups.push(current);
      current = [];
    }
    target = event.messageId;
    current.push(event);
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

/**
 * Folds consecutive deltas for one message into a single event. Content is preserved:
 * appends concatenate per block index, and block/message replacements keep their whole
 * payload in the original order.
 */
const mergeDeltas = (events: readonly DeltaEvent[]): DeltaEvent => {
  const first = events[0];
  if (first === undefined) throw new Error("a delta batch holds deltas");
  const last = events[events.length - 1] as DeltaEvent;
  const changes: Record<string, unknown>[] = [];
  for (const event of events) {
    for (const change of event.changes) {
      const prior = changes[changes.length - 1];
      if (
        prior !== undefined &&
        (change.kind === "text" || change.kind === "thinking") &&
        prior.kind === change.kind &&
        prior.index === change.index
      ) {
        prior.append = `${String(prior.append)}${change.append}`;
        continue;
      }
      changes.push({ ...change });
    }
  }
  return { ...last, type: "delta", messageId: last.messageId, changes: changes as never };
};
