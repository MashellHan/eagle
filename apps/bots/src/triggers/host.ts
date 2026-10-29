// The bridge between a bot's stored definitions and the tools that manage them
// (docs/bots/TRIGGERS.md §7). It is composition only: the store owns durability and the
// rules, the tool layer owns the model-facing surface, and this file owns neither.
import type { TriggerDefinition, TriggerStore } from "../core/TriggerStore.ts";
import type { TriggerToolHost, TriggerView } from "../tools/types.ts";

const view = (trigger: TriggerDefinition): TriggerView => ({
  id: trigger.id,
  kind: trigger.kind,
  name: trigger.name,
  prompt: trigger.prompt,
  enabled: trigger.enabled,
  ...(trigger.schedule === undefined
    ? {}
    : {
        schedule: {
          cron: trigger.schedule.cron,
          timezone: trigger.schedule.timezone,
          ...(trigger.schedule.cursor === undefined ? {} : { cursor: trigger.schedule.cursor }),
        },
      }),
  counters: trigger.counters,
  ...(trigger.lastFiredAt === undefined ? {} : { lastFiredAt: trigger.lastFiredAt }),
  ...(trigger.lastSkipped === undefined ? {} : { lastSkipped: trigger.lastSkipped }),
});

/** A schedule without a zone uses the daemon's, which is the machine's local zone. */
const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const triggerHost = (botId: string, store: TriggerStore): TriggerToolHost => ({
  botId,
  create: async (input) => {
    const { trigger, created } = await store.create({
      opId: input.opId,
      kind: input.kind,
      name: input.name,
      prompt: input.prompt,
      ...(input.kind === "schedule"
        ? {
            schedule: {
              cron: input.cron ?? "",
              timezone: input.timezone ?? localZone(),
            },
          }
        : {}),
    });
    return { trigger: view(trigger), created };
  },
  list: async () => store.list().map(view),
  update: async (input) =>
    view(
      await store.update({
        opId: input.opId,
        triggerId: input.triggerId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      }),
    ),
  enable: async (input) =>
    view(
      await store.enable({
        opId: input.opId,
        triggerId: input.triggerId,
        enabled: input.enabled,
      }),
    ),
  remove: (input) => store.remove({ opId: input.opId, triggerId: input.triggerId }),
  // The credential stays in the app; the model only needs to know where a delivery goes.
  endpoint: (triggerId) => `/v1/triggers/${botId}/${triggerId}`,
});
