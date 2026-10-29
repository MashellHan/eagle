// One trigger's delivery queue (docs/bots/TRIGGERS.md §5): a bounded FIFO of fire items, the
// frozen batch cut from its head, and the envelope that turns several fires into one turn.
// Pure policy: it owns no clock, no timer and no admission, and every decision is a journal
// record so a crash resumes from what was already decided.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Queued items only; frozen batch members no longer count against this. */
export const MAX_QUEUE_ITEMS = 32;
/** Mirrors `protocol/limits.ts#MAX_SEND_TEXT`; the batch is cut by this budget. */
export const MAX_BATCH_TEXT = 8_000;
const TRUNCATION_MARKER = "…[truncated]";
const FOOTER = "Answer once, for the batch as a whole.";

export type QueueItem = {
  /** Producer identity: a webhook delivery id (or its body hash), a schedule's due instant. */
  readonly itemId: string;
  readonly text: string;
  readonly receivedAt: string;
};

export type FrozenBatch = {
  readonly batchId: number;
  /** `sh_<triggerId>_<batchId>` or `wh_<triggerId>_<batchId>`; never re-minted. */
  readonly requestId: string;
  readonly items: readonly QueueItem[];
  readonly text: string;
  readonly cutAt: string;
  /** True when the single admitted item did not fit and was marked, not silently cut. */
  readonly truncated: boolean;
  /** Evictions folded into this batch, so a loss is visible to the model and the person. */
  readonly dropped: number;
};

export type QueueRecord =
  | { readonly op: "enqueue"; readonly item: QueueItem }
  | { readonly op: "cut"; readonly batch: FrozenBatch }
  | { readonly op: "close"; readonly batchId: number }
  /** The schedule's durable decision: the fire and its next instant in one record. */
  | { readonly op: "fire"; readonly item: QueueItem; readonly cursorAfter?: string }
  | { readonly op: "cursor"; readonly at?: string };

/** Append-only destination for the queue's decisions. */
export type QueueJournal = {
  append(record: QueueRecord): Promise<void>;
};

export const memoryJournal = (): QueueJournal & { readonly records: QueueRecord[] } => {
  const records: QueueRecord[] = [];
  return {
    records,
    append: async (record) => {
      records.push(record);
    },
  };
};

export const fileJournal = (path: string): QueueJournal & { read(): Promise<QueueRecord[]> } => ({
  append: async (record) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  },
  read: async () => {
    let body = "";
    try {
      body = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const records: QueueRecord[] = [];
    for (const line of body.split("\n")) {
      if (line.trim().length === 0) continue;
      const record = parseRecord(line);
      if (record !== undefined) records.push(record);
    }
    return records;
  },
});

export type CutInput = {
  readonly kind: "schedule" | "webhook";
  /** The bot's standing instruction, prepended to the envelope. */
  readonly prompt: string;
  readonly cutAt: string;
  /** Names the admission; the batch id is allocated here and passed in. */
  readonly requestId: (batchId: number) => string;
};

