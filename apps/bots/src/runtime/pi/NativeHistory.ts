import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationId,
  type Cursor,
  defineDoc,
  defineDocFamily,
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
  advanceTurn,
  archiveHash,
  completeTurn,
  type HistoryArchive,
  type HistoryEntry,
  HistoryInputError,
  historyReject,
  initialTurn,
  MAX_ARCHIVE_BYTES,
  validateArchive,
  validateTurn,
} from "./historyArchive.ts";
import {
  type HistoryPage,
  type HistoryPageRequest,
  historyPageRequest,
  MAX_HISTORY_PAGE_BYTES,
  pageHead,
  validateHistoryPage,
} from "./historyIncremental.ts";
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
    continuations: {} as Record<
      string,
      { head: string; text: string; branchId: string; nativeId?: number }
    >,
  }),
  checkpointWhen: () => true,
});

const ReceivedRecord = defineDocFamily({
  kind: "bots.history.record",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ body: "", nativeId: 0, conversationId: 0 }),
  checkpointWhen: () => true,
});
const IncrementalHead = defineDocFamily({
  kind: "bots.history.head",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({
    branchId: "",
    conversationId: "",
    botId: "",
    tip: "",
    nativeId: 0,
    tail: 0,
    usable: false,
  }),
  checkpointWhen: () => true,
});
const RecordLink = defineDocFamily({
  kind: "bots.history.link",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null): { next: string; queued: boolean; workNext: string } => ({
    next: "",
    queued: false,
    workNext: "",
  }),
  checkpointWhen: () => true,
});
// A cursor issued while walking one immutable head can be reused without rescanning its ancestry.
const ReceivedCursor = defineDocFamily({
  kind: "bots.history.cursor",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ tip: "" }),
  checkpointWhen: () => true,
});
const BranchProgress = defineDocFamily({
  kind: "bots.history.progress",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ next: "", tail: "", revision: 0 }),
  checkpointWhen: () => true,
});
const NativeProvenance = defineDocFamily({
  kind: "bots.history.provenance",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ id: "", originId: "", conversationId: "" }),
  checkpointWhen: () => true,
});
const PassiveConversation = defineDocFamily({
  kind: "bots.history.passive",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null): { imported: boolean } => ({ imported: false }),
  checkpointWhen: () => true,
});
const BranchDirectory = defineDoc({
  kind: "bots.history.branches",
  version: 1,
  scope: "session",
  initial: () => ({
    branches: {} as Record<
      string,
      { head: string; tip: string; conversationId: string; botId: string }
    >,
  }),
  checkpointWhen: () => true,
});
// Only compare the owning origin's native entry sequence within one branch, never device clocks.
const tipOrder = (branchId: string, tip: string) =>
  tip.startsWith(`${branchId.split("/c")[0]}/e`) ? Number(tip.split("/e")[1]) : 0;

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

  observe(listener: () => void): () => void {
    let active = true;
    let queued = false;
    const detach = this.#harness.subscribeCommits((publication) => {
      if (queued || !publication.changes.some((change) => change.type === "entry")) return;
      queued = true;
      setImmediate(() => {
        queued = false;
        if (active) {
          try {
            listener();
          } catch {
            /* Optional observers cannot affect local chat. */
          }
        }
      });
    });
    return () => {
      active = false;
      detach();
    };
  }

  async exportPage(input: HistoryPageRequest = {}): Promise<HistoryPage> {
    const request = historyPageRequest.safeParse(input);
    if (!request.success) historyReject("invalid history page request");
    return this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const saved = input.selection === undefined ? undefined : state.heads[input.selection];
      const incremental =
        input.selection === undefined
          ? undefined
          : await tx.doc(IncrementalHead, input.selection, null);
      const receivedCursor = [input.after, input.before, input.until].some((value) => {
        if (value === undefined) return false;
        try {
          return "record" in JSON.parse(Buffer.from(value, "base64url").toString());
        } catch {
          return false;
        }
      });
      if (incremental?.branchId && (!incremental.nativeId || receivedCursor))
        return this.#exportReceived(tx, incremental, state.originId, input);
      const selected =
        saved ??
        (incremental?.nativeId ? incremental : undefined) ??
        (input.selection === `${state.originId}/c${this.#rootId}`
          ? { nativeId: this.#rootId, conversationId: input.selection, botId: this.#botId }
          : input.selection === undefined
            ? undefined
            : state.branches[input.selection]);
      if (input.selection !== undefined && selected === undefined)
        historyReject("unknown history branch");
      const nativeId = (selected?.nativeId ?? this.#rootId) as ConversationId;
      const branchId =
        saved?.branchId ??
        (incremental?.nativeId ? incremental.branchId : undefined) ??
        input.selection ??
        `${state.originId}/c${nativeId}`;
      const conversationId = selected?.conversationId ?? branchId;
      const identity = async (entry: EntryRecord): Promise<Provenance> => {
        const mapped = await tx.doc(NativeProvenance, String(entry.id), null);
        return (
          state.records[String(entry.id)] ??
          (mapped.id
            ? { id: mapped.id, originId: mapped.originId, conversationId: mapped.conversationId }
            : {
                id: `${state.originId}/e${entry.id}`,
                originId: state.originId,
                conversationId: `${state.originId}/c${entry.conversationId}`,
              })
        );
      };
      const cursor = (entry: number) =>
        Buffer.from(JSON.stringify({ origin: state.originId, branchId, entry })).toString(
          "base64url",
        );
      const position = async (value: string | undefined): Promise<number | undefined> => {
        if (value === undefined) return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.from(value, "base64url").toString());
        } catch {
          historyReject("invalid history cursor");
        }
        const found = parsed as { origin?: string; branchId?: string; entry?: number };
        if (
          found?.origin !== state.originId ||
          found.branchId !== branchId ||
          !Number.isSafeInteger(found.entry) ||
          (found.entry ?? 0) <= 0
        )
          historyReject("foreign history cursor");
        const entry = found.entry as EntryId;
        if (
          (
            await tx.scanEntries(
              { conversationId: nativeId, minEntryId: entry, maxEntryId: entry },
              1,
            )
          ).items.length !== 1
        )
          historyReject("history cursor is not in this branch");
        return entry;
      };
      const after = await position(input.after);
      const before = await position(input.before);
      const until = await position(input.until);
      const bound = Math.min(
        until ?? Infinity,
        saved?.entries.at(-1) ?? (incremental?.nativeId ? incremental.tail : Infinity),
      );
      const newest = (
        await tx.scanEntries(
          {
            conversationId: nativeId,
            ...(Number.isFinite(bound) ? { maxEntryId: bound as EntryId } : {}),
          },
          1,
        )
      ).items[0];
      const tip = newest === undefined ? null : (await identity(newest)).id;
      const head = pageHead(branchId, tip);
      const result: HistoryPage = {
        version: 1,
        engine: "pi-durable@1.4.0",
        branchId,
        conversationId,
        botId: selected?.botId ?? this.#botId,
        head,
        tip,
        cursor: input.after ?? input.before ?? null,
        snapshot: newest === undefined ? null : cursor(newest.id),
        hasMore: false,
        records: [],
      };
      const order = after === undefined ? "descending" : "ascending";
      const page = await tx.scanEntries(
        {
          conversationId: nativeId,
          order,
          ...(after === undefined ? {} : { minEntryId: (after + 1) as EntryId }),
          maxEntryId: Math.min(
            before === undefined ? Infinity : before - 1,
            newest?.id ?? 0,
          ) as EntryId,
        },
        input.limit ?? 32,
      );
      const ref = async (id: EntryId) =>
        (await identity((await tx.entry(id)) ?? historyReject("missing native history reference")))
          .id;
      for (const entry of page.items) {
        const previous = (
          await tx.scanEntries(
            { conversationId: nativeId, maxEntryId: (entry.id - 1) as EntryId },
            1,
          )
        ).items[0];
        const provenance = await identity(entry);
        const item: HistoryEntry = {
          ...provenance,
          kind: entry.kind,
          ...(entry.model === undefined ? {} : { model: [...entry.model] }),
          ...(entry.data === undefined ? {} : { data: entry.data }),
          ...(entry.head === undefined
            ? {}
            : { head: entry.head === entry.id ? provenance.id : await ref(entry.head) }),
          ...(entry.edits === undefined
            ? {}
            : {
                edits: await Promise.all(
                  entry.edits.map(async (edit) =>
                    edit.action === "omit"
                      ? { target: await ref(edit.target), action: edit.action }
                      : {
                          target: await ref(edit.target),
                          action: edit.action,
                          messages: [...edit.messages],
                        },
                  ),
                ),
              }),
        };
        const record = {
          previous: previous === undefined ? null : (await identity(previous)).id,
          entry: item,
        };
        result.records.push(record);
        result.hasMore = page.next !== undefined;
        const nextCursor = cursor(entry.id);
        if (
          Buffer.byteLength(JSON.stringify({ ...result, cursor: nextCursor })) >
          (input.maxBytes ?? MAX_HISTORY_PAGE_BYTES)
        ) {
          result.records.pop();
          if (result.records.length === 0) historyReject("history record exceeds page budget");
          result.hasMore = true;
          break;
        }
        result.cursor = nextCursor;
        const stored = await tx.doc(ReceivedRecord, item.id, null);
        if (stored.body && stored.body !== JSON.stringify(record))
          historyReject("history record content conflict");
        Object.assign(stored, {
          body: JSON.stringify(record),
          nativeId: entry.id,
          conversationId: nativeId,
        });
      }
      if (order === "descending") result.records.reverse();
      const receipt = await tx.doc(IncrementalHead, head, null);
      Object.assign(receipt, {
        branchId,
        conversationId,
        botId: result.botId,
        tip: result.tip ?? "",
        nativeId,
        tail: newest?.id ?? 0,
      });
      return validateHistoryPage(result);
    }, ctx);
  }

  async #exportReceived(
    tx: Tx,
    selected: { branchId: string; conversationId: string; botId: string; tip: string },
    origin: string,
    input: HistoryPageRequest,
  ): Promise<HistoryPage> {
    let bound = selected.tip;
    const cursor = async (record: string) => {
      const value = Buffer.from(
        JSON.stringify({ origin, branchId: selected.branchId, record, head: bound }),
      ).toString("base64url");
      (await tx.doc(ReceivedCursor, value, null)).tip = bound;
      return value;
    };
    const read = async (id: string) => {
      const stored = await tx.doc(ReceivedRecord, id, null);
      return stored.body ? (JSON.parse(stored.body) as HistoryPage["records"][number]) : undefined;
    };
    const position = async (value: string | undefined) => {
      if (value === undefined) return undefined;
      let parsed: { origin?: string; branchId?: string; record?: string; head?: string };
      try {
        parsed = JSON.parse(Buffer.from(value, "base64url").toString());
      } catch {
        return historyReject("invalid history cursor");
      }
      if (
        parsed?.origin !== origin ||
        parsed.branchId !== selected.branchId ||
        typeof parsed.record !== "string"
      )
        return historyReject("foreign history cursor");
      const record = await read(parsed.record);
      if (
        !record ||
        (await tx.doc(RecordLink, `${selected.branchId}/${record.previous ?? "root"}`, null))
          .next !== parsed.record
      )
        return historyReject("history cursor is not in this branch");
      if (
        record.entry.id === selected.tip ||
        (parsed.head === selected.tip &&
          (await tx.doc(ReceivedCursor, value, null)).tip === selected.tip)
      )
        return record;
      const tip = await tx.doc(ReceivedRecord, selected.tip, null);
      const candidate = await tx.doc(ReceivedRecord, record.entry.id, null);
      if (tip.nativeId && candidate.nativeId) {
        const visible = await tx.scanEntries(
          {
            conversationId: tip.conversationId as ConversationId,
            minEntryId: candidate.nativeId as EntryId,
            maxEntryId: Math.min(candidate.nativeId, tip.nativeId) as EntryId,
          },
          1,
        );
        if (visible.items.length === 1) return record;
      } else {
        // Missing-ancestor heads only prove a bounded neighborhood; issued cursors retain their native witness.
        let ancestor = selected.tip;
        for (let count = 0; ancestor && count < 64; count++) {
          if (ancestor === record.entry.id) return record;
          ancestor = (await read(ancestor))?.previous ?? "";
        }
      }
      historyReject("history cursor is outside selected head or its ancestry is not yet available");
      return record;
    };
    const after = await position(input.after);
    const before = await position(input.before);
    const until = await position(input.until);
    const tip = until?.entry.id ?? (selected.tip || null);
    bound = tip ?? "";
    const result: HistoryPage = {
      version: 1,
      engine: "pi-durable@1.4.0",
      branchId: selected.branchId,
      conversationId: selected.conversationId,
      botId: selected.botId,
      tip,
      head: pageHead(selected.branchId, tip),
      cursor: input.after ?? input.before ?? null,
      snapshot: tip === null ? null : await cursor(tip),
      hasMore: false,
      records: [],
    };
    let id =
      after === undefined
        ? before === undefined
          ? tip
          : before.previous
        : after.entry.id === tip
          ? null
          : (await tx.doc(RecordLink, `${selected.branchId}/${after.entry.id}`, null)).next || null;
    for (let count = 0; id && count < (input.limit ?? 32); count += 1) {
      const record = await read(id);
      if (!record) break;
      result.records.push(record);
      const nextCursor = await cursor(id);
      if (
        Buffer.byteLength(JSON.stringify({ ...result, cursor: nextCursor })) >
        (input.maxBytes ?? MAX_HISTORY_PAGE_BYTES)
      ) {
        result.records.pop();
        if (!result.records.length) historyReject("history record exceeds page budget");
        result.hasMore = true;
        break;
      }
      result.cursor = nextCursor;
      id =
        after === undefined
          ? record.previous
          : id === tip
            ? null
            : (await tx.doc(RecordLink, `${selected.branchId}/${id}`, null)).next || null;
      result.hasMore = id !== null && (await read(id)) !== undefined;
    }
    if (after === undefined) result.records.reverse();
    const receipt = await tx.doc(IncrementalHead, result.head, null);
    Object.assign(receipt, {
      branchId: selected.branchId,
      conversationId: selected.conversationId,
      botId: selected.botId,
      tip: tip ?? "",
    });
    return validateHistoryPage(result);
  }

  async importPage(input: unknown) {
    const page = validateHistoryPage(input);
    await this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const legacy = new Map(
        Object.entries(state.records).map(([local, value]) => [value.id, Number(local) as EntryId]),
      );
      const head = await tx.doc(IncrementalHead, page.head, null);
      if (
        head.branchId &&
        (head.branchId !== page.branchId ||
          head.conversationId !== page.conversationId ||
          head.botId !== page.botId ||
          head.tip !== (page.tip ?? ""))
      )
        historyReject("history head identity conflict");
      Object.assign(head, {
        branchId: page.branchId,
        conversationId: page.conversationId,
        botId: page.botId,
        tip: page.tip ?? "",
      });
      for (const record of page.records) {
        const stored = await tx.doc(ReceivedRecord, record.entry.id, null);
        const body = JSON.stringify(record);
        if (stored.body && stored.body !== body) historyReject("history record content conflict");
        stored.body = body;
        const existing = legacy.get(record.entry.id);
        if (!stored.nativeId && existing !== undefined) {
          const native = await tx.entry(existing);
          if (native === undefined || !sameEntry(native, record.entry, state.records))
            return historyReject("history record content conflict");
          const previous = (
            await tx.scanEntries(
              { conversationId: native.conversationId, maxEntryId: (native.id - 1) as EntryId },
              1,
            )
          ).items[0];
          const previousId = previous === undefined ? null : state.records[String(previous.id)]?.id;
          if (previousId !== record.previous) historyReject("history record ancestry conflict");
          Object.assign(stored, { nativeId: native.id, conversationId: native.conversationId });
        }
        const link = await tx.doc(
          RecordLink,
          `${page.branchId}/${record.previous ?? "root"}`,
          null,
        );
        if (link.next && link.next !== record.entry.id)
          historyReject("history branch ancestry conflict");
        link.next = record.entry.id;
      }
      await this.#enqueue(
        tx,
        page.branchId,
        page.records.map((record) => record.entry.id),
      );
      const directory = await tx.doc(BranchDirectory);
      const previous = directory.branches[page.branchId];
      if (
        previous !== undefined &&
        (previous.conversationId !== page.conversationId || previous.botId !== page.botId)
      )
        historyReject("history branch identity conflict");
      if (
        previous === undefined ||
        tipOrder(page.branchId, page.tip ?? "") >= tipOrder(page.branchId, previous.tip)
      )
        directory.branches[page.branchId] = {
          head: page.head,
          tip: page.tip ?? "",
          conversationId: page.conversationId,
          botId: page.botId,
        };
    }, ctx);
    // Each native append is a separate short transaction; backfill yields to local chat.
    for (let remaining = 32; remaining > 0; remaining -= 1) {
      if (!(await this.#materialize(page.branchId))) break;
    }
    const pending = await this.#harness.commit(async (tx) => {
      const pending = await tx.doc(BranchProgress, page.branchId, null);
      const head = await tx.doc(IncrementalHead, page.head, null);
      if (head.tip) {
        const tip = await tx.doc(ReceivedRecord, head.tip, null);
        if (tip.nativeId) Object.assign(head, { nativeId: tip.conversationId, tail: tip.nativeId });
      }
      return pending.next !== "";
    }, ctx);
    return {
      head: page.head,
      branchId: page.branchId,
      conversationId: page.conversationId,
      pending,
    };
  }

  async listBranches(input: { after?: string; limit?: number } = {}) {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "after" && key !== "limit") ||
      (input.after !== undefined && typeof input.after !== "string") ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 32))
    )
      historyReject("invalid history branch request");
    return this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const received = await tx.doc(BranchDirectory);
      const root = `${state.originId}/c${this.#rootId}`;
      const selections = new Map([
        [root, { branchId: root, conversationId: root, selection: root }],
      ]);
      for (const [head, value] of Object.entries(state.heads))
        selections.set(value.branchId, {
          branchId: value.branchId,
          conversationId: value.conversationId,
          selection: head,
        });
      for (const [branchId, value] of Object.entries(received.branches))
        selections.set(branchId, {
          branchId,
          conversationId: value.conversationId,
          selection: value.head,
        });
      for (const [branchId, value] of Object.entries(state.branches))
        selections.set(branchId, {
          branchId,
          conversationId: value.conversationId,
          selection: branchId,
        });
      const branches = [...selections.values()]
        .sort((a, b) => a.branchId.localeCompare(b.branchId))
        .filter(
          (branch) => input.after === undefined || branch.branchId.localeCompare(input.after) > 0,
        );
      const page = branches.slice(0, input.limit ?? 32);
      return {
        branches: page,
        cursor: page.at(-1)?.branchId ?? null,
        hasMore: branches.length > page.length,
      };
    }, ctx);
  }

  async #enqueue(tx: Tx, branchId: string, ids: string[]) {
    const progress = await tx.doc(BranchProgress, branchId, null);
    // Adopt the single pending pointer written by older versions.
    if (progress.next && !progress.tail) {
      progress.tail = progress.next;
      (await tx.doc(RecordLink, `${branchId}/${progress.next}`, null)).queued = true;
    }
    for (const id of ids) {
      if ((await tx.doc(ReceivedRecord, id, null)).nativeId) continue;
      const work = await tx.doc(RecordLink, `${branchId}/${id}`, null);
      if (work.queued) continue;
      work.queued = true;
      work.workNext = "";
      if (progress.tail)
        (await tx.doc(RecordLink, `${branchId}/${progress.tail}`, null)).workNext = id;
      else progress.next = id;
      progress.tail = id;
    }
  }

  async #materialize(branchId: string): Promise<boolean> {
    return this.#harness.commit(async (tx) => {
      const progress = await tx.doc(BranchProgress, branchId, null);
      if (!progress.next) return false;
      const id = progress.next;
      const work = await tx.doc(RecordLink, `${branchId}/${id}`, null);
      progress.next = work.workNext || "";
      if (!progress.next) progress.tail = "";
      work.queued = false;
      work.workNext = "";
      const next = await this.#appendReceived(tx, id, branchId);
      if (next) await this.#enqueue(tx, branchId, [next]);
      return true;
    }, ctx);
  }

  async #appendReceived(tx: Tx, id: string, branchId: string): Promise<string | undefined> {
    const stored = await tx.doc(ReceivedRecord, id, null);
    if (!stored.body) return;
    const record = JSON.parse(stored.body) as HistoryPage["records"][number];
    const link = await tx.doc(RecordLink, `${branchId}/${id}`, null);
    if (stored.nativeId) return link.next || undefined;
    const parent =
      record.previous === null ? undefined : await tx.doc(ReceivedRecord, record.previous, null);
    if (parent !== undefined && !parent.nativeId) return;
    const entry = record.entry;
    const refs = new Map<string, EntryId>();
    for (const ref of [
      entry.head === entry.id ? undefined : entry.head,
      ...(entry.edits ?? []).map((edit) => edit.target),
    ]) {
      if (ref === undefined || refs.has(ref)) continue;
      const target = await tx.doc(ReceivedRecord, ref, null);
      if (!target.nativeId || parent === undefined)
        return historyReject("history reference missing");
      const visible = await tx.scanEntries(
        {
          conversationId: parent.conversationId as ConversationId,
          minEntryId: target.nativeId as EntryId,
          maxEntryId: Math.min(target.nativeId, parent.nativeId) as EntryId,
        },
        1,
      );
      if (visible.items.length !== 1) historyReject("history reference outside ancestry");
      refs.set(ref, target.nativeId as EntryId);
    }
    const tail =
      parent === undefined
        ? undefined
        : (await tx.scanEntries({ conversationId: parent.conversationId as ConversationId }, 1))
            .items[0];
    const container =
      parent === undefined
        ? undefined
        : await tx.conversation(parent.conversationId as ConversationId);
    const passive =
      parent === undefined
        ? false
        : (await tx.doc(PassiveConversation, String(parent.conversationId), null)).imported;
    // SDK roots and local continuations can also be ownerless; only imports may share an append container.
    const reuse =
      parent !== undefined &&
      parent.conversationId !== this.#rootId &&
      container !== undefined &&
      container.owner === undefined &&
      passive &&
      tail?.id === parent.nativeId;
    const conversationId =
      parent === undefined
        ? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id
        : reuse
          ? (parent.conversationId as ConversationId)
          : (
              await tx.forkConversation(
                parent.conversationId as ConversationId,
                parent.nativeId as EntryId,
                { ownership: { kind: "ownerless" } },
              )
            ).id;
    (await tx.doc(PassiveConversation, String(conversationId), null)).imported = true;
    const draft: EntryDraft = {
      kind: entry.kind,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ...(entry.head === undefined
        ? {}
        : { head: entry.head === entry.id ? "self" : (refs.get(entry.head) as EntryId) }),
      ...(entry.edits === undefined
        ? {}
        : {
            edits: entry.edits.map((edit) => ({
              ...edit,
              target: refs.get(edit.target) as EntryId,
            })),
          }),
    };
    const native = await tx.appendEntry(conversationId, draft);
    Object.assign(stored, { nativeId: native.id, conversationId });
    Object.assign(await tx.doc(NativeProvenance, String(native.id), null), {
      id: entry.id,
      originId: entry.originId,
      conversationId: entry.conversationId,
    });
    return link.next || undefined;
  }

  async readHead(headId: string) {
    if (!/^[a-f0-9]{64}$/.test(headId)) historyReject("invalid history head");
    const head = await this.#harness.snapshot(IncrementalHead, headId, ctx);
    if (!head?.branchId) return historyReject("unknown history head");
    const messages = [];
    let id = head.tip;
    let bytes = 0;
    for (let count = 0; id && count < 32; count += 1) {
      const raw = await this.#harness.snapshot(ReceivedRecord, id, ctx);
      if (!raw?.body) break;
      bytes += Buffer.byteLength(raw.body);
      if (bytes > MAX_HISTORY_PAGE_BYTES) break;
      const record = JSON.parse(raw.body) as HistoryPage["records"][number];
      const converted = (record.entry.model ?? []).flatMap((item) => {
        const message = convertMessage(item, { id: record.entry.id, now: () => new Date() });
        return message === undefined ? [] : [message];
      });
      messages.unshift(...converted);
      id = record.previous ?? "";
    }
    return {
      head: headId,
      branchId: head.branchId,
      conversationId: head.conversationId,
      usable: head.usable,
      messages,
      hasMore: id !== "",
    };
  }

  async assessHead(headId: string) {
    if (!/^[a-f0-9]{64}$/.test(headId)) historyReject("invalid history head");
    const head = await this.#harness.snapshot(IncrementalHead, headId, ctx);
    if (!head?.branchId) return historyReject("unknown history head");
    if (head.usable) return { head: headId, usable: true };
    const stored = head.tip
      ? await this.#harness.snapshot(ReceivedRecord, head.tip, ctx)
      : undefined;
    const nativeId = stored?.conversationId || head.nativeId;
    const tail = stored?.nativeId || head.tail;
    let usable = false;
    if (nativeId && tail) {
      const conversation =
        (await this.#harness.conversation(nativeId as ConversationId, ctx)) ??
        historyReject("history conversation missing");
      const raw = initialTurn();
      let cursor: Cursor | undefined;
      try {
        do {
          const page = await conversation.entries(
            { order: "ascending", maxEntryId: tail as EntryId },
            32,
            cursor,
            ctx,
          );
          advanceTurn(raw, page.items);
          cursor = page.next;
        } while (cursor !== undefined);
        if (completeTurn(raw)) {
          const context = await conversation.context(ctx, { at: tail as EntryId });
          validateTurn(
            context.entries.map((entry, index) => ({
              kind: entry.kind,
              head: entry.head,
              model: context.contributions[index],
            })),
          );
          usable = true;
        }
      } catch (error) {
        if (!(error instanceof HistoryInputError)) throw error;
      }
    }
    await this.#harness.commit(async (tx) => {
      Object.assign(await tx.doc(IncrementalHead, headId, null), { usable, nativeId, tail });
    }, ctx);
    return { head: headId, usable };
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
      for (const entry of all) {
        const mapped = await tx.doc(NativeProvenance, String(entry.id), null);
        if (mapped.id)
          state.records[String(entry.id)] = {
            id: mapped.id,
            originId: mapped.originId,
            conversationId: mapped.conversationId,
          };
      }
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
      if (saved === undefined)
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
      const existingHead = state.heads[archive.head];
      if (existingHead !== undefined) {
        await this.#indexArchive(tx, archive, existingHead);
        return receipt;
      }
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
      // The archive primitive and incremental pages share the same native records.
      const receivedPrefix: number[] = [];
      for (const [index, entry] of archive.entries.entries()) {
        const received = await tx.doc(ReceivedRecord, entry.id, null);
        if (!received.nativeId || !received.body) break;
        const raw = JSON.parse(received.body) as HistoryPage["records"][number];
        if (
          archiveHash(raw.entry) !== archiveHash(entry) ||
          raw.previous !== (archive.entries[index - 1]?.id ?? null)
        )
          historyReject("history record content conflict");
        state.records[String(received.nativeId)] = {
          id: entry.id,
          originId: entry.originId,
          conversationId: entry.conversationId,
        };
        receivedPrefix.push(received.nativeId);
        if (receivedPrefix.length > count) {
          count = receivedPrefix.length;
          prefix = {
            nativeId: received.conversationId,
            conversationId: archive.conversationId,
            botId: archive.botId,
            branchId: archive.branchId,
            records: archive.entries.slice(0, count).map((value) => value.id),
            entries: [...receivedPrefix],
          };
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
      (await tx.doc(PassiveConversation, String(conversation.id), null)).imported = true;
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
      const importedHead = {
        branchId: archive.branchId,
        nativeId: conversation.id,
        conversationId: archive.conversationId,
        botId: archive.botId,
        records: archive.entries.map((entry) => entry.id),
        entries: nativeEntries,
      };
      state.heads[archive.head] = importedHead;
      await this.#indexArchive(tx, archive, importedHead);
      // Each head is immutable; two versions of one remote branch remain separately addressable by head.
      return receipt;
    }, ctx);
  }

  async #indexArchive(tx: Tx, archive: HistoryArchive, head: Head) {
    for (const [index, entry] of archive.entries.entries()) {
      const stored = await tx.doc(ReceivedRecord, entry.id, null);
      const previous = archive.entries[index - 1]?.id ?? null;
      const body = JSON.stringify({ previous, entry });
      if (stored.body && stored.body !== body) historyReject("history record content conflict");
      stored.body = body;
      if (!stored.nativeId)
        Object.assign(stored, {
          nativeId: head.entries[index],
          conversationId: head.nativeId,
        });
      const link = await tx.doc(RecordLink, `${archive.branchId}/${previous ?? "root"}`, null);
      if (link.next && link.next !== entry.id) historyReject("history branch ancestry conflict");
      link.next = entry.id;
    }
  }

  async continue(
    input: {
      head: string;
      requestId: string;
      text: string;
    },
    onAdmission: () => void,
  ): Promise<HistoryContinuation> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) ||
      input.text.length === 0 ||
      input.text.length > 8000
    )
      historyReject("invalid history continuation");
    const legacy = await this.#harness.snapshot(HistoryState, ctx);
    if (
      legacy?.heads[input.head] === undefined &&
      legacy?.continuations[input.requestId] === undefined
    ) {
      const view = await this.assessHead(input.head);
      if (!view.usable) historyReject("history is not a complete turn");
    }
    const selected = await this.#harness.commit(async (tx) => {
      const state = await tx.doc(HistoryState);
      const previous = state.continuations[input.requestId];
      if (previous !== undefined) {
        if (previous.head !== input.head || previous.text !== input.text)
          historyReject("history continuation request conflict");
        // Older local receipts also pin the native ID in their locally minted branch ID.
        return { nativeId: previous.nativeId ?? Number(previous.branchId.split("/c")[1]) };
      }
      const incremental = await tx.doc(IncrementalHead, input.head, null);
      const head =
        state.heads[input.head] ??
        (incremental.usable ? incremental : historyReject("unknown imported history head"));
      const tail = ("entries" in head ? head.entries.at(-1) : head.tail) as EntryId;
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
      state.continuations[input.requestId] = {
        head: input.head,
        text: input.text,
        branchId,
        nativeId: fork.id,
      };
      return branch;
    }, ctx);
    const conversation =
      (await this.#harness.conversation(selected.nativeId as ConversationId, ctx)) ??
      historyReject("history conversation missing");
    onAdmission();
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
