// Fanout and revision ownership for one bot (docs/bots/PROTOCOL.md, "Server events").
// The hub numbers every bot-scoped event on a per-bot sequence and is the only place
// that decides what a subscriber receives. It speaks domain events: encoding a frame is
// the wire layer's job, so core never imports protocol and the encoded size is injected.
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type { ConversationSnapshot, DeltaChange } from "./domain.ts";
import { newFailure } from "./failures.ts";
import type { RuntimeEvent } from "./RuntimePort.ts";

const Events = {
  publishOk: declareEvent("core.hub.publish.ok"),
  coalesceOk: declareEvent("core.hub.coalesce.ok"),
  snapshotOk: declareEvent("core.hub.snapshot.ok"),
  degrade: declareEvent("core.hub.degrade"),
} as const;

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
  /** Encoded bytes of one event, measured by the transport that will write it. */
  readonly measure: (event: RuntimeEvent) => number;
  readonly schedule?: (run: () => void) => void;
  /** Fanout is a crossing, so it is recorded; the hub owns no logging policy itself. */
  readonly log?: Log;
};

type Queued = { readonly event: HubEvent; readonly bytes: number };

type PendingChange = {
  readonly trace: string;
  readonly messageId: string;
  readonly change: DeltaChange;
  readonly bytes: number;
};

type Slot = {
  readonly id: string;
  readonly send: HubSubscriber;
  readonly manual: boolean;
  queue: Queued[];
  bytes: number;
  degraded: boolean;
  /** While degraded, the newest snapshot is the only thing worth holding. */
  anchor: Queued | undefined;
  /** True once an increment was lost after the anchor, making the anchor stale. */
  stale: boolean;
};

export class EventHub {
  readonly #botId: string;
  readonly #defaultTrace: string;
  readonly #slots = new Map<string, Slot>();
  readonly #schedule: (run: () => void) => void;
  readonly #measure: (event: RuntimeEvent) => number;
  readonly #log: Log | undefined;
  #rev = 0;
  #nextId = 1;
  /** Deltas still inside the coalescing window; they do not consume a revision yet. */
  #pendingChanges: PendingChange[] = [];
  #pendingBytes = 0;
  #flushScheduled = false;
  /** Events numbered and waiting for their turn on the per-bot serial queue. */
  #dispatch: HubEvent[] = [];
  /** Manual pumps requested while the serial section is running, including cross-slot ones. */
  #pumps = new Set<string>();
  #delivering = false;

