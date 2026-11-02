import { z } from "zod";
import { archiveHash, archivePayload, historyReject } from "./historyArchive.ts";

export const MAX_HISTORY_PAGE_BYTES = 128 * 1024;
export const MAX_HISTORY_PAGE_RECORDS = 32;
const id = archivePayload.shape.branchId;
export const historyPageRequest = z
  .strictObject({
    selection: z.string().max(128).optional(),
    after: z.string().max(512).optional(),
    before: z.string().max(512).optional(),
    until: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(MAX_HISTORY_PAGE_RECORDS).optional(),
    maxBytes: z.number().int().min(1024).max(MAX_HISTORY_PAGE_BYTES).optional(),
  })
  .refine((value) => value.after === undefined || value.before === undefined);
export type HistoryPageRequest = z.infer<typeof historyPageRequest>;
export const historyPageSchema = z.strictObject({
  version: z.literal(1),
  engine: z.literal("pi-durable@1.4.0"),
  branchId: id,
  conversationId: id,
  botId: z.string().min(1).max(80),
  head: z.string().regex(/^[a-f0-9]{64}$/),
  tip: id.nullable(),
  cursor: z.string().max(512).nullable(),
  snapshot: z.string().max(512).nullable(),
  hasMore: z.boolean(),
  records: z
    .array(z.strictObject({ previous: id.nullable(), entry: archivePayload.shape.entries.element }))
    .max(MAX_HISTORY_PAGE_RECORDS),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export const pageHead = (branchId: string, tip: string | null) => archiveHash({ branchId, tip });
export const validateHistoryPage = (input: unknown): HistoryPage => {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > MAX_HISTORY_PAGE_BYTES)
    historyReject("history page too large");
  const parsed = historyPageSchema.safeParse(input);
  if (!parsed.success) return historyReject("invalid history page");
  const page = parsed.data;
  if (page.head !== pageHead(page.branchId, page.tip)) historyReject("history page head mismatch");
  const stable = (value: string, kind: "c" | "e") => {
    const [origin, sequence] = value.split(`/${kind}`);
    return (
      z.uuid().safeParse(origin).success &&
      Number.isSafeInteger(Number(sequence)) &&
      Number(sequence) > 0
    );
  };
  if (
    !stable(page.branchId, "c") ||
    !stable(page.conversationId, "c") ||
    (page.tip !== null && !stable(page.tip, "e"))
  )
    historyReject("history page identity conflict");
  const seen = new Set<string>();
  for (const [index, { entry, previous }] of page.records.entries()) {
    if (
      seen.has(entry.id) ||
      previous === entry.id ||
      !entry.id.startsWith(`${entry.originId}/e`) ||
      !entry.conversationId.startsWith(`${entry.originId}/c`)
    )
      historyReject("history record identity conflict");
    if (
      !stable(entry.id, "e") ||
      !stable(entry.conversationId, "c") ||
      (previous !== null && !stable(previous, "e")) ||
      (entry.head !== undefined && !stable(entry.head, "e")) ||
      (entry.edits ?? []).some((edit) => !stable(edit.target, "e"))
    )
      historyReject("invalid history reference identity");
    if (index > 0 && previous !== page.records[index - 1]?.entry.id)
      historyReject("history page is not contiguous");
    seen.add(entry.id);
  }
  return page;
};
