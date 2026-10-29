// Trigger definitions (docs/bots/TRIGGERS.md §4). One append-only journal per bot is the
// source of truth: a mutation is one record carrying its operation id and its result, so a
// replayed tool call returns what it already did instead of mutating twice, and a crash can
// never leave a half-applied definition. Definitions belong to the bot; the model is their
// only author.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type TriggerKind = "schedule" | "webhook";

export type TriggerCounters = {
  readonly fired: number;
  readonly dropped: number;
  readonly refused: number;
};

export type TriggerSchedule = {
  /** Five fields, minute resolution; the parser validates the expression itself. */
  readonly cron: string;
  /** IANA zone name. */
  readonly timezone: string;
};

export type TriggerDefinition = {
  readonly id: string;
  readonly botId: string;
  readonly kind: TriggerKind;
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schedule?: TriggerSchedule;
  readonly counters: TriggerCounters;
  readonly lastFiredAt?: string;
  readonly lastSkipped?: {
    readonly at: string;
    readonly reason: "disabled" | "missed" | "rate_limited" | "queue_full";
  };
};

/** The engine-owned fields a tick may change; a person and a model cannot set them. */
/**
 * The engine-owned fields a tick or a delivery may change. The schedule *cursor* is not
 * here: it is delivery state and lives in the queue's journal, so one record can advance
 * it together with the fire it belongs to (TRIGGERS.md §9.1).
 */
export type TriggerStatePatch = {
  readonly counters?: TriggerCounters;
  readonly lastFiredAt?: string;
  readonly lastSkipped?: TriggerDefinition["lastSkipped"];
};

/** One bot owns at most this many definitions; it bounds the sidebar and the trigger tools. */
export const MAX_TRIGGERS = 8;
export const MAX_TRIGGER_NAME = 64;
export const MAX_TRIGGER_PROMPT = 4_000;
export const MAX_CRON = 64;
const MAX_JOURNAL_RECORDS = 1_000;

export type TriggerRefusal =
  | "not_found"
  | "name_taken"
  | "cap"
  | "invalid"
  | "conflict"
  | "kind_mismatch";

/** A refusal the tool layer turns into a model-visible message; never a thrown bug. */
export class TriggerStoreError extends Error {
  readonly reason: TriggerRefusal;

  constructor(reason: TriggerRefusal, message: string) {
    super(message);
    this.name = "TriggerStoreError";
    this.reason = reason;
  }
}

export const triggerJournalPath = (botDir: string): string => `${botDir}/triggers.journal.jsonl`;

type OperationResult = { readonly trigger?: TriggerDefinition; readonly created?: boolean };

type JournalRecord =
  | { readonly op: "snapshot"; readonly triggers: readonly TriggerDefinition[] }
  | {
      readonly op: "create";
      readonly opId: string;
      readonly trigger: TriggerDefinition;
    }
  | {
      readonly op: "update";
      readonly opId: string;
      readonly triggerId: string;
      readonly trigger: TriggerDefinition;
    }
  | {
      readonly op: "enable";
      readonly opId: string;
      readonly triggerId: string;
      readonly trigger: TriggerDefinition;
    }
  | { readonly op: "remove"; readonly opId: string; readonly triggerId: string }
  | {
      readonly op: "state";
      readonly triggerId: string;
      readonly patch: TriggerStatePatch;
    };

export type CreateTriggerInput = {
  readonly opId: string;
  readonly kind: TriggerKind;
  readonly name: string;
  readonly prompt: string;
  readonly schedule?: { readonly cron: string; readonly timezone: string };
};

export type TriggerStoreOptions = {
  /** Deterministic clock for tests; the daemon passes the real one. */
  readonly now?: () => Date;
  /** Deterministic ids for tests. */
  readonly newId?: () => string;
  /** Told after every applied mutation, so the sidebar can follow a model's edit. */
  readonly onChange?: (triggers: readonly TriggerDefinition[]) => void;
  /** Told once the replay finished, with anything it could not read. */
  readonly onDropped?: (count: number) => void;
};