  constructor(botId: string, trace: string, options: HubOptions) {
    this.#botId = botId;
    this.#defaultTrace = trace;
    this.#measure = options.measure;
    this.#log = options.log;
    this.#schedule =
      options.schedule ??
      ((run) => {
        setTimeout(run, DELTA_FLUSH_MS);
      });
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
      anchor: undefined,
      stale: false,
    });
    return {
      id,
      detach: () => {
        const slot = this.#slots.get(id);
        if (slot !== undefined) {
          slot.queue = [];
          slot.bytes = 0;
          slot.anchor = undefined;
        }
        this.#slots.delete(id);
      },
    };
  }

  /** True while the subscriber is snapshot-only and waiting for a current snapshot. */
  degraded(id: string): boolean {
    return this.#slots.get(id)?.degraded === true;
  }

  /** Delivers everything queued for a manual subscriber. */
  pump(id: string): void {
    if (!this.#slots.has(id)) return;
    // Requests are queued rather than served inline, so a pump from inside a sink never
    // re-enters a sink and a pump for another subscriber is not lost.
    this.#pumps.add(id);
    this.#runSerial();
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
    this.#push({ ...event, rev: this.#nextRevision() });
    this.#runSerial();
  }

  /** Publishes a snapshot and returns it, so a caller can name the revision it carries. */
  publishSnapshot(value: ConversationSnapshot, trace = this.#defaultTrace): HubEvent {
    this.#flushDeltas();
    const stamped: HubEvent = { type: "snapshot", trace, value, rev: this.#nextRevision() };
    this.#push(stamped);
    this.#runSerial();
    return stamped;
  }

  /** Delivers anything still coalescing. Tests call this instead of waiting. */
  drain(): void {
    this.#flushDeltas();
    this.#runSerial();
  }

  #queueDelta(event: RuntimeEvent & { type: "delta" }): void {
    // The window is split by whole changes, never by events: one event may carry several
    // large replacements and must not become one oversized frame.
    for (const change of event.changes) {
      const bytes = this.#measure({
        type: "delta",
        trace: event.trace,
        messageId: event.messageId,
        changes: [change],
      });
      if (this.#pendingChanges.length > 0 && this.#pendingBytes + bytes > DELTA_BATCH_BYTE_LIMIT) {
        this.#flushDeltas();
      }
      this.#pendingChanges.push({ trace: event.trace, messageId: event.messageId, change, bytes });
      this.#pendingBytes += bytes;
    }
    this.#scheduleFlush();
    this.#runSerial();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    this.#schedule(() => {
      this.#flushScheduled = false;
      this.#flushDeltas();
      this.#runSerial();
    });
  }

  /**
   * Numbers and queues every pending batch at once. Nothing is delivered until the caller
   * runs the serial queue, so a sink that publishes cannot slip in between two batches.
   */
  #flushDeltas(): void {
    const pending = this.#pendingChanges;
    if (pending.length === 0) return;
    this.#pendingChanges = [];
    this.#pendingBytes = 0;
    for (const group of groupChanges(pending)) {
      const last = group[group.length - 1];
      if (last === undefined) continue;
      const changes = mergeChanges(group.map((item) => item.change));
      const bytes = group.reduce((total, item) => total + item.bytes, 0);
      this.#log?.emit("debug", "core", Events.coalesceOk, {
        trace: last.trace,
        botId: this.#botId,
        detail: { count: group.length, bytes },
      });
      this.#push({
        type: "delta",
        trace: last.trace,
        messageId: last.messageId,
        changes,
        rev: this.#nextRevision(),
      });
    }
  }

  #push(event: HubEvent): void {
    if (event.type === "snapshot") {
      this.#log?.emit("info", "core", Events.snapshotOk, {
        trace: event.trace,
        botId: this.#botId,
        rev: event.rev,
      });
    }
    this.#dispatch.push(event);
  }

  /**
   * One serial section per bot: fanout and manual pumps never interleave, so every
   * subscriber observes revisions in the same order and no sink is called re-entrantly.
   */
  #runSerial(): void {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      while (true) {
        const event = this.#dispatch.shift();
        if (event !== undefined) this.#fanout(event);
        // Requested pumps run after every fanout, never after the whole queue: a sink
        // that keeps publishing would otherwise starve the subscriber it pumped.
        if (this.#pumps.size > 0) {
          const requests = [...this.#pumps];
          this.#pumps.clear();
          for (const id of requests) {
            const slot = this.#slots.get(id);
            if (slot !== undefined) this.#drain(slot);
          }
          continue;
        }
        if (event === undefined) break;
      }
    } finally {
      this.#delivering = false;
    }
  }

  #fanout(event: HubEvent): void {
    const bytes = this.#measure(event);
    this.#log?.emit("info", "core", Events.publishOk, {
      trace: event.trace,
      botId: this.#botId,
      rev: event.rev,
      detail: {
        kind: event.type,
        count: this.#slots.size,
        ...(event.type === "delta" ? { messageId: event.messageId } : {}),
      },
    });
    for (const slot of this.#slots.values()) this.#offer(slot, event, bytes);
  }

  #offer(slot: Slot, event: HubEvent, bytes: number): void {
    if (slot.degraded) {
      // Snapshot-only: increments are dropped. The newest snapshot becomes the anchor,
      // but it can only be used while nothing after it was lost.
      if (event.type === "snapshot") {
        slot.anchor = { event, bytes };
        slot.stale = false;
      } else if (slot.anchor !== undefined) {
        slot.stale = true;
      }
      return;
    }
    if (
      slot.queue.length + 1 > SUBSCRIBER_QUEUE_LIMIT ||
      slot.bytes + bytes > SUBSCRIBER_BYTE_LIMIT
    ) {
      // Falling behind downgrades the subscriber instead of stalling the hub. A snapshot
      // is itself the recovery, so the event that triggers the overflow becomes the
      // anchor instead of being thrown away.
      this.#log?.emit("warn", "core", Events.degrade, {
        trace: event.trace,
        botId: this.#botId,
        failure: newFailure("internal", "core"),
        detail: { reason: "queue_overflow", count: slot.queue.length + 1 },
      });
      slot.degraded = true;
      slot.queue = [];
      slot.bytes = 0;
      if (event.type === "snapshot") {
        slot.anchor = { event, bytes };
        slot.stale = false;
      } else {
        slot.anchor = undefined;
        slot.stale = true;
      }
      return;
    }
    slot.queue.push({ event, bytes });
    slot.bytes += bytes;
    if (!slot.manual) this.#drain(slot);
  }

  #drain(slot: Slot): void {
    while (true) {
      // A sink may detach itself (or be dropped) in the middle of a pump.
      if (this.#slots.get(slot.id) !== slot) return;
      const next = this.#next(slot);
      if (next === undefined) return;
      try {
        slot.send(next);
      } catch {
        this.#slots.delete(slot.id);
        return;
      }
    }
  }

  /** Takes the next deliverable event, or re-anchors a degraded subscriber. */
  #next(slot: Slot): HubEvent | undefined {
    if (slot.degraded) {
      const anchor = slot.anchor;
      // A stale anchor would leave the client silently wrong, so it is dropped and the
      // subscriber stays snapshot-only until a current snapshot arrives.
      if (anchor === undefined || slot.stale) return undefined;
      slot.anchor = undefined;
      slot.degraded = false;
      return anchor.event;
    }
    const queued = slot.queue.shift();
    if (queued === undefined) return undefined;
    slot.bytes -= queued.bytes;
    return queued.event;
  }

  #nextRevision(): number {
    this.#rev += 1;
    return this.#rev;
  }
}

/** Consecutive changes for one message travel together; another message starts a group. */
const groupChanges = (changes: readonly PendingChange[]): PendingChange[][] => {
  const groups: PendingChange[][] = [];
  let current: PendingChange[] = [];
  let target: string | undefined;
  for (const item of changes) {
    if (current.length > 0 && item.messageId !== target) {
      groups.push(current);
      current = [];
    }
    target = item.messageId;
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

/**
 * Folds one batch into a single change list. Appends concatenate per block index, and
 * block/message replacements keep their whole payload in the original order.
 */
const mergeChanges = (changes: readonly DeltaChange[]): DeltaChange[] => {
  const merged: Record<string, unknown>[] = [];
  for (const change of changes) {
    const prior = merged[merged.length - 1];
    if (
      prior !== undefined &&
      (change.kind === "text" || change.kind === "thinking") &&
      prior.kind === change.kind &&
      prior.index === change.index
    ) {
      prior.append = `${String(prior.append)}${change.append}`;
      continue;
    }
    merged.push({ ...change });
  }
  return merged as never;
};
