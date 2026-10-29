// The bot's own triggers as tools (docs/bots/EXTENSIONS-AND-TOOLS.md §6.3): a Bot creates
// and manages its schedules and webhooks, a person only sees them and can switch them. The
// host is bound per Bot, so a tool can never name another Bot's trigger or another Bot.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { failed, type ToolOutcome, type TriggerToolHost, type TriggerView } from "../types.ts";

export const TRIGGER_TOOLS_EXTENSION = "bots-trigger";

const MAX_OUTPUT_BYTES = 50 * 1024;

const clip = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  let clipped = text;
  while (Buffer.byteLength(clipped, "utf8") > MAX_OUTPUT_BYTES) {
    clipped = clipped.slice(0, Math.floor(clipped.length * 0.9));
  }
  return `${clipped}\n[output truncated]`;
};

const result = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

/** One compact line per trigger: enough to act on, short enough to list eight of them. */
const line = (host: TriggerToolHost, trigger: TriggerView): string => {
  const schedule =
    trigger.schedule === undefined
      ? ""
      : ` · ${trigger.schedule.cron} ${trigger.schedule.timezone}` +
        (trigger.schedule.cursor === undefined ? "" : ` · next ${trigger.schedule.cursor}`);
  const webhook = trigger.kind === "webhook" ? ` · ${host.endpoint(trigger.id)}` : "";
  const counters = ` · fired ${trigger.counters.fired}, dropped ${trigger.counters.dropped}, refused ${trigger.counters.refused}`;
  const skipped =
    trigger.lastSkipped === undefined
      ? ""
      : ` · last skipped ${trigger.lastSkipped.at} (${trigger.lastSkipped.reason})`;
  return `${trigger.id} · ${trigger.kind} · ${trigger.name} · ${trigger.enabled ? "enabled" : "disabled"}${schedule}${webhook}${counters}${skipped}`;
};

/** The tool-task id is the durable operation id; the model never supplies one. */
const operationId = (api: { readonly taskId: unknown }): string => String(api.taskId);

export const createTriggerTools = (host: TriggerToolHost): readonly ToolRegistration[] => [
  defineTool({
    name: "trigger_create",
    description:
      "Create a trigger that will send this bot a message later: a schedule (cron) or a webhook endpoint. The trigger's prompt is the standing instruction the bot receives each time it fires. A trigger named like an existing one returns that trigger instead of creating a second. A bot holds at most eight triggers.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("schedule"), Type.Literal("webhook")], {
        description: "schedule uses cron and timezone; webhook waits for an HTTP delivery",
      }),
      name: Type.String({ description: "Short name a person sees in the sidebar" }),
      prompt: Type.String({
        description: "What the bot should do when the trigger fires",
      }),
      cron: Type.Optional(
        Type.String({ description: "Five-field cron, minute resolution, e.g. 0 9 * * *" }),
      ),
      timezone: Type.Optional(
        Type.String({ description: "IANA zone for the schedule, e.g. Asia/Shanghai" }),
      ),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const { trigger, created } = await host.create({
          opId: operationId(api),
          kind: args.kind,
          name: args.name,
          prompt: args.prompt,
          ...(args.cron === undefined ? {} : { cron: args.cron }),
          ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
        });
        return result({
          output: clip(`${created ? "created" : "existing"}: ${line(host, trigger)}`),
        });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "trigger_list",
    description:
      "List this bot's triggers with what each one is, whether it is enabled, its next due instant and its counters. Creates nothing.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      try {
        const triggers = await host.list();
        if (triggers.length === 0) return result({ output: "no triggers" });
        return result({ output: clip(triggers.map((trigger) => line(host, trigger)).join("\n")) });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "trigger_update",
    description:
      "Change a trigger's name or its prompt. The schedule and the enabled switch are separate operations, and a pending queue is never touched.",
    parameters: Type.Object({
      triggerId: Type.String({ description: "Id from trigger_list, e.g. t_abcd2ef3gh" }),
      name: Type.Optional(Type.String({ description: "New short name" })),
      prompt: Type.Optional(Type.String({ description: "New standing instruction" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const trigger = await host.update({
          opId: operationId(api),
          triggerId: args.triggerId,
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        });
        return result({ output: clip(`updated: ${line(host, trigger)}`) });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "trigger_enable",
    description:
      "Switch a trigger on or off without touching what is already queued. Switching a schedule off and on again never fires anything it missed while off.",
    parameters: Type.Object({
      triggerId: Type.String({ description: "Id from trigger_list" }),
      enabled: Type.Boolean({ description: "true to run it, false to pause it" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const trigger = await host.enable({
          opId: operationId(api),
          triggerId: args.triggerId,
          enabled: args.enabled,
        });
        return result({
          output: clip(`${trigger.enabled ? "enabled" : "disabled"}: ${line(host, trigger)}`),
        });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "trigger_delete",
    description:
      "Remove one trigger and everything it queued. Deleting a trigger that no longer exists succeeds.",
    parameters: Type.Object({
      triggerId: Type.String({ description: "Id from trigger_list" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        await host.remove({
          opId: operationId(api),
          triggerId: args.triggerId,
        });
        return result({ output: `deleted ${args.triggerId}` });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
];

/** A store refusal is a model-visible message; anything else is a bug the model cannot fix. */
const messageOf = (error: unknown): string =>
  error instanceof Error && error.name === "TriggerStoreError"
    ? error.message
    : "the trigger could not be changed";

export const triggerExtension = (host: TriggerToolHost) =>
  defineExtension({
    name: TRIGGER_TOOLS_EXTENSION,
    tools: createTriggerTools(host),
    sections: [section("bots-trigger", () => triggerSection(host.botId))],
  });

export const triggerSection = (botId: string): string =>
  [
    `Triggers send this bot a message later, without a person typing: a schedule (cron) or a webhook endpoint that other services POST to. Use trigger_create, trigger_list, trigger_update, trigger_enable and trigger_delete.`,
    `A trigger's prompt is an instruction to this bot, not a person's message; keep it self-contained, because the run that receives it has no other context from now.`,
    `At most eight triggers per bot. The person can see them in the sidebar and switch them on or off; only this bot creates, edits or deletes them.`,
    `The webhook endpoint is local to this machine (${botId}); a service on another machine needs the user's own tunnel.`,
  ].join("\n");
