import { createRegistry, defineExtension, section, wrapTool } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import { DEFAULT_TOOL_GROUPS, resolveToolGroups, type ToolGroup } from "../core/domain.ts";
import { agentsExtension } from "./agents/tools.ts";
import {
  createHerdrTools,
  HERDR_TOOLS_EXTENSION,
  type HerdrToolOptions,
  herdrSection,
} from "./herdr/tools.ts";
import { createListTool } from "./list.ts";
import type { BotWorkspace } from "./types.ts";

export const BOTS_TOOLS_EXTENSION = "bots-tools";

const bash = createBashTool({
  prepare(execution) {
    execution.inheritEnv = false;
    execution.env = {};
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"]) {
      const value = process.env[name];
      if (value !== undefined) execution.env[name] = value;
    }
    execution.env.TERM = "dumb";
    execution.env.PWD = execution.cwd;
  },
});

export type ToolRegistryOptions = {
  /** The groups this bot was given; `core` and `coding` are always included. */
  readonly groups?: readonly ToolGroup[];
  /** Herdr tools need the CLI client and this bot's state directory. */
  readonly herdr?: Omit<HerdrToolOptions, "workspace">;
};

export const createToolRegistry = (workspace: BotWorkspace, options: ToolRegistryOptions = {}) => {
  const groups = resolveToolGroups(options.groups ?? DEFAULT_TOOL_GROUPS);
  const herdr = groups.includes("herdr") ? options.herdr : undefined;
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: BOTS_TOOLS_EXTENSION,
      tools: [createListTool()],
      wraps: [wrapTool(bash, () => bash)],
      sections: [
        section("bots-tools", ({ agent }) =>
          [
            `Your default working directory is ${agent.cwd ?? workspace.root}.`,
            "Use list to discover files, read to inspect them, edit for targeted changes, write for whole files, and bash for commands.",
            "Tool calls run without asking the user first.",
          ].join("\n"),
        ),
      ],
    }),
  );
  registry.install(CodingTools);
  if (groups.includes("agents")) registry.install(agentsExtension());
  // Deferred tools need their loader; without one the model would never see them.
  if (herdr !== undefined) registry.install(createToolSearchExtension());
  if (herdr !== undefined) {
    registry.install(
      defineExtension({
        name: HERDR_TOOLS_EXTENSION,
        tools: createHerdrTools({ ...herdr, workspace }),
        sections: [section("bots-herdr", () => herdrSection(herdr.botId))],
      }),
    );
  }
  return registry;
};
