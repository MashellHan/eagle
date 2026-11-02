import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationId,
  type Cursor,
  defineDoc,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type Harness,
  InboxDoc,
  type Tx,
} from "@earendil-works/pi-durable";
import type { HistoryContinuation, HistoryReceipt } from "../../core/RuntimePort.ts";
import { convertMessage } from "./convert.ts";
import {
  archiveHash,
  type HistoryArchive,
  type HistoryEntry,
  historyReject,
  MAX_ARCHIVE_BYTES,
  validateArchive,
} from "./historyArchive.ts";
import { convertSubmission } from "./mapEvents.ts";

type Provenance = { id: string; originId: string; conversationId: string };
type Branch = { nativeId: number; conversationId: string; botId: string };
type Head = Branch & { branchId: string; records: string[]; entries: number[] };
const HistoryState = defineDoc({
  kind: "bots.history",
  version: 1,
  scope: "session",
  initial: () => ({
    originId: randomUUID(),
    records: {} as Record<string, Provenance>,
    branches: {} as Record<string, Branch>,
    heads: {} as Record<string, Head>,
    continuations: {} as Record<string, { head: string; text: string; branchId: string }>,
  }),
  checkpointWhen: () => true,
});

const entries = async (tx: Tx, conversationId: ConversationId, at?: EntryId) => {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  let bytes = 0;
  do {
    const page = await tx.scanEntries(
      { conversationId, order: "ascending", ...(at === undefined ? {} : { maxEntryId: at }) },
      128,
      cursor,
    );
    bytes += Buffer.byteLength(JSON.stringify(page.items));
    if (bytes > MAX_ARCHIVE_BYTES) historyReject("history archive too large");
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
};

const assertIdle = async (tx: Tx, conversationId: ConversationId) => {
  const inbox = await tx.doc(InboxDoc, conversationId);
  if (inbox.items.length !== 0) historyReject("history is active");
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ conversationId }, 128, cursor);
    if (page.items.some((task) => task.state.status !== "terminal"))
      historyReject("history is active");
    cursor = page.next;
  } while (cursor !== undefined);
};

/** Local history only: instantiated on explicit operations, never on open/submit. */
export class NativeHistory {
  readonly #harness: Harness;
  readonly #rootId: ConversationId;
  readonly #botId: string;

  constructor(harness: Harness, rootId: ConversationId, botId: string) {
    this.#harness = harness;
    this.#rootId = rootId;
    this.#botId = botId;
  }