export class TriggerQueue {
  readonly #triggerId: string;
  readonly #journal: QueueJournal;
  #items: QueueItem[] = [];
  #batch: FrozenBatch | undefined;
  #dropped = 0;
  #nextBatchId = 1;
  /** The absolute next due instant; absent until the first tick arms it. */
  #cursor: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(triggerId: string, journal: QueueJournal) {
    this.#triggerId = triggerId;
    this.#journal = journal;
  }

  static async open(input: {
    readonly triggerId: string;
    readonly journal: QueueJournal;
  }): Promise<TriggerQueue> {
    const queue = new TriggerQueue(input.triggerId, input.journal);
    const read = (input.journal as { read?: () => Promise<QueueRecord[]> }).read;
    for (const record of (await read?.()) ?? []) queue.#apply(record);
    return queue;
  }

  get triggerId(): string {
    return this.#triggerId;
  }

  items(): readonly QueueItem[] {
    return this.#items;
  }

  openBatch(): FrozenBatch | undefined {
    return this.#batch;
  }

  droppedSinceCut(): number {
    return this.#dropped;
  }

  /** Delivery state, not definition state: it advances with the fire it belongs to. */
  cursor(): string | undefined {
    return this.#cursor;
  }

  /** Arms a schedule for the first time, or re-arms one that missed its window. */
  setCursor(at: string | undefined): Promise<void> {
    return this.#serial(async () => {
      this.#cursor = at;
      await this.#journal.append({ op: "cursor", ...(at === undefined ? {} : { at }) });
    });
  }

  /**
   * One journal record for one tick: the fire and the advanced cursor cannot disagree
   * after a crash, so a tick can neither fire twice nor lose a fire (TRIGGERS.md §9.1).
   */
  fire(input: {
    readonly item: QueueItem;
    readonly cursorAfter: string | undefined;
  }): Promise<boolean> {
    return this.#serial(async () => {
      const known =
        this.#items.some((queued) => queued.itemId === input.item.itemId) ||
        this.#batch?.items.some((member) => member.itemId === input.item.itemId) === true;
      if (known) return false;
      if (this.#items.length >= MAX_QUEUE_ITEMS) {
        this.#items = this.#items.slice(1);
        this.#dropped += 1;
      }
      this.#items = [...this.#items, input.item];
      this.#cursor = input.cursorAfter;
      await this.#journal.append({
        op: "fire",
        item: input.item,
        ...(input.cursorAfter === undefined ? {} : { cursorAfter: input.cursorAfter }),
      });
      return true;
    });
  }

  /**
   * Appends one fire. A repeated `itemId` is the same delivery and is not queued twice —
   * a producer retrying an at-least-once webhook lands here. At the cap the oldest is
   * evicted and counted, so the loss is visible rather than silent.
   */
  enqueue(item: QueueItem): Promise<{ readonly accepted: boolean; readonly dropped: number }> {
    return this.#serial(async () => {
      const known =
        this.#items.some((queued) => queued.itemId === item.itemId) ||
        this.#batch?.items.some((member) => member.itemId === item.itemId) === true;
      if (known) return { accepted: false, dropped: 0 };
      const evicted =
        this.#items.length >= MAX_QUEUE_ITEMS ? this.#items.length - MAX_QUEUE_ITEMS + 1 : 0;
      const keep = evicted === 0 ? this.#items : this.#items.slice(evicted);
      this.#items = [...keep, item];
      this.#dropped += evicted;
      await this.#journal.append({ op: "enqueue", item });
      return { accepted: true, dropped: evicted };
    });
  }

  /** Cuts the head into a frozen batch, or answers undefined when there is nothing to send. */
  cut(input: CutInput): Promise<FrozenBatch | undefined> {
    return this.#serial(async () => {
      if (this.#batch !== undefined || this.#items.length === 0) return undefined;
      const plan = planBatch({
        kind: input.kind,
        prompt: input.prompt,
        items: this.#items,
        dropped: this.#dropped,
      });
      if (plan.taken.length === 0) return undefined;
      const batchId = this.#nextBatchId;
      const batch: FrozenBatch = {
        batchId,
        requestId: input.requestId(batchId),
        items: plan.taken,
        text: plan.text,
        cutAt: input.cutAt,
        truncated: plan.truncated,
        dropped: this.#dropped,
      };
      this.#items = this.#items.slice(plan.taken.length);
      this.#dropped = 0;
      this.#batch = batch;
      this.#nextBatchId = batchId + 1;
      await this.#journal.append({ op: "cut", batch });
      return batch;
    });
  }

  /** A terminal admission record ends the batch; a queued or placed one keeps it frozen. */
  close(batchId: number): Promise<void> {
    return this.#serial(async () => {
      if (this.#batch?.batchId !== batchId) return;
      await this.#journal.append({ op: "close", batchId });
      this.#batch = undefined;
    });
  }

  #apply(record: QueueRecord): void {
    switch (record.op) {
      case "enqueue": {
        if (this.#items.length >= MAX_QUEUE_ITEMS) {
          this.#items = this.#items.slice(1);
          this.#dropped += 1;
        }
        this.#items = [...this.#items, record.item];
        return;
      }
      case "cut":
        this.#batch = record.batch;
        this.#items = this.#items.slice(record.batch.items.length);
        this.#dropped = 0;
        this.#nextBatchId = Math.max(this.#nextBatchId, record.batch.batchId + 1);
        return;
      case "close":
        if (this.#batch?.batchId === record.batchId) this.#batch = undefined;
        return;
      case "fire": {
        if (this.#items.length >= MAX_QUEUE_ITEMS) {
          this.#items = this.#items.slice(1);
          this.#dropped += 1;
        }
        this.#items = [...this.#items, record.item];
        this.#cursor = record.cursorAfter;
        return;
      }
      case "cursor":
        this.#cursor = record.at;
        return;
    }
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export type BatchPlan = {
  readonly taken: readonly QueueItem[];
  readonly text: string;
  readonly truncated: boolean;
};

/**
 * Chooses what fits and renders the envelope. Budget is measured on the rendered result,
 * never guessed: the header is bounded by construction, and the first item is always
 * admitted (marked when it alone overflows) so a batch cannot stall on one huge fire.
 */
export const planBatch = (input: {
  readonly kind: "schedule" | "webhook";
  readonly prompt: string;
  readonly items: readonly QueueItem[];
  readonly dropped: number;
}): BatchPlan => {
  // The limit is the send budget itself, measured on the rendered result: the header is
  // bounded by construction, so only the items can push a batch over it.
  const taken: QueueItem[] = [];
  for (const item of input.items) {
    const candidate = render({
      kind: input.kind,
      prompt: input.prompt,
      items: [...taken, item],
      dropped: input.dropped,
      truncated: false,
    });
    if (codePoints(candidate) > MAX_BATCH_TEXT) {
      if (taken.length > 0) break;
      // A single fire larger than the whole budget: mark it instead of dropping it. The
      // room is measured against the rendered line itself, because the marker also grows
      // the header, and the result must still fit what a send accepts.
      let room = Math.max(
        1,
        MAX_BATCH_TEXT -
          codePoints(render({ ...input, items: [{ ...item, text: "" }], truncated: true })),
      );
      let text = "";
      for (let pass = 0; pass < 4; pass += 1) {
        text = render({
          kind: input.kind,
          prompt: input.prompt,
          items: [{ ...item, text: truncate(item.text, room) }],
          dropped: input.dropped,
          truncated: true,
        });
        const excess = codePoints(text) - MAX_BATCH_TEXT;
        if (excess <= 0) break;
        room = Math.max(1, room - excess - 8);
      }
      return { taken: [item], text, truncated: true };
    }
    taken.push(item);
  }
  if (taken.length === 0) return { taken, text: "", truncated: false };
  return {
    taken,
    text: render({
      kind: input.kind,
      prompt: input.prompt,
      items: taken,
      dropped: input.dropped,
      truncated: false,
    }),
    truncated: false,
  };
};

/** `<prompt>`, then a bounded header, numbered items, and one instruction. */
export const render = (input: {
  readonly kind: "schedule" | "webhook";
  readonly prompt: string;
  readonly items: readonly QueueItem[];
  readonly dropped: number;
  readonly truncated: boolean;
}): string => {
  const first = input.items[0]?.receivedAt ?? "";
  const last = input.items[input.items.length - 1]?.receivedAt ?? "";
  const range = first === last ? shortTime(first) : `${shortTime(first)}..${shortTime(last)}`;
  const count = `${input.items.length} ${input.items.length === 1 ? "item" : "items"}`;
  const dropped = input.dropped > 0 ? ` · ${input.dropped} older events dropped` : "";
  const header = `[${input.kind} · ${count} · ${range}${dropped}]`;
  const body = input.items
    .map((item, index) => `${index + 1}. (${shortTime(item.receivedAt)}) ${item.text}`)
    .join("\n");
  const marked = input.truncated ? ` ${TRUNCATION_MARKER}` : "";
  return `${input.prompt}\n\n${header}${marked}\n${body}\n\n${FOOTER}`;
};

/** `2026-10-28T10:02:11.000Z` → `10:02Z`; a bare date keeps the day, never a timezone. */
const shortTime = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (match === null) return value;
  return `${match[1]} ${match[2]}Z`;
};