export class TriggerStore {
  readonly #path: string;
  readonly #botId: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #triggers = new Map<string, TriggerDefinition>();
  /** opId → what that operation did, so a replay answers instead of acting. */
  readonly #byOp = new Map<string, OperationResult>();
  /** Serialized journal writes and mutations: check-then-append is one section. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Journal records read on open, for the compaction decision. */
  #records = 0;
  readonly #onChange: ((triggers: readonly TriggerDefinition[]) => void) | undefined;

  private constructor(botId: string, path: string, options: TriggerStoreOptions) {
    this.#botId = botId;
    this.#path = path;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? newTriggerId;
    this.#onChange = options.onChange;
  }

  static async open(
    botId: string,
    path: string,
    options: TriggerStoreOptions = {},
  ): Promise<TriggerStore> {
    const store = new TriggerStore(botId, path, options);
    let body = "";
    try {
      body = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    let dropped = 0;
    for (const line of body.split("\n")) {
      if (line.trim().length === 0) continue;
      const record = parseRecord(line);
      if (record === undefined) {
        dropped += 1;
        continue;
      }
      store.#records += 1;
      store.#apply(record);
    }
    if (dropped > 0) options.onDropped?.(dropped);
    if (store.#records > MAX_JOURNAL_RECORDS) await store.#compact();
    return store;
  }

  /** Definitions in creation order, which is the order the sidebar renders. */
  list(): readonly TriggerDefinition[] {
    return [...this.#triggers.values()];
  }

  get(id: string): TriggerDefinition | undefined {
    return this.#triggers.get(id);
  }

  findByName(name: string): TriggerDefinition | undefined {
    for (const trigger of this.#triggers.values()) {
      if (trigger.name === name) return trigger;
    }
    return undefined;
  }

  /** Idempotent by `(botId, name)` **and** by `opId`: SDK `safe` reruns the handler. */
  create(input: CreateTriggerInput): Promise<{ trigger: TriggerDefinition; created: boolean }> {
    return this.#mutate(async () => {
      const replay = this.#replay(input.opId);
      if (replay !== undefined) {
        const trigger = replay.trigger as TriggerDefinition;
        return { trigger, created: replay.created === true };
      }
      const name = validName(input.name);
      const prompt = validPrompt(input.prompt);
      const schedule = input.kind === "schedule" ? validSchedule(input.schedule) : undefined;
      if (input.kind === "webhook" && input.schedule !== undefined) {
        throw new TriggerStoreError("kind_mismatch", "a webhook trigger has no schedule");
      }
      if (input.kind === "schedule" && schedule === undefined) {
        throw new TriggerStoreError("kind_mismatch", "a schedule trigger needs a cron and a zone");
      }
      const existing = this.findByName(name);
      if (existing !== undefined) {
        // A replay that already happened under another opId returns the stored definition;
        // a genuinely different definition under a taken name is refused.
        if (
          existing.kind === input.kind &&
          existing.prompt === prompt &&
          existing.schedule?.cron === schedule?.cron &&
          existing.schedule?.timezone === schedule?.timezone
        ) {
          this.#remember(input.opId, { trigger: existing, created: false });
          return { trigger: existing, created: false };
        }
        throw new TriggerStoreError("name_taken", `a trigger named ${name} already exists`);
      }
      if (this.#triggers.size >= MAX_TRIGGERS) {
        throw new TriggerStoreError("cap", `a bot holds at most ${MAX_TRIGGERS} triggers`);
      }
      const at = this.#now().toISOString();
      const trigger: TriggerDefinition = {
        id: this.#newId(),
        botId: this.#botId,
        kind: input.kind,
        name,
        prompt,
        enabled: true,
        createdAt: at,
        updatedAt: at,
        ...(schedule === undefined ? {} : { schedule }),
        counters: { fired: 0, dropped: 0, refused: 0 },
      };
      if (this.#triggers.has(trigger.id)) throw new Error("trigger id collision");
      await this.#commit({ op: "create", opId: input.opId, trigger });
      this.#remember(input.opId, { trigger, created: true });
      return { trigger, created: true };
    });
  }

  /** Name and prompt only: changing the schedule is a separate, cursor-resetting operation. */
  update(input: {
    readonly opId: string;
    readonly triggerId: string;
    readonly name?: string;
    readonly prompt?: string;
  }): Promise<TriggerDefinition> {
    return this.#mutate(async () => {
      const replay = this.#replay(input.opId);
      if (replay !== undefined) return replay.trigger as TriggerDefinition;
      const current = this.#require(input.triggerId);
      const name = input.name === undefined ? current.name : validName(input.name);
      const prompt = input.prompt === undefined ? current.prompt : validPrompt(input.prompt);
      const clash = this.findByName(name);
      if (clash !== undefined && clash.id !== current.id) {
        throw new TriggerStoreError("name_taken", `a trigger named ${name} already exists`);
      }
      const trigger: TriggerDefinition = {
        ...current,
        name,
        prompt,
        updatedAt: this.#now().toISOString(),
      };
      if (trigger.name === current.name && trigger.prompt === current.prompt) {
        this.#remember(input.opId, { trigger: current });
        return current;
      }
      await this.#commit({ op: "update", opId: input.opId, triggerId: current.id, trigger });
      this.#remember(input.opId, { trigger });
      return trigger;
    });
  }

