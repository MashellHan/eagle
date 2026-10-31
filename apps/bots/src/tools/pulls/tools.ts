// The pull requests a Bot reports (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group): the model
// registers a link, a title and a state, and the App shows it. The daemon never asks a forge
// anything, so a tool call is the only writer and a replay returns what it stored.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  failed,
  PULL_STATUSES,
  type PullStatus,
  type PullToolHost,
  type ToolOutcome,
} from "../types.ts";

export const PULLS_TOOLS_EXTENSION = "bots-pulls";

const result = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "the daemon refused the report";

/** The closed set is validated here, where the model meets it, not in the store. */
const statusOf = (value: string): PullStatus => {
  const status = value.trim().toLowerCase();
  if (!(PULL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`status must be one of ${PULL_STATUSES.join(", ")}`);
  }
  return status as PullStatus;
};

/** The durable tool-task id: a replayed call is the same report, not a second one. */
const operationId = (api: { readonly taskId: unknown }): string => String(api.taskId);

const line = (pull: {
  readonly url: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
}): string => `${pull.status} · ${pull.title} · ${pull.url} · ${pull.updatedAt}`;

export const createPullTools = (host: PullToolHost): readonly ToolRegistration[] => [
  defineTool({
    name: "pr_register",
    description:
      "Record one pull request the person should see: its link, title and current state. Reporting the same link again updates that entry, so report every change of state. Any http(s) link is accepted (GitHub, Azure DevOps, GitLab, …); the daemon never queries it.",
    parameters: Type.Object({
      url: Type.String({ description: "The pull request's own link" }),
      title: Type.String({ description: "One line a person can scan, 1-200 characters" }),
      status: Type.Union(
        PULL_STATUSES.map((status) => Type.Literal(status)),
        {
          description:
            "draft, open, reviewing, merged, closed or failed — the state people see as a colour",
        },
      ),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const { pull, created } = await host.register({
          opId: operationId(api),
          url: args.url,
          title: args.title,
          status: statusOf(args.status),
        });
        return result({ output: `${created ? "registered" : "updated"}: ${line(pull)}` });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "pr_list",
    description:
      "List the pull requests this bot has registered, newest first. Reporting is not querying: a state that changed on the forge appears here only after pr_register reports it again.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      try {
        const pulls = await host.list();
        if (pulls.length === 0) return result({ output: "no pull requests registered" });
        return result({ output: pulls.map((pull) => line(pull)).join("\n") });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
];

export const pullsExtension = (host: PullToolHost) =>
  defineExtension({
    name: PULLS_TOOLS_EXTENSION,
    tools: createPullTools(host),
    sections: [section("bots-pulls", () => pullSection(host.botId))],
  });

export const pullSection = (botId: string): string =>
  [
    `Pull requests you open, wait on or merge are worth reporting: pr_register records one link, its title and its state, and pr_list shows what this bot (${botId}) has reported.`,
    `Report every state change — the row only follows you. The daemon never queries the forge, so a merged pull request stays "open" here until you say otherwise.`,
    `Use one entry per pull request: the same link updates that row instead of adding another.`,
  ].join("\n");
