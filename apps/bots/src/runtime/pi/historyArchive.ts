import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

export const MAX_ARCHIVE_BYTES = 240 * 1024;
const id = z.string().regex(/^[0-9a-f-]{36}\/[ce][1-9][0-9]*$/);
const text = z.looseObject({ type: z.literal("text"), text: z.string() });
const image = z.looseObject({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const tool = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.json()),
});
const count = z.number().finite().nonnegative();
const usage = z.looseObject({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  totalTokens: count,
  cost: z.looseObject({
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    total: count,
  }),
});
// Preserve provider metadata and object insertion order, including prompt sections.
const messageShape = z.discriminatedUnion("role", [
  z.looseObject({
    role: z.literal("system"),
    content: z.union([z.string(), z.array(text)]),
    timestamp: count,
    sections: z.record(z.string(), z.string().nullable()).optional(),
    toolsAdded: z
      .array(
        z.looseObject({
          name: z.string(),
          description: z.string(),
          parameters: z.record(z.string(), z.json()),
        }),
      )
      .optional(),
    toolsRemoved: z.array(z.json()).optional(),
  }),
  z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([text, image]))]),
    timestamp: count,
  }),
  z.looseObject({
    role: z.literal("assistant"),
    content: z.array(
      z.union([text, tool, z.looseObject({ type: z.literal("thinking"), thinking: z.string() })]),
    ),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    usage,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    timestamp: count,
  }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([text, image])),
    isError: z.boolean(),
    timestamp: count,
  }),
]);
const message = z.custom<Message>((value) => messageShape.safeParse(value).success);
export const archivePayload = z.strictObject({
  version: z.literal(1),
  engine: z.literal("pi-durable@1.4.0"),
  conversationId: id,
  branchId: id,
  botId: z.string().min(1).max(80),
  entries: z
    .array(
      z.strictObject({
        id,
        originId: z.uuid(),
        conversationId: id,
        kind: z.string().min(1).max(100),
        model: z.array(message).optional(),
        data: z.json().optional(),
        head: id.optional(),
        edits: z
          .array(
            z.discriminatedUnion("action", [
              z.strictObject({ target: id, action: z.literal("omit") }),
              z.strictObject({
                target: id,
                action: z.literal("replace"),
                messages: z.array(message),
              }),
            ]),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(2048),
});
export const archiveSchema = archivePayload.extend({ head: z.string().regex(/^[a-f0-9]{64}$/) });
export type HistoryArchive = z.infer<typeof archiveSchema>;
export type HistoryEntry = HistoryArchive["entries"][number];
export const archiveHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class HistoryInputError extends Error {}
export const historyReject = (message: string): never => {
  throw new HistoryInputError(message);
};

/** Validate raw records: SDK context assembly repairs missing results and cannot prove completeness. */
export const validateArchive = (input: unknown): HistoryArchive => {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > MAX_ARCHIVE_BYTES)
    historyReject("history archive too large");
  if (!z.json().safeParse(input).success) historyReject("history must be JSON");
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) return historyReject("invalid history archive");
  const archive = parsed.data;
  const { head, ...payload } = archive;
  if (head !== archiveHash(payload)) historyReject("history digest mismatch");
  const seen = new Set<string>();
  const calls = new Map<string, string>();
  let final: Message | undefined;
  let user = false;
  for (const entry of archive.entries) {
    if (
      seen.has(entry.id) ||
      !entry.id.startsWith(`${entry.originId}/e`) ||
      !entry.conversationId.startsWith(`${entry.originId}/c`)
    )
      historyReject("history record identity conflict");
    if (entry.head !== undefined && entry.head !== entry.id && !seen.has(entry.head))
      historyReject("history head reference missing");
    for (const edit of entry.edits ?? [])
      if (!seen.has(edit.target)) historyReject("history edit reference missing");
    seen.add(entry.id);
    for (const item of entry.model ?? []) {
      if (item.role === "assistant") {
        if (calls.size !== 0) historyReject("history tool group incomplete");
        if (item.stopReason === "error" || item.stopReason === "aborted") continue;
        for (const block of item.content)
          if (block.type === "toolCall") {
            if (calls.has(block.id)) historyReject("history tool call duplicated");
            calls.set(block.id, block.name);
          }
      } else if (item.role === "toolResult") {
        if (calls.get(item.toolCallId) !== item.toolName)
          historyReject("history tool result orphaned");
        calls.delete(item.toolCallId);
      }
      // Compaction summaries are context, not a new uncompleted user turn.
      if (
        item.role === "assistant" ||
        (item.role === "user" && !(entry.kind === "pi.compaction" && entry.head !== undefined))
      ) {
        if (item.role === "user") {
          if (calls.size !== 0) historyReject("history tool group incomplete");
          user = true;
        }
        final = item;
      }
    }
  }
  if (
    calls.size !== 0 ||
    !user ||
    final?.role !== "assistant" ||
    !["stop", "length"].includes(final.stopReason)
  )
    historyReject("history is not a complete turn");
  const marker = archive.entries.findLast((entry) => entry.head !== undefined);
  const range =
    marker === undefined
      ? archive.entries
      : archive.entries.slice(archive.entries.findIndex((entry) => entry.id === marker.head));
  const edits = new Map(
    range.flatMap((entry) => (entry.edits ?? []).map((edit) => [edit.target, edit] as const)),
  );
  const active =
    marker === undefined ? range : [marker, ...range.filter((entry) => entry.head === undefined)];
  for (const entry of active) {
    const edit = edits.get(entry.id);
    const messages =
      edit === undefined ? (entry.model ?? []) : edit.action === "omit" ? [] : edit.messages;
    for (const item of messages) {
      if (item.role === "assistant" && !["error", "aborted"].includes(item.stopReason)) {
        if (calls.size !== 0) historyReject("history edited tool group incomplete");
        for (const block of item.content)
          if (block.type === "toolCall") calls.set(block.id, block.name);
      } else if (item.role === "toolResult") {
        if (calls.get(item.toolCallId) !== item.toolName)
          historyReject("history edited tool result orphaned");
        calls.delete(item.toolCallId);
      }
    }
  }
  if (calls.size !== 0) historyReject("history edited tool group incomplete");
  return archive;
};