  /**
   * Switching keeps the queue and does not touch the delivery cursor: the caller owns it,
   * so disabling drops it and enabling starts at the next instant (§9.1).
   */
  enable(input: {
    readonly opId: string;
    readonly triggerId: string;
    readonly enabled: boolean;
  }): Promise<TriggerDefinition> {
    return this.#mutate(async () => {
      const replay = this.#replay(input.opId);
      if (replay !== undefined) return replay.trigger as TriggerDefinition;
      const current = this.#require(input.triggerId);
      if (current.enabled === input.enabled) {
        this.#remember(input.opId, { trigger: current });
        return current;
      }
      const trigger: TriggerDefinition = {
        ...current,
        enabled: input.enabled,
        updatedAt: this.#now().toISOString(),
      };
      await this.#commit({ op: "enable", opId: input.opId, triggerId: current.id, trigger });
      this.#remember(input.opId, { trigger });
      return trigger;
    });
  }

  /** Deleting an absent trigger answers like a delete: the caller asked for an absence. */
  remove(input: { readonly opId: string; readonly triggerId: string }): Promise<{
    triggerId: string;
  }> {
    return this.#mutate(async () => {
      const replay = this.#replay(input.opId);
      if (replay !== undefined) return { triggerId: input.triggerId };
      if (!this.#triggers.has(input.triggerId)) {
        this.#remember(input.opId, {});
        return { triggerId: input.triggerId };
      }
      await this.#commit({ op: "remove", opId: input.opId, triggerId: input.triggerId });
      this.#remember(input.opId, {});
      return { triggerId: input.triggerId };
    });
  }

  /** Engine-owned bookkeeping: counters, cursor, last fired or skipped. */
  patch(input: {
    readonly triggerId: string;
    readonly patch: TriggerStatePatch;
  }): Promise<TriggerDefinition> {
    return this.#mutate(async () => {
      const current = this.#require(input.triggerId);
      const trigger = applyPatch(current, input.patch);
      await this.#commit({ op: "state", triggerId: current.id, patch: input.patch });
      return trigger;
    });
  }

  #require(id: string): TriggerDefinition {
    const found = this.#triggers.get(id);
    if (found === undefined) throw new TriggerStoreError("not_found", `no trigger ${id}`);
    return found;
  }

  #replay(opId: string): OperationResult | undefined {
    return this.#byOp.get(opId);
  }

  #remember(opId: string, result: OperationResult): void {
    this.#byOp.set(opId, result);
  }

  /** One serial section: the journal write lands before the caller is answered. */
  #mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #commit(record: JournalRecord): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.#records += 1;
    this.#apply(record);
    // A replayed `opId` answers without reaching here, so this is one call per real change.
    this.#onChange?.(this.list());
  }

  #apply(record: JournalRecord): void {
    switch (record.op) {
      case "snapshot":
        this.#triggers.clear();
        for (const trigger of record.triggers) this.#triggers.set(trigger.id, trigger);
        return;
      case "create":
      case "update":
      case "enable":
        this.#triggers.set(record.trigger.id, record.trigger);
        this.#byOp.set(record.opId, {
          trigger: record.trigger,
          ...(record.op === "create" ? { created: true } : {}),
        });
        return;
      case "remove":
        this.#triggers.delete(record.triggerId);
        this.#byOp.set(record.opId, {});
        return;
      case "state": {
        const current = this.#triggers.get(record.triggerId);
        if (current === undefined) return;
        this.#triggers.set(record.triggerId, applyPatch(current, record.patch));
        return;
      }
    }
  }

  /** Collapses the journal to its current state, so a busy bot does not read forever. */
  async #compact(): Promise<void> {
    const temporary = `${this.#path}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    const snapshot: JournalRecord = { op: "snapshot", triggers: this.list() };
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
    this.#records = 1;
  }
}

/** Explicit merging, because an absent field means "keep" and `undefined` must not write. */
const applyPatch = (current: TriggerDefinition, patch: TriggerStatePatch): TriggerDefinition => ({
  ...current,
  ...(patch.counters === undefined ? {} : { counters: patch.counters }),
  ...(patch.lastFiredAt === undefined ? {} : { lastFiredAt: patch.lastFiredAt }),
  ...(patch.lastSkipped === undefined ? {} : { lastSkipped: patch.lastSkipped }),
});

export const newTriggerId = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(10);
  let id = "t_";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
};

const validName = (value: string): string => {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_TRIGGER_NAME) {
    throw new TriggerStoreError("invalid", `a trigger name is 1..${MAX_TRIGGER_NAME} characters`);
  }
  return name;
};

const validPrompt = (value: string): string => {
  if (Array.from(value).length === 0 || Array.from(value).length > MAX_TRIGGER_PROMPT) {
    throw new TriggerStoreError("invalid", `a prompt is 1..${MAX_TRIGGER_PROMPT} characters`);
  }
  return value;
};

const validSchedule = (
  input: { readonly cron: string; readonly timezone: string } | undefined,
): TriggerSchedule => {
  if (input === undefined) {
    throw new TriggerStoreError("invalid", "a schedule trigger needs a cron and a zone");
  }
  const cron = input.cron.trim().replace(/\s+/g, " ");
  if (cron.length === 0 || cron.length > MAX_CRON || cron.split(" ").length !== 5) {
    throw new TriggerStoreError("invalid", "cron is five fields, e.g. 0 9 * * *");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new TriggerStoreError("invalid", `unknown time zone ${input.timezone}`);
  }
  return { cron, timezone: input.timezone };
};

const parseRecord = (line: string): JournalRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const op = record.op;
  if (op === "snapshot") {
    if (!Array.isArray(record.triggers)) return undefined;
    const triggers = record.triggers.filter(isTrigger);
    return { op: "snapshot", triggers };
  }
  if (op === "create" || op === "update" || op === "enable") {
    if (typeof record.opId !== "string" || !isTrigger(record.trigger)) return undefined;
    const triggerId = record.op === "create" ? undefined : record.triggerId;
    if (triggerId !== undefined && typeof triggerId !== "string") return undefined;
    return op === "create"
      ? { op, opId: record.opId, trigger: record.trigger }
      : { op, opId: record.opId, triggerId: triggerId as string, trigger: record.trigger };
  }
  if (op === "remove") {
    return typeof record.opId === "string" && typeof record.triggerId === "string"
      ? { op, opId: record.opId, triggerId: record.triggerId }
      : undefined;
  }
  if (op === "state") {
    if (typeof record.triggerId !== "string") return undefined;
    if (typeof record.patch !== "object" || record.patch === null) return undefined;
    return { op, triggerId: record.triggerId, patch: record.patch as TriggerStatePatch };
  }
  return undefined;
};

const isTrigger = (value: unknown): value is TriggerDefinition => {
  if (typeof value !== "object" || value === null) return false;
  const trigger = value as Partial<TriggerDefinition>;
  return (
    typeof trigger.id === "string" &&
    typeof trigger.botId === "string" &&
    (trigger.kind === "schedule" || trigger.kind === "webhook") &&
    typeof trigger.name === "string" &&
    typeof trigger.prompt === "string" &&
    typeof trigger.enabled === "boolean" &&
    typeof trigger.createdAt === "string" &&
    typeof trigger.updatedAt === "string" &&
    typeof trigger.counters === "object" &&
    trigger.counters !== null
  );
};
