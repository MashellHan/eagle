// The herdr tools (docs/bots/RUNTIME.md, "Herdr tools"): a bot may open one space of its
// own, start a controller agent there, talk to it, wait for it, read its screen and close
// the space. Nothing else in the user's session is reachable: every target is resolved
// against the space this bot recorded, and a request for any other pane is refused.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { type BotWorkspace, failed, ToolError, type ToolOutcome } from "../types.ts";
import { resolveInside } from "../workspace.ts";
import { type HerdrClient, HerdrCommandError, type HerdrReadSource } from "./client.ts";

/** The extension's name; a conversation stores it, so it is part of the runtime contract. */
export const HERDR_TOOLS_EXTENSION = "bots-herdr";

/** The kinds `herdr agent start --kind` accepts on this machine's installation. */
const KINDS = new Set([
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "letta",
  "maki",
  "muse",
]);

const STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);
const SOURCES = new Set<HerdrReadSource>(["visible", "recent", "recent-unwrapped", "detection"]);
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_NAME = /^[a-z0-9+_-]{1,24}$/;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_READ_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SPACE_LABEL = 40;

type HerdrState = {
  readonly spaceId: string;
  readonly rootPaneId: string;
  readonly controller?: {
    readonly name: string;
    readonly kind: string;
    readonly paneId: string;
  };
};

export type HerdrToolOptions = {
  readonly client: HerdrClient;
  readonly workspace: BotWorkspace;
  /** The bot's own state directory, outside the workspace the model can write. */
  readonly stateDir: string;
  readonly botId: string;
};

const shortId = (botId: string): string => {
  const normalized = botId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.length === 0 ? "bot" : normalized.slice(0, 8);
};

export const spaceLabelOf = (botId: string): string =>
  `bots-${shortId(botId)}`.slice(0, MAX_SPACE_LABEL);

export const agentPrefixOf = (botId: string): string => `bot-${shortId(botId)}`;

const statePathOf = (stateDir: string): string => join(stateDir, "herdr.json");

const timeoutOf = (value: number | undefined, fallback: number): number =>
  Math.min(Math.max(value ?? fallback, 1), MAX_TIMEOUT_MS);

const describeError = (error: unknown): string => {
  if (error instanceof ToolError) return error.message;
  if (error instanceof HerdrCommandError) return error.message;
  return "the herdr command failed";
};

const readState = async (path: string): Promise<HerdrState | undefined> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<HerdrState>;
    if (typeof parsed.spaceId !== "string" || typeof parsed.rootPaneId !== "string")
      return undefined;
    const controller =
      parsed.controller !== undefined &&
      typeof parsed.controller.name === "string" &&
      typeof parsed.controller.kind === "string" &&
      typeof parsed.controller.paneId === "string"
        ? {
            name: parsed.controller.name,
            kind: parsed.controller.kind,
            paneId: parsed.controller.paneId,
          }
        : undefined;
    return {
      spaceId: parsed.spaceId,
      rootPaneId: parsed.rootPaneId,
      ...(controller === undefined ? {} : { controller }),
    };
  } catch {
    return undefined;
  }
};

const writeState = async (path: string, state: HerdrState): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const clearState = async (path: string): Promise<void> => {
  await rm(path, { force: true });
};

const clipTail = (text: string): string => {
  const encoded = Buffer.from(text);
  if (encoded.length <= MAX_READ_BYTES) return text;
  let slice = encoded.subarray(encoded.length - MAX_READ_BYTES);
  let decoded = slice.toString("utf8");
  for (let guard = 0; guard < 4 && decoded.startsWith("\uFFFD"); guard += 1) {
    slice = slice.subarray(1);
    decoded = slice.toString("utf8");
  }
  return `[showing the last ${MAX_READ_BYTES} bytes]\n${decoded}`;
};

