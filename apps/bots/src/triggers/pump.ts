// One bot's drain pump (docs/bots/TRIGGERS.md §5.4): it decides when a frozen batch is
// settled, when an unadmitted one is retried, and which trigger cuts next. `running` is a
// hint from `observe`, never a lock — a run can finish before `submit` returns, so the pump
// reconciles the batch against the submission record on every wake instead of waiting for an
// edge that may never come.

import type { Submission } from "../core/domain.ts";
import type { InvocationPort } from "../core/Invocation.ts";
import type { TriggerQueue } from "./queue.ts";

export type PumpTrigger = {
  readonly id: string;
  readonly kind: "schedule" | "webhook";
  readonly prompt: string;
  readonly queue: TriggerQueue;
};

export type PumpDeps = {
  readonly invoke: InvocationPort["invoke"];
  readonly submission: InvocationPort["submission"];
  readonly observe: InvocationPort["observe"];
  readonly now: () => Date;
  /** One trace per admission episode, so a retry keeps the trace it started with. */
  readonly newTrace: () => string;
};

/** A prefix per producer keeps keys readable and unique across trigger kinds (§3.2). */
const prefixOf = (kind: PumpTrigger["kind"]): string => (kind === "schedule" ? "sh" : "wh");

/** A terminal record closes the batch; a queued or placed one means the run owns it. */
const settled = (record: Submission | undefined): boolean =>
  record !== undefined && (record.status === "done" || record.status === "unanswered");

export class BotDrainPump {
  readonly #botId: string;
  readonly #triggers: () => readonly PumpTrigger[] | Promise<readonly PumpTrigger[]>;
  readonly #deps: PumpDeps;
  #running = false;
  #draining: Promise<void> | undefined;
  #again = false;
  /** Round-robin cursor: one busy trigger cannot starve its siblings. */
  #next = 0;
  #detach: (() => void) | undefined;

  constructor(input: {
    readonly botId: string;
    readonly triggers: () => readonly PumpTrigger[] | Promise<readonly PumpTrigger[]>;
    readonly deps: PumpDeps;
  }) {
    this.#botId = input.botId;
    this.#triggers = input.triggers;
    this.#deps = input.deps;
  }

  /** Watches the bot and asks for a drain whenever its work is over. */
  start(): void {
    if (this.#detach !== undefined) return;
    this.#detach = this.#deps.observe(this.#botId, (running) => {
      this.#running = running;
      if (!running) void this.drain();
    }).detach;
    // A backlog from the previous process must not wait for an edge that already happened.
    void this.drain();
  }

  stop(): void {
    this.#detach?.();
    this.#detach = undefined;
  }

  /**
   * One serial evaluation. Concurrent calls coalesce: a wake that arrives while the pump is
   * working sets `#again`, and every caller waits for the same run, so no decision is lost
   * and no two evaluations interleave.
   */
  drain(): Promise<void> {
    if (this.#draining !== undefined) {
      this.#again = true;
      return this.#draining;
    }
    const run = this.#loop().finally(() => {
      this.#draining = undefined;
    });
    this.#draining = run;
    return run;
  }

  async #loop(): Promise<void> {
    // A refusal while the bot already looks idle is a race, not pressure: allow one more
    // round so a stale reading cannot strand the queue, and never more than that.
    let retriesLeft = 1;
    do {
      this.#again = false;
      const outcome = await this.#evaluate();
      if (outcome === "refused" && !this.#running && retriesLeft > 0) {
        retriesLeft -= 1;
        this.#again = true;
      } else if (outcome === "cut") {
        retriesLeft = 1;
      }
    } while (this.#again);
  }

  async #evaluate(): Promise<"idle" | "cut" | "refused"> {
    const triggers = await this.#triggers();
    // 1. Reconcile every frozen batch before anything else: a record that arrived before
    //    `submit` returned still closes its batch and releases the queue.
    let closed = false;
    for (const trigger of triggers) {
      const batch = trigger.queue.openBatch();
      if (batch === undefined) continue;
      const record = await this.#deps.submission({
        botId: this.#botId,
        requestId: batch.requestId,
      });
      if (settled(record)) {
        await trigger.queue.close(batch.batchId);
        closed = true;
        continue;
      }
      if (record !== undefined) return "idle"; // queued or placed: the run owns it
    }
    if (closed) this.#again = true;

    // 2. An unadmitted frozen batch is retried with the same key, but only when no run is
    //    in flight: retrying while busy only burns an admission slot.
    if (this.#running) return "idle";
    for (const trigger of triggers) {
      const batch = trigger.queue.openBatch();
      if (batch === undefined) continue;
      return await this.#admit(trigger, batch.requestId, batch.text);
    }

    // 3. Cut the next batch, round-robin across this bot's triggers.
    const start = this.#next;
    for (let offset = 0; offset < triggers.length; offset += 1) {
      const index = (start + offset) % triggers.length;
      const trigger = triggers[index];
      if (trigger === undefined || trigger.queue.items().length === 0) continue;
      const batch = await trigger.queue.cut({
        kind: trigger.kind,
        prompt: trigger.prompt,
        cutAt: this.#deps.now().toISOString(),
        requestId: (batchId) => `${prefixOf(trigger.kind)}_${trigger.id}_${batchId}`,
      });
      if (batch === undefined) continue;
      this.#next = index + 1;
      return await this.#admit(trigger, batch.requestId, batch.text);
    }
    return "idle";
  }

  /** The atomic refusal belongs here: `reject` is checked inside the admission section. */
  async #admit(
    trigger: PumpTrigger,
    requestId: string,
    text: string,
  ): Promise<"cut" | "refused" | "idle"> {
    try {
      await this.#deps.invoke({
        botId: this.#botId,
        requestId,
        text,
        origin: { kind: trigger.kind, triggerId: trigger.id },
        whenBusy: "reject",
        trace: this.#deps.newTrace(),
      });
      this.#running = true;
      return "cut";
    } catch {
      // Busy, over budget, unconfirmed or unavailable: the batch stays frozen with its key,
      // so the retry is the same admission. The caller is the module's business, not ours.
      return "refused";
    }
  }
}