const codePoints = (value: string): number => Array.from(value).length;

/** Truncates to a code-point budget, leaving room for the marker itself. */
const truncate = (value: string, budget: number): string => {
  const points = Array.from(value);
  const room = Math.max(0, budget - codePoints(TRUNCATION_MARKER));
  return points.length <= room ? value : `${points.slice(0, room).join("")}${TRUNCATION_MARKER}`;
};

const parseRecord = (line: string): QueueRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.op === "enqueue")
    return isItem(record.item) ? { op: "enqueue", item: record.item } : undefined;
  if (record.op === "cut")
    return isBatch(record.batch) ? { op: "cut", batch: record.batch } : undefined;
  if (record.op === "close" && typeof record.batchId === "number") {
    return { op: "close", batchId: record.batchId };
  }
  if (record.op === "fire" && isItem(record.item)) {
    return {
      op: "fire",
      item: record.item,
      ...(typeof record.cursorAfter === "string" ? { cursorAfter: record.cursorAfter } : {}),
    };
  }
  if (record.op === "cursor") {
    return typeof record.at === "string" ? { op: "cursor", at: record.at } : { op: "cursor" };
  }
  return undefined;
};

const isItem = (value: unknown): value is QueueItem => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<QueueItem>;
  return (
    typeof item.itemId === "string" &&
    typeof item.text === "string" &&
    typeof item.receivedAt === "string"
  );
};

const isBatch = (value: unknown): value is FrozenBatch => {
  if (typeof value !== "object" || value === null) return false;
  const batch = value as Partial<FrozenBatch>;
  return (
    typeof batch.batchId === "number" &&
    typeof batch.requestId === "string" &&
    Array.isArray(batch.items) &&
    batch.items.every(isItem) &&
    typeof batch.text === "string" &&
    typeof batch.cutAt === "string" &&
    typeof batch.truncated === "boolean" &&
    typeof batch.dropped === "number"
  );
};