  async export(branchId?: string): Promise<HistoryArchive> {
    return this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const saved = branchId === undefined ? undefined : state.heads[branchId];
      const selected = saved ?? (branchId === undefined ? undefined : state.branches[branchId]);
      if (branchId !== undefined && selected === undefined) historyReject("unknown history branch");
      const nativeId = (selected?.nativeId ?? this.#rootId) as ConversationId;
      if (saved === undefined) await assertIdle(tx, nativeId);
      const all = await entries(tx, nativeId, saved?.entries.at(-1) as EntryId | undefined);
      const provenance = (entry: EntryRecord): Provenance =>
        state.records[String(entry.id)] ?? {
          id: `${state.originId}/e${entry.id}`,
          originId: state.originId,
          conversationId: `${state.originId}/c${entry.conversationId}`,
        };
      const refs = new Map(all.map((entry) => [entry.id, provenance(entry).id]));
      const ref = (id: EntryId) =>
        refs.get(id) ?? historyReject("missing native history reference");
      const payload = {
        version: 1 as const,
        engine: "pi-durable@1.4.0" as const,
        conversationId: selected?.conversationId ?? `${state.originId}/c${nativeId}`,
        branchId: saved?.branchId ?? branchId ?? `${state.originId}/c${nativeId}`,
        botId: selected?.botId ?? this.#botId,
        entries: all.map(
          (entry): HistoryEntry => ({
            ...provenance(entry),
            kind: entry.kind,
            ...(entry.model === undefined ? {} : { model: [...entry.model] }),
            ...(entry.data === undefined ? {} : { data: entry.data }),
            ...(entry.head === undefined ? {} : { head: ref(entry.head) }),
            ...(entry.edits === undefined
              ? {}
              : {
                  edits: entry.edits.map((edit) =>
                    edit.action === "replace"
                      ? {
                          target: ref(edit.target),
                          action: edit.action,
                          messages: [...edit.messages],
                        }
                      : { target: ref(edit.target), action: edit.action },
                  ),
                }),
          }),
        ),
      };
      const archive = validateArchive({ ...payload, head: archiveHash(payload) });
      for (const entry of all) state.records[String(entry.id)] = provenance(entry);
      state.heads[archive.head] = {
        branchId: archive.branchId,
        nativeId,
        conversationId: archive.conversationId,
        botId: archive.botId,
        records: archive.entries.map((entry) => entry.id),
        entries: all.map((entry) => entry.id),
      };
      state.branches[archive.branchId] = {
        nativeId,
        conversationId: archive.conversationId,
        botId: archive.botId,
      };
      return archive;
    }, ctx);
  }

  async import(input: unknown): Promise<HistoryReceipt> {
    const archive = validateArchive(input);
    return this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const receipt = {
        head: archive.head,
        conversationId: archive.conversationId,
        branchId: archive.branchId,
      };
      if (state.heads[archive.head] !== undefined) return receipt;
      // Reuse the longest immutable prefix through a native fork, including shared ancestors.
      let prefix: Head | undefined;
      let count = 0;
      for (const candidate of Object.values(state.heads)) {
        let length = 0;
        while (
          length < Math.min(candidate.records.length, archive.entries.length) &&
          candidate.records[length] === archive.entries[length]?.id
        )
          length += 1;
        if (length > count) {
          prefix = candidate;
          count = length;
        }
      }
      // SDK table reads precede create/fork/append writes on the transaction line.
      const known = new Map(
        Object.entries(state.records).map(([local, value]) => [value.id, Number(local) as EntryId]),
      );
      for (const [index, entry] of archive.entries.entries()) {
        const local = known.get(entry.id);
        if (local === undefined) continue;
        const existing = await tx.entry(local);
        if (existing === undefined || !sameEntry(existing, entry, state.records))
          historyReject("history record content conflict");
        if (index >= count) historyReject("history ancestry conflict");
      }
      const conversation =
        prefix === undefined
          ? await tx.createConversation({ ownership: { kind: "ownerless" } })
          : await tx.forkConversation(
              prefix.nativeId as ConversationId,
              prefix.entries[count - 1] as EntryId,
              { ownership: { kind: "ownerless" } },
            );
      const mapped = new Map<string, EntryId>();
      const nativeEntries: number[] = [];
      for (const [index, entry] of archive.entries.entries()) {
        if (index < count && prefix !== undefined) {
          const local = prefix.entries[index] as EntryId;
          mapped.set(entry.id, local);
          nativeEntries.push(local);
          continue;
        }
        const draft: EntryDraft = {
          kind: entry.kind,
          ...(entry.model === undefined ? {} : { model: entry.model }),
          ...(entry.data === undefined ? {} : { data: entry.data }),
          ...(entry.head === undefined
            ? {}
            : {
                head:
                  entry.head === entry.id
                    ? "self"
                    : (mapped.get(entry.head) ?? historyReject("missing history head")),
              }),
          ...(entry.edits === undefined
            ? {}
            : {
                edits: entry.edits.map((edit) => ({
                  ...edit,
                  target: mapped.get(edit.target) ?? historyReject("missing history edit"),
                })),
              }),
        };
        const local = (await tx.appendEntry(conversation.id, draft)).id;
        state.records[String(local)] = {
          id: entry.id,
          originId: entry.originId,
          conversationId: entry.conversationId,
        };
        mapped.set(entry.id, local);
        nativeEntries.push(local);
      }
      state.heads[archive.head] = {
        branchId: archive.branchId,
        nativeId: conversation.id,
        conversationId: archive.conversationId,
        botId: archive.botId,
        records: archive.entries.map((entry) => entry.id),
        entries: nativeEntries,
      };
      // Each head is immutable; two versions of one remote branch remain separately addressable by head.
      return receipt;
    }, ctx);
  }

  async continue(input: {
    head: string;
    requestId: string;
    text: string;
  }): Promise<HistoryContinuation> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) ||
      input.text.length === 0 ||
      input.text.length > 8000
    )
      historyReject("invalid history continuation");
    const selected = await this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const previous = state.continuations[input.requestId];
      if (previous !== undefined) {
        if (previous.head !== input.head || previous.text !== input.text)
          historyReject("history continuation request conflict");
        const branch = state.branches[previous.branchId] ?? historyReject("history branch missing");
        return {
          nativeId: branch.nativeId,
          conversationId: branch.conversationId,
          botId: branch.botId,
        };
      }
      const head = state.heads[input.head] ?? historyReject("unknown imported history head");
      const tail = head.entries.at(-1) as EntryId;
      const fork = await tx.forkConversation(head.nativeId as ConversationId, tail, {
        ownership: { kind: "ownerless" },
      });
      // Receive local configuration, never the source machine's model, tools or cwd.
      const local = await tx.doc(AgentDoc, this.#rootId);
      const agent = await tx.doc(AgentDoc, fork.id);
      Object.assign(agent, JSON.parse(JSON.stringify(local)));
      const branchId = `${state.originId}/c${fork.id}`;
      const branch = { nativeId: fork.id, conversationId: head.conversationId, botId: this.#botId };
      state.branches[branchId] = branch;
      state.continuations[input.requestId] = { head: input.head, text: input.text, branchId };
      return branch;
    }, ctx);
    const conversation =
      (await this.#harness.conversation(selected.nativeId as ConversationId, ctx)) ??
      historyReject("history conversation missing");
    const submission = await conversation.submit(
      { type: "input", content: input.text, requestId: input.requestId, whenBusy: "reject" },
      ctx,
    );
    await submission.wait(ctx);
    const record = await submission.status(ctx);
    const converted = convertSubmission(record) ?? historyReject("history submission missing");
    const state = await this.#harness.snapshot(HistoryState, ctx);
    const branchId =
      state?.continuations[input.requestId]?.branchId ?? historyReject("history branch missing");
    const entry =
      record.status === "done" && record.answer !== undefined
        ? await this.#harness.commit((tx) => tx.entry(record.answer as EntryId), ctx)
        : undefined;
    const message = entry?.model?.find((item) => item.role === "assistant");
    const answer =
      message === undefined || entry === undefined
        ? undefined
        : convertMessage(message, { id: `e_${entry.id}`, now: () => new Date() });
    return { branchId, submission: converted, ...(answer === undefined ? {} : { answer }) };
  }
}

const sameEntry = (
  local: EntryRecord,
  remote: HistoryEntry,
  records: Record<string, Provenance>,
) => {
  return (
    archiveHash(remote) ===
    archiveHash({
      ...records[String(local.id)],
      kind: local.kind,
      ...(local.model === undefined ? {} : { model: local.model }),
      ...(local.data === undefined ? {} : { data: local.data }),
      ...(local.head === undefined ? {} : { head: records[String(local.head)]?.id }),
      ...(local.edits === undefined
        ? {}
        : {
            edits: local.edits.map((edit) => ({
              ...edit,
              target: records[String(edit.target)]?.id,
            })),
          }),
    })
  );
};
