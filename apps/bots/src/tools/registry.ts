import {
  createRegistry,
  defineExtension,
  type RegistryReader,
  section,
  wrapTool,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import { resolveToolGroups, type ToolGroup } from "../core/domain.ts";
import { AGENTS_TOOLS_EXTENSION, agentsExtension } from "./agents/tools.ts";
import {
  createHerdrTools,
  HERDR_TOOLS_EXTENSION,
  type HerdrToolOptions,
  herdrSection,
} from "./herdr/tools.ts";
import { createListTool } from "./list.ts";
import { REMOTE_EXTENSION, type RemoteToolOptions, remoteExtension } from "./remote/tools.ts";
import { SEARCH_TOOLS_EXTENSION, searchExtension } from "./search/tools.ts";
import type { BotWorkspace } from "./types.ts";

export const BOTS_TOOLS_EXTENSION = "bots-tools";
const toolSearch = createToolSearchExtension();
const GROUP_EXTENSIONS: Record<ToolGroup, readonly string[]> = {
  core: [BOTS_TOOLS_EXTENSION],
  coding: [CodingTools.name],
  herdr: [HERDR_TOOLS_EXTENSION, toolSearch.name],
  agents: [AGENTS_TOOLS_EXTENSION],
  search: [SEARCH_TOOLS_EXTENSION, toolSearch.name],
  remote: [REMOTE_EXTENSION, toolSearch.name],
};

export const selectToolExtensions = (registry: RegistryReader, groups: readonly string[]) => {
  const installed = new Set(
    registry
      .snapshot()
      .installed()
      .map((extension) => extension.name),
  );
  const names = new Set<string>();
  for (const group of resolveToolGroups(groups)) {
    const [owner, ...rest] = GROUP_EXTENSIONS[group];
    // A group whose own tools are not installed contributes nothing, not even its loader:
    // selecting an unavailable group must not offer a tool_search that can load nothing.
    if (owner === undefined || !installed.has(owner)) continue;
    names.add(owner);
    for (const name of rest) if (installed.has(name)) names.add(name);
  }
  return registry
    .snapshot()
    .installed()
    .filter((extension) => names.has(extension.name));
};

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
  readonly remote?: RemoteToolOptions;
  /** Herdr tools need the CLI client and this bot's state directory. */
  readonly herdr?: Omit<HerdrToolOptions, "workspace">;
  /** Web search needs a provider client; absent when no key is configured. */
  readonly search?: Omit<Parameters<typeof searchExtension>[0], "botId"> & {
    readonly botId: string;
  };
};

export const createToolRegistry = (workspace: BotWorkspace, options: ToolRegistryOptions = {}) => {
  const herdr = options.herdr;
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
  registry.install(agentsExtension());
  if (options.search !== undefined) registry.install(searchExtension(options.search));
  if (options.remote !== undefined) registry.install(remoteExtension(options.remote));
  // Deferred tools need their loader; without one the model would never see them.
  if (herdr !== undefined || options.search !== undefined || options.remote !== undefined)
    registry.install(toolSearch);
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
