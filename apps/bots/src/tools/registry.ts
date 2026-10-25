// The tools a bot is born with (docs/bots/RUNTIME.md, "Tools"): one extension installed in
// the Harness's registry, so the model is offered them from its first request and pi
// executes a call without any approval step.
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { listFilesTool, readFileTool, writeFileTool } from "./files.ts";
import { runCommandTool } from "./shell.ts";
import type { BotWorkspace, ToolOutcome } from "./types.ts";

/** The extension's name; a conversation stores it, so it is part of the runtime contract. */
export const BOTS_TOOLS_EXTENSION = "bots-tools";

const result = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

/** The four tools, with the workspace they are confined to. */
export const createBotsTools = (workspace: BotWorkspace): readonly ToolRegistration[] => [
  defineTool({
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Returns the requested lines; a page over 2 000 lines or 64 KiB is truncated with a note.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, relative to the workspace" }),
      offset: Type.Optional(Type.Number({ description: "First line, 1-based (default 1)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum lines (default 2000)" })),
    }),
    // A read has no side effect, so an interrupted call may rerun after a restart.
    replay: "safe",
    // The page the tool returns is what the SDK keeps, so its own budget is the ceiling.
    outputLimits: { maxBytes: 64 * 1024, maxLines: 2_000, retain: "head" },
    execute: async (args) => result(await readFileTool(workspace, args)),
  }),
  defineTool({
    name: "write_file",
    description:
      "Write a UTF-8 text file into the workspace, creating parent directories. Overwrites the file; the content is at most 512 KiB.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, relative to the workspace" }),
      content: Type.String({ description: "The complete file content" }),
    }),
    outputLimits: { maxBytes: 64 * 1024, maxLines: 2_000, retain: "head" },
    execute: async (args) => result(await writeFileTool(workspace, args)),
  }),
  defineTool({
    name: "list_files",
    description:
      "List files and directories below a workspace directory. Directories end with `/`; common build and dependency directories are skipped.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory to list, relative to the workspace" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum entries (default 2000)" })),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 64 * 1024, maxLines: 2_000, retain: "head" },
    execute: async (args) => result(await listFilesTool(workspace, args)),
  }),
  defineTool({
    name: "run_command",
    description:
      "Run a shell command in the workspace. Returns its stdout, stderr and exit code; it is killed after the timeout (default 30 s, max 120 s) and its output is capped at 64 KiB.",
    parameters: Type.Object({
      command: Type.String({ description: "The command line to run with /bin/sh -c" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory, relative to the workspace" }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Deadline in milliseconds" })),
    }),
    // The exit code is the last line, so the SDK keeps the tail of the output.
    outputLimits: { maxBytes: 64 * 1024, retain: "tail" },
    execute: async (args, _api, context) =>
      result(await runCommandTool(workspace, args, context.abortSignal)),
  }),
];

/**
 * A registry holding the bots-tools extension for one workspace. It is built per Harness:
 * the tools are bound to that bot's workspace, never to another bot's.
 */
export const createToolRegistry = (options: {
  readonly workspaceRoot: string;
  readonly daemonRoot: string;
}) => {
  const workspace: BotWorkspace = {
    root: options.workspaceRoot,
    daemonRoot: options.daemonRoot,
  };
  const workspaceRoot = options.workspaceRoot;
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: BOTS_TOOLS_EXTENSION,
      tools: createBotsTools(workspace),
      sections: [
        section("bots-tools", () =>
          [
            `Your workspace is ${workspaceRoot}. All tool paths are relative to it and cannot leave it.`,
            "Use read_file and list_files before editing, write_file to save a whole file, and run_command for builds and tests.",
            "Tool calls run without asking the user first.",
          ].join("\n"),
        ),
      ],
    }),
  );
  return registry;
};
