// Subagents (docs/bots/RUNTIME.md, "Subagents"): a bot delegates a self-contained task to a
// child conversation it owns, driven through this extension rather than a second product.
// The child is an ordinary ownerless conversation in the same Harness, configured from the
// caller's agent minus these tools, so a child cannot spawn children of its own.
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type Extension,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { failed, type ToolOutcome } from "../types.ts";

export const AGENTS_TOOLS_EXTENSION = "bots-agents";

/** The tools a child must never get: one level of delegation, never a tree of it. */
const AGENT_TOOLS = ["agent_spawn", "agent_send", "agent_stop"] as const;

const result = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

const agentId = (value: string): ConversationId | undefined => {
  const parsed = Number(value.replace(/^c_/, ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? (parsed as ConversationId) : undefined;
};

/** The text of one committed message entry, as the child's answer. */
const entryText = (record: { model?: unknown } | undefined): string => {
  const messages = (record as { model?: readonly { content?: unknown }[] } | undefined)?.model;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { type?: string; text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
};

export const createAgentTools = (): readonly ToolRegistration[] => [
  defineTool({
    name: "agent_spawn",
    description:
      "Start a child agent that works on its own and remembers its own conversation. Returns its id; pass that id to agent_send and agent_stop. The child has the same model, reasoning level and tools as you, except that it cannot start children of its own.",
    parameters: Type.Object({
      name: Type.String({
        description: "Short name for the child, for your notes and the run log",
      }),
      instructions: Type.Optional(
        Type.String({ description: "Extra standing instructions for this child only" }),
      ),
    }),
    execute: async (args, api, context) => {
      const parent = await api.agent(context);
      const extensions: Extension[] = parent.extensions.filter(
        (extension) => extension.name !== AGENTS_TOOLS_EXTENSION,
      );
      const child = await api.commit(async (tx) => {
        const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, created.id, {
          ...(parent.model === undefined ? {} : { model: parent.model }),
          thinkingLevel: parent.thinkingLevel,
          extensions,
          tools: parent.tools.filter(
            (tool) => !(AGENT_TOOLS as readonly string[]).includes(tool.name),
          ),
          ...(args.instructions === undefined
            ? parent.instructions === undefined
              ? {}
              : { instructions: parent.instructions }
            : { instructions: args.instructions }),
          ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
        });
        // A marker entry, so a later listing can tell a child apart from a conversation a
        // person created; it carries no `model`, so the child never sees it.
        await tx.appendEntry(created.id, {
          kind: "bots.agent",
          data: {
            name: args.name,
            parentConversationId: api.conversationId,
            createdAt: api.now(),
          },
        });
        return created;
      }, context);
      return result({
        output: `child ${args.name} started as c_${child.id}; pass c_${child.id} to agent_send`,
      });
    },
  }),
  defineTool({
    name: "agent_send",
    description:
      "Send a message to a child agent and wait for its answer. Returns the child's final text, or a failure with the settlement status when it did not answer.",
    parameters: Type.Object({
      agentId: Type.String({ description: "The id agent_spawn returned, for example c_12" }),
      message: Type.String({ description: "What the child should do" }),
    }),
    execute: async (args, api, context) => {
      const id = agentId(args.agentId);
      const child = id === undefined ? undefined : await api.conversation(id, context);
      if (child === undefined) return result(failed(`unknown child agent ${args.agentId}`));
      const submission = await child.submit(
        {
          type: "input",
          content: args.message,
          requestId: `agent:${api.taskId}:${id}:${api.now()}`,
          whenBusy: "followUp",
        },
        context,
      );
      const settled = await submission.wait(context);
      if (settled.status !== "done") {
        const reason = settled.reason === undefined ? "" : ` (${settled.reason})`;
        return result(failed(`the child did not answer${reason}`));
      }
      const answerEntryId = settled.answer ?? settled.entry;
      const record =
        answerEntryId === undefined
          ? undefined
          : await api.commit((tx) => tx.entry(answerEntryId), context);
      const text = entryText(record);
      return result({ output: text.length > 0 ? text : "the child answered without text" });
    },
  }),
  defineTool({
    name: "agent_stop",
    description: "Stop a child agent: its queued work is withdrawn and it stays readable.",
    parameters: Type.Object({
      agentId: Type.String({ description: "The id agent_spawn returned" }),
    }),
    execute: async (args, api, context) => {
      const id = agentId(args.agentId);
      const child = id === undefined ? undefined : await api.conversation(id, context);
      if (child === undefined) return result(failed(`unknown child agent ${args.agentId}`));
      await child.abort(context);
      return result({ output: `child ${args.agentId} stopped` });
    },
  }),
];

export const agentsSection = (): string =>
  [
    "You can delegate a self-contained piece of work to a child agent.",
    "Start one with agent_spawn, give it work with agent_send, and stop it with agent_stop.",
    "A child has its own conversation, the same model and tools, and cannot start children.",
    "Prefer doing the work yourself when it is short: a child costs another model request.",
  ].join("\n");

export const agentsExtension = (): Extension =>
  defineExtension({
    name: AGENTS_TOOLS_EXTENSION,
    tools: createAgentTools(),
    sections: [section("bots-agents", () => agentsSection())],
  });
