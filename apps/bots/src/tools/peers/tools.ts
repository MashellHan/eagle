// Talking to another local bot as a tool (docs/bots/EXTENSIONS-AND-TOOLS.md §6.4): one message to
// one bot, admitted through the daemon's invocation port, answered in that bot's own transcript.
// The host is bound per Bot, so a tool can never name who is speaking, and the turn budget lives in
// the daemon: a send that would spend it is refused instead of quietly opening another exchange.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { failed, type PeerToolHost, type ToolOutcome } from "../types.ts";

export const PEERS_TOOLS_EXTENSION = "bots-peers";

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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "the daemon refused the call";

/** The durable tool-task id, never a model-supplied identity (TRIGGERS.md §10). */
const taskId = (api: { readonly taskId: unknown }): string => String(api.taskId);

export const createPeerTools = (host: PeerToolHost): readonly ToolRegistration[] => [
  defineTool({
    name: "peer_list",
    description:
      "List the other bots on this machine that you can message one-to-one. Returns a stable bot id, its name and its observed availability. This bot is never in the list, and listing starts no work.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Match this text against bot names, case-insensitive" }),
      ),
      cursor: Type.Optional(
        Type.String({ description: "nextCursor from a previous peer_list call" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Default 20, at most 100" }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        const { items, nextCursor } = await host.list({
          limit: args.limit ?? 20,
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        });
        if (items.length === 0) return result({ output: "no other bots to message" });
        const lines = items.map((item) => `${item.botId} · ${item.title} · ${item.availability}`);
        if (nextCursor !== undefined) lines.push(`more: cursor ${nextCursor}`);
        return result({ output: clip(lines.join("\n")) });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "peer_send",
    description:
      "Send one message to one other bot and return immediately: this acknowledges admission, not an answer. The answer appears later in that bot's own transcript; read it with peer_read. Each exchange allows each side a limited number of messages, and the call is refused when this side has spent them, so put everything the other bot needs into one message.",
    parameters: Type.Object({
      botId: Type.String({ description: "A botId from peer_list; never a name or a guess" }),
      message: Type.String({
        description:
          "What that bot should do or know, written as a complete instruction: it has no access to this conversation",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      if (args.message.length > host.maxMessage) {
        return result(
          failed(
            `message is too long: ${args.message.length} characters, at most ${host.maxMessage}`,
          ),
        );
      }
      try {
        const sent = await host.send({
          taskId: taskId(api),
          toBotId: args.botId.trim(),
          message: args.message,
        });
        const budget =
          sent.remaining === 0
            ? "this side of the exchange is now spent: do not send again"
            : `${sent.remaining} more message(s) allowed from you`;
        return result({
          output: clip(
            `admitted · to=${sent.toBotId} · requestId=${sent.requestId} · ${sent.status} · exchange=${sent.exchangeId} ${sent.exchangeStatus} · ${sent.sent} sent · ${budget}`,
          ),
        });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "peer_read",
    description:
      "Read what a bot answered to a message you sent: pass the requestId peer_send returned. Without a requestId it lists your own recent outbound messages, so a lost acknowledgement is recoverable. It never submits anything and never reads another bot's conversation.",
    parameters: Type.Object({
      botId: Type.Optional(Type.String({ description: "Only list messages sent to this bot" })),
      requestId: Type.Optional(
        Type.String({ description: "The requestId peer_send returned, to read that one answer" }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        if (args.requestId !== undefined) {
          const read = await host.read({ requestId: args.requestId.trim() });
          const lines = [
            `${read.requestId} · to=${read.toBotId} · ${read.status}${
              read.reason === undefined ? "" : ` (${read.reason})`
            }`,
          ];
          if (read.answer !== undefined) lines.push("", read.answer);
          return result({ output: clip(lines.join("\n")) });
        }
        const receipts = await host.receipts({
          limit: 20,
          ...(args.botId === undefined ? {} : { toBotId: args.botId.trim() }),
        });
        if (receipts.length === 0) return result({ output: "no messages sent yet" });
        return result({
          output: clip(
            receipts
              .map((item) => `${item.requestId} · to=${item.toBotId} · ${item.status} · ${item.at}`)
              .join("\n"),
          ),
        });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
];

export const peersExtension = (host: PeerToolHost) =>
  defineExtension({
    name: PEERS_TOOLS_EXTENSION,
    tools: createPeerTools(host),
    sections: [section("bots-peers", () => peersSection(host.botId))],
  });

/**
 * The budget and the stopping rule, in the model's own prompt: the daemon refuses a spent side, but
 * a bot that understands the limit stops before it gets there.
 */
export const peersSection = (botId: string): string =>
  [
    `You can message other local bots one-to-one: peer_list finds them, peer_send hands one message to one bot, peer_read reads what that bot answered. You are ${botId}.`,
    `Each exchange between two bots allows each side at most 10 messages. When your side has sent 10, peer_send is refused; when both sides reach 10 the exchange closes. Sending is not free for the reader either: prefer one complete message over several small ones, and never send an acknowledgement for its own sake.`,
    `Stop when the exchange stops making progress: when the reply repeats what you already know, asks nothing you can answer, or the other bot cannot help. Then say so once — or send nothing — and return to your own task. Do not ping-pong pleasantries, and do not relay the same content back and forth.`,
    `peer_send returns admission, not an answer: the other bot runs on its own time, so a peer_read in the same turn usually says queued or placed. Say that you are waiting and end your turn; read again with that requestId next turn. Never invent or paraphrase an answer you have not read.`,
    `Reading never starts another turn for the other bot.`,
  ].join("\n");
