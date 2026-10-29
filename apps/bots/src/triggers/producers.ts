// The daemon's producers (docs/bots/TRIGGERS.md §3.6): one pump per bot and one schedule
// ticker. Starting and stopping them in one place is what keeps shutdown ordered — they
// stop before admissions drain, so nothing new arrives while the registry closes handles.
import type { InvocationPort } from "../core/Invocation.ts";
import type { TriggerStore } from "../core/TriggerStore.ts";
import { BotDrainPump, type PumpTrigger } from "./pump.ts";
import type { TriggerQueue } from "./queue.ts";
import { type ScheduleTick, ScheduleTicker } from "./schedule.ts";

export type ProducerWiring = {
  /** Catalogued bot ids; the ticker walks exactly these. */
  readonly bots: () => readonly string[];
  readonly storeFor: (botId: string) => Promise<TriggerStore>;
  readonly queueFor: (botId: string, triggerId: string) => Promise<TriggerQueue>;
  /** The invocation port: the pump admits through the same door a person's message uses. */
  readonly port: InvocationPort;
  readonly now: () => Date;
  readonly newTrace: () => string;
  readonly periodMs?: number;
  readonly setTimer?: (run: () => void, delayMs: number) => () => void;
  readonly onTick?: (outcome: {
    readonly botId: string;
    readonly triggerId: string;
    readonly tick: ScheduleTick;
  }) => void;
};

export class TriggerProducers {
  readonly #wiring: ProducerWiring;
  readonly #pumps = new Map<string, BotDrainPump>();
  readonly #ticker: ScheduleTicker;
  #started = false;

  constructor(wiring: ProducerWiring) {
    this.#wiring = wiring;
    this.#ticker = new ScheduleTicker({
      sources: async () =>
        Promise.all(
          wiring.bots().map(async (botId) => ({
            botId,
            store: await wiring.storeFor(botId),
            queueFor: (triggerId: string) => wiring.queueFor(botId, triggerId),
          })),
        ),
      now: wiring.now,
      ...(wiring.periodMs === undefined ? {} : { periodMs: wiring.periodMs }),
      ...(wiring.setTimer === undefined ? {} : { setTimer: wiring.setTimer }),
      onTick: (outcome) => wiring.onTick?.(outcome),
    });
  }

  /** The pump for one bot, created and started on first use. */
  pumpFor(botId: string): BotDrainPump {
    const known = this.#pumps.get(botId);
    if (known !== undefined) return known;
    const pump = new BotDrainPump({
      botId,
      triggers: async (): Promise<PumpTrigger[]> => {
        const store = await this.#wiring.storeFor(botId);
        const enabled = store.list().filter((trigger) => trigger.enabled);
        return Promise.all(
          enabled.map(async (trigger) => ({
            id: trigger.id,
            kind: trigger.kind,
            prompt: trigger.prompt,
            queue: await this.#wiring.queueFor(botId, trigger.id),
          })),
        );
      },
      deps: {
        invoke: (input) => this.#wiring.port.invoke(input),
        submission: (query) => this.#wiring.port.submission(query),
        observe: (id, sink) => this.#wiring.port.observe(id, sink),
        now: this.#wiring.now,
        newTrace: this.#wiring.newTrace,
      },
    });
    this.#pumps.set(botId, pump);
    if (this.#started) pump.start();
    return pump;
  }

  /** A due instant has to reach the pump: the ticker only enqueues it. */
  async tick(): Promise<void> {
    await this.#ticker.tick();
    for (const pump of this.#pumps.values()) await pump.drain();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const botId of this.#wiring.bots()) this.pumpFor(botId);
    this.#ticker.start();
  }

  stop(): void {
    this.#started = false;
    this.#ticker.stop();
    for (const pump of this.#pumps.values()) pump.stop();
  }
}
