// The schedule tick (docs/bots/TRIGGERS.md §9.1): cron in the bot's own zone, a durable
// cursor per trigger, and one journal record per decision so a crash can neither fire twice
// nor lose a fire. Downtime is never replayed: a window that passed while the daemon was off
// is recorded as missed and the cursor moves on.
import { Cron } from "croner";
import type { TriggerStore } from "../core/TriggerStore.ts";
import type { QueueItem, TriggerQueue } from "./queue.ts";

/** A due instant older than this is a missed window, not a fire. */
export const FRESHNESS_MS = 90_000;

export type ScheduleTick =
  | { readonly kind: "idle" }
  | { readonly kind: "armed"; readonly cursor: string }
  | { readonly kind: "fired"; readonly dueAt: string; readonly cursor: string | undefined }
  | { readonly kind: "missed"; readonly dueAt: string; readonly cursor: string | undefined };

/** The instant strictly after `at` that the expression names in its zone. */
export const nextAfter = (cron: string, timezone: string, at: Date): string | undefined => {
  const next = new Cron(cron, { timezone }).nextRun(at);
  return next === null ? undefined : next.toISOString();
};

/** What a schedule fire looks like as an item: the time it was due is its identity. */
const itemFor = (dueAt: string): QueueItem => ({
  itemId: `due_${dueAt}`,
  text: "scheduled",
  receivedAt: dueAt,
});

/**
 * One trigger's tick. The first tick arms the cursor instead of firing, so enabling never
 * catches up on the window it was off for; a dropped fire is recorded, not guessed.
 */
export const tickSchedule = async (input: {
  readonly trigger: {
    readonly id: string;
    readonly enabled: boolean;
    readonly schedule?: { readonly cron: string; readonly timezone: string };
  };
  readonly queue: TriggerQueue;
  readonly now: Date;
  readonly freshnessMs?: number;
}): Promise<ScheduleTick> => {
  const { trigger, queue, now } = input;
  if (trigger.schedule === undefined) return { kind: "idle" };
  const { cron, timezone } = trigger.schedule;
  const freshness = input.freshnessMs ?? FRESHNESS_MS;

  if (!trigger.enabled) {
    if (queue.cursor() !== undefined) await queue.setCursor(undefined);
    return { kind: "idle" };
  }

  const cursor = queue.cursor();
  if (cursor === undefined) {
    const next = nextAfter(cron, timezone, now);
    if (next === undefined) return { kind: "idle" };
    await queue.setCursor(next);
    return { kind: "armed", cursor: next };
  }

  const due = new Date(cursor);
  if (due.getTime() > now.getTime()) return { kind: "idle" };

  const next = nextAfter(cron, timezone, now);
  if (now.getTime() - due.getTime() > freshness) {
    // The daemon was not running when this was due: advance and report, never fire.
    await queue.setCursor(next);
    return { kind: "missed", dueAt: due.toISOString(), cursor: next };
  }

  await queue.fire({ item: itemFor(due.toISOString()), cursorAfter: next });
  return { kind: "fired", dueAt: due.toISOString(), cursor: next };
};

export type ScheduleSource = {
  readonly botId: string;
  readonly store: TriggerStore;
  readonly queueFor: (triggerId: string) => Promise<TriggerQueue>;
};

/**
 * One daemon-wide ticker. The clock and the timer are injected, so a test drives a whole day
 * in a loop instead of waiting for it; the composition root owns start and stop.
 */
export class ScheduleTicker {
  readonly #sources: () => Promise<readonly ScheduleSource[]>;
  readonly #now: () => Date;
  readonly #log: (outcome: {
    readonly botId: string;
    readonly triggerId: string;
    readonly tick: ScheduleTick;
  }) => void;
  readonly #setTimer: (run: () => void, delayMs: number) => () => void;
  readonly #periodMs: number;
  #cancel: (() => void) | undefined;
  #running = false;

  constructor(input: {
    readonly sources: () => Promise<readonly ScheduleSource[]>;
    readonly now: () => Date;
    readonly periodMs?: number;
    readonly setTimer?: (run: () => void, delayMs: number) => () => void;
    readonly onTick?: (outcome: {
      readonly botId: string;
      readonly triggerId: string;
      readonly tick: ScheduleTick;
    }) => void;
  }) {
    this.#sources = input.sources;
    this.#now = input.now;
    this.#periodMs = input.periodMs ?? 15_000;
    this.#setTimer =
      input.setTimer ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      });
    this.#log = input.onTick ?? (() => undefined);
  }

  /** One pass over every bot's schedule triggers. Public so a test or a probe can tick. */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const source of await this.#sources()) {
      for (const trigger of source.store.list()) {
        if (trigger.kind !== "schedule") continue;
        const queue = await source.queueFor(trigger.id);
        const tick = await tickSchedule({
          trigger: {
            id: trigger.id,
            enabled: trigger.enabled,
            ...(trigger.schedule === undefined ? {} : { schedule: trigger.schedule }),
          },
          queue,
          now,
        });
        if (tick.kind !== "idle") this.#log({ botId: source.botId, triggerId: trigger.id, tick });
        if (tick.kind === "fired") {
          await source.store.patch({
            triggerId: trigger.id,
            patch: { lastFiredAt: now.toISOString() },
          });
        }
        if (tick.kind === "missed") {
          await source.store.patch({
            triggerId: trigger.id,
            patch: { lastSkipped: { at: now.toISOString(), reason: "missed" } },
          });
        }
      }
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const schedule = (): void => {
      this.#cancel = this.#setTimer(() => {
        void this.tick()
          .catch(() => undefined)
          .finally(() => {
            if (this.#running) schedule();
          });
      }, this.#periodMs);
    };
    schedule();
  }

  stop(): void {
    this.#running = false;
    this.#cancel?.();
    this.#cancel = undefined;
  }
}