/** The four tools, bound to one bot's own herdr space. */
export const createHerdrTools = (options: HerdrToolOptions): readonly ToolRegistration[] => {
  const { client, workspace, botId } = options;
  const statePath = statePathOf(options.stateDir);
  const label = spaceLabelOf(botId);
  const prefix = agentPrefixOf(botId);
  // The tools share one state file; a call at a time keeps open/start/close ordered.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const requireState = async (): Promise<HerdrState> => {
    const state = await readState(statePath);
    if (state === undefined)
      throw new ToolError("no herdr space is open; call herdr_open_space first");
    return state;
  };

  const verifySpace = async (state: HerdrState, signal?: AbortSignal): Promise<void> => {
    const space = await client.getWorkspace(state.spaceId, { signal, timeoutMs: 30_000 });
    if (space === undefined) {
      throw new ToolError("the herdr space is gone; call herdr_open_space again");
    }
    if (space.label !== label) {
      // The recorded id is not this bot's space: never touch it, and start over.
      throw new ToolError("the recorded herdr space is not this bot's own space");
    }
  };

  const agentsInSpace = async (state: HerdrState, signal?: AbortSignal) => {
    const agents = await client.listAgents({ signal, timeoutMs: 30_000 });
    return agents.filter((agent) => agent.workspaceId === state.spaceId);
  };

  const resolveTarget = async (
    state: HerdrState,
    target: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> => {
    const agents = await agentsInSpace(state, signal);
    const wanted = target ?? state.controller?.name;
    if (wanted === undefined || wanted.length === 0) {
      throw new ToolError("name a target, or start a controller first");
    }
    const found = agents.find((agent) => agent.name === wanted || agent.paneId === wanted);
    if (found === undefined) {
      throw new ToolError(`no agent ${wanted} in this bot's space`);
    }
    return found.name ?? found.paneId;
  };

  const resolveWorkspacePath = (path: string | undefined): Promise<string> =>
    resolveInside(workspace.root, path ?? ".");

  const result = (outcome: ToolOutcome) => ({
    output: [{ type: "text" as const, text: outcome.output }],
    ...(outcome.isError === true ? { isError: true } : {}),
  });
  const run = (work: () => Promise<ToolOutcome>) => serial(work).then(result);

  const tools: ToolRegistration[] = [
    defineTool({
      name: "herdr_open_space",
      description:
        "Open this bot's own herdr space (a workspace with one shell pane) and return its ids. Calling it again reuses the live space. This bot can only reach panes and agents in this space.",
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            description: "Directory inside the workspace for the space (default the root)",
          }),
        ),
      }),
      replay: "safe",
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      execute: (args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            const cwd = await resolveWorkspacePath(args.path);
            const existing = await readState(statePath);
            if (existing !== undefined) {
              const space = await client.getWorkspace(existing.spaceId, {
                signal: context.abortSignal,
                timeoutMs: 30_000,
              });
              if (space !== undefined && space.label === label) {
                const agents = await agentsInSpace(existing, context.abortSignal);
                return {
                  output: [
                    `space ${space.id} (${space.label}) is open`,
                    `root pane ${existing.rootPaneId}`,
                    agents.length === 0
                      ? "no agents yet"
                      : agents
                          .map(
                            (agent) =>
                              `${agent.name ?? agent.paneId}: ${agent.kind} ${agent.status}`,
                          )
                          .join("\n"),
                  ].join("\n"),
                };
              }
            }
            const created = await client.createWorkspace(
              { label, cwd },
              { signal: context.abortSignal, timeoutMs: 60_000 },
            );
            await writeState(statePath, {
              spaceId: created.workspaceId,
              rootPaneId: created.rootPaneId,
            });
            return {
              output: [
                `opened space ${created.workspaceId} (${label}) at ${cwd}`,
                `root pane ${created.rootPaneId}`,
                "start an agent there with herdr_start_controller",
              ].join("\n"),
            };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_start_controller",
      description:
        "Start a controller agent in this bot's space root pane. Kinds are herdr's own (pi, codex, grok, ...). Native agent arguments (model, thinking level) go in args after `--`.",
      parameters: Type.Object({
        kind: Type.String({ description: "Agent kind, for example pi or codex" }),
        name: Type.Optional(
          Type.String({ description: "Agent name matching [a-z][a-z0-9_-]{0,31}" }),
        ),
        args: Type.Optional(
          Type.Array(Type.String({ description: "One native argument passed after --" })),
        ),
      }),
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      execute: (args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            if (!KINDS.has(args.kind)) return failed(`unsupported agent kind: ${args.kind}`);
            const name = args.name ?? `${prefix}-${args.kind}`.slice(0, 32);
            if (!AGENT_NAME.test(name)) {
              return failed(`the agent name must match [a-z][a-z0-9_-]{0,31}: ${name}`);
            }
            const nativeArgs = args.args ?? [];
            if (nativeArgs.length > 24 || nativeArgs.some((arg) => arg.length > 200)) {
              return failed("too many native arguments (at most 24, each at most 200 characters)");
            }
            const state = await requireState();
            await verifySpace(state, context.abortSignal);
            if (state.controller !== undefined) {
              const live = await agentsInSpace(state, context.abortSignal);
              const controller = live.find(
                (agent) =>
                  agent.name === state.controller?.name ||
                  agent.paneId === state.controller?.paneId,
              );
              if (controller !== undefined) {
                return {
                  output: `controller ${state.controller.name} is already running (${controller.status}) in ${controller.paneId}`,
                };
              }
            }
            if (nativeArgs.some((arg) => arg.includes("\0") || arg.includes("\n"))) {
              return failed("an argument may not contain a newline or a null byte");
            }
            await client.startAgent(
              { name, kind: args.kind, paneId: state.rootPaneId, args: nativeArgs },
              { signal: context.abortSignal, timeoutMs: 60_000 },
            );
            await writeState(statePath, {
              spaceId: state.spaceId,
              rootPaneId: state.rootPaneId,
              controller: { name, kind: args.kind, paneId: state.rootPaneId },
            });
            return {
              output: `started ${args.kind} as ${name} in ${state.rootPaneId} (space ${state.spaceId})`,
            };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_list",
      description: "List the agents and panes in this bot's own herdr space.",
      parameters: Type.Object({}),
      replay: "safe",
      outputLimits: { maxBytes: 16 * 1024, maxLines: 300, retain: "head" },
      execute: (_args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            const state = await requireState();
            await verifySpace(state, context.abortSignal);
            const agents = await agentsInSpace(state, context.abortSignal);
            const panes = await client.listPanes(state.spaceId, {
              signal: context.abortSignal,
              timeoutMs: 30_000,
            });
            const lines = [`space ${state.spaceId} (${label})`];
            for (const pane of panes) {
              const agent = agents.find((candidate) => candidate.paneId === pane.paneId);
              const controller = state.controller?.paneId === pane.paneId ? " controller" : "";
              lines.push(
                agent === undefined
                  ? `${pane.paneId}${controller}: shell`
                  : `${pane.paneId}${controller}: ${agent.kind}${agent.name ? ` ${agent.name}` : ""} ${agent.status}`,
              );
            }
            return { output: lines.join("\n") };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_send",
      description:
        "Send a prompt to an agent in this bot's space (default the controller) and, by default, wait for it to settle. Use herdr_read to fetch the answer.",
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({ description: "Agent name or pane id in this bot's space" }),
        ),
        text: Type.String({ description: "The message to submit" }),
        wait: Type.Optional(
          Type.Boolean({ description: "Wait for a settled state (default true)" }),
        ),
        timeoutMs: Type.Optional(Type.Number({ description: "Deadline in milliseconds" })),
      }),
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      execute: (args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            const text = args.text;
            if (text.trim().length === 0) return failed("a message is required");
            if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
              return failed(`the message exceeds ${MAX_PROMPT_BYTES} bytes`);
            }
            if (text.includes("\0")) return failed("the message contains a null byte");
            const state = await requireState();
            await verifySpace(state, context.abortSignal);
            const target = await resolveTarget(state, args.target, context.abortSignal);
            const reached = await client.prompt(
              { target, text, wait: args.wait ?? true },
              {
                signal: context.abortSignal,
                timeoutMs: timeoutOf(args.timeoutMs, DEFAULT_TIMEOUT_MS),
              },
            );
            return { output: `sent to ${target}: ${reached}` };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_wait",
      description:
        "Wait for an agent in this bot's space to reach a state, or for any settled state (idle, done, blocked) when `until` is omitted.",
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({ description: "Agent name or pane id in this bot's space" }),
        ),
        until: Type.Optional(
          Type.Array(Type.String({ description: "One of idle, working, blocked, done, unknown" })),
        ),
        timeoutMs: Type.Optional(Type.Number({ description: "Deadline in milliseconds" })),
      }),
      replay: "safe",
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      execute: (args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            for (const until of args.until ?? []) {
              if (!STATES.has(until)) return failed(`unknown state: ${until}`);
            }
            const state = await requireState();
            await verifySpace(state, context.abortSignal);
            const target = await resolveTarget(state, args.target, context.abortSignal);
            const reached = await client.wait(
              { target, until: args.until },
              {
                signal: context.abortSignal,
                timeoutMs: timeoutOf(args.timeoutMs, DEFAULT_TIMEOUT_MS),
              },
            );
            return { output: `${target}: ${reached}` };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_read",
      description:
        "Read the recent screen output of an agent in this bot's space. The answer keeps the newest text when the read is larger than the cap.",
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({ description: "Agent name or pane id in this bot's space" }),
        ),
        lines: Type.Optional(
          Type.Number({ description: "Rows to read (default 200, at most 2000)" }),
        ),
        source: Type.Optional(
          Type.String({ description: "visible, recent, recent-unwrapped (default) or detection" }),
        ),
      }),
      replay: "safe",
      outputLimits: { maxBytes: 128 * 1024, maxLines: 4_000, retain: "tail" },
      execute: (args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            const source = args.source ?? "recent-unwrapped";
            if (!SOURCES.has(source as HerdrReadSource)) {
              return failed(`unknown source: ${source}`);
            }
            if (
              args.lines !== undefined &&
              (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > MAX_READ_LINES)
            ) {
              return failed(`lines must be an integer between 1 and ${MAX_READ_LINES}`);
            }
            const lines = args.lines ?? 200;
            const state = await requireState();
            await verifySpace(state, context.abortSignal);
            const target = await resolveTarget(state, args.target, context.abortSignal);
            const text = await client.read(
              { target, lines, source: source as HerdrReadSource },
              { signal: context.abortSignal, timeoutMs: 30_000 },
            );
            return { output: clipTail(text) };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_keys",
      description:
        "Send logical keys (esc, enter, ctrl+c, 1, ...) to an agent in this bot's space, for example to clear a dialog the controller is blocked on.",
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({ description: "Agent name or pane id in this bot's space" }),
        ),
        keys: Type.Array(Type.String({ description: "One logical key per entry" })),
      }),
      outputLimits: { maxBytes: 4 * 1024, maxLines: 50, retain: "head" },
      execute: (args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            if (args.keys.length === 0 || args.keys.length > 8) {
              return failed("send between 1 and 8 keys");
            }
            for (const key of args.keys) {
              if (!KEY_NAME.test(key)) return failed(`not a logical key: ${key}`);
            }
            const state = await requireState();
            await verifySpace(state, context.abortSignal);
            const target = await resolveTarget(state, args.target, context.abortSignal);
            await client.sendKeys(
              { target, keys: args.keys },
              { signal: context.abortSignal, timeoutMs: 30_000 },
            );
            return { output: `sent ${args.keys.join(" ")} to ${target}` };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "herdr_close_space",
      description:
        "Close this bot's own herdr space and forget it. Refuses to close any space this bot did not open.",
      parameters: Type.Object({}),
      outputLimits: { maxBytes: 4 * 1024, maxLines: 50, retain: "head" },
      execute: (_args, _api, context) =>
        run(async (): Promise<ToolOutcome> => {
          try {
            const state = await readState(statePath);
            if (state === undefined) return { output: "no herdr space is open" };
            await verifySpace(state, context.abortSignal);
            await client.closeWorkspace(state.spaceId, {
              signal: context.abortSignal,
              timeoutMs: 30_000,
            });
            await clearState(statePath);
            return { output: `closed space ${state.spaceId} (${label})` };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
  ];

  return tools;
};

/** The section that tells the model what the herdr tools may touch. */
export const herdrSection = (botId: string): string =>
  [
    `You own one herdr space named ${spaceLabelOf(botId)}; open it with herdr_open_space.`,
    "Only agents and panes inside that space are reachable. Any other target is refused.",
    "Start one controller with herdr_start_controller, talk to it with herdr_send, watch it with herdr_wait, and read its answer with herdr_read.",
    "When the work is done, close the space with herdr_close_space.",
  ].join("\n");
