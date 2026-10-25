// pi-durable → `RuntimeEvent` (docs/bots/RUNTIME.md, "Event mapping"). Pure: the mapper
// owns the attempt-scoped provisional, the submission ledger and the projected view, and
// never numbers revisions, touches a socket or reads the catalog.

import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  SnapshotEvent,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type {
  AgentView,
  ContentBlock,
  ConversationSnapshot,
  DeltaChange,
  InboxItem,
  Message,
  Submission,
} from "../../core/domain.ts";
import type { RuntimeEvent } from "../../core/RuntimePort.ts";
import {
  convertBlock,
  convertMessage,
  convertUsage,
  entryMessageId,
  messageBytes,
  provisionalMessageId,
  stopReasonOf,
} from "./convert.ts";
import { MAX_MESSAGE_BYTES, OVERSIZED_NOTICE, WINDOW_MESSAGES } from "./limits.ts";

export type EventMapperOptions = {
  readonly botId: string;
  readonly windowMessages?: number;
  readonly maxMessageBytes?: number;
  readonly now?: () => Date;
};

const inboxMode = (mode: string): InboxItem["mode"] =>
  mode === "steer" ? "steer" : mode === "followUp" ? "followUp" : "queue";

/** pi's submission record as the domain's, for the ids the wire carries. */
export const convertSubmission = (record: SubmissionRecord): Submission | undefined => {
  if (record.type !== "input") return undefined;
  const answer = "answer" in record ? record.answer : undefined;
  return {
    id: String(record.id),
    requestId: record.requestId ?? "",
    status: record.status,
    ...(record.entry === undefined ? {} : { entryId: entryMessageId(record.entry) }),
    ...(answer === undefined ? {} : { answerEntryId: entryMessageId(answer) }),
    ...(record.status === "unanswered" ? { reason: record.reason } : {}),
  };
};

/**
 * One bot's adapter state: the current attempt, its provisional id, the projected
 * window, the inbox and the submission ledger. `seed` renders the subscription's
 * baseline; `map` translates later commits.
 */
export class EventMapper {
  readonly #botId: string;
  readonly #window: number;
  readonly #maxMessageBytes: number;
  readonly #now: () => Date;

  #attempt = 0;
  /** True while pi has an attempt in flight that has not committed an entry yet. */
  #attemptOpen = false;
  #provisional: string | null = null;
  #withheld = false;
  #messages: Message[] = [];
  #truncatedBefore: string | undefined;
  #inbox: InboxItem[] = [];
  #running = false;
  #usage: ConversationSnapshot["usage"];
  #agent: AgentView | undefined;
  readonly #requestByEntry = new Map<string, string>();
  readonly #records = new Map<string, Submission>();

  constructor(options: EventMapperOptions) {
    this.#botId = options.botId;
    this.#window = options.windowMessages ?? WINDOW_MESSAGES;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** The current view, without publishing anything. */
  view(): ConversationSnapshot {
    return {
      botId: this.#botId,
      ...(this.#agent === undefined ? {} : { agent: this.#agent }),
      messages: [...this.#messages],
      ...(this.#truncatedBefore === undefined ? {} : { truncatedBefore: this.#truncatedBefore }),
      streaming: this.#streaming(),
      pending: [...this.#records.values()].filter(
        (record) => record.status === "queued" || record.status === "placed",
      ),
      inbox: [...this.#inbox],
      running: this.#running,
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    };
  }

  /**
   * Resets adapter state from an attach or reattach snapshot and returns its baseline.
   * `pending` is rebuilt from the snapshot itself — the submission ids the run and the
   * inbox name — plus any record `active` supplies, because a snapshot says which work
   * exists while only a record says what it is. A record that is not in the snapshot is
   * dropped: it settled, whatever the ledger last saw.
   */
  seed(event: SnapshotEvent, trace: string, active: readonly Submission[] = []): RuntimeEvent[] {
    this.#attempt = event.generation?.attempt ?? 0;
    this.#attemptOpen = event.generation !== undefined;
    this.#provisional = null;
    this.#withheld = false;
    const live = new Set<string>([
      ...(event.run?.inputs ?? []).map((id) => String(id)),
      ...event.inbox.map((item) => String(item.id)),
    ]);
    for (const record of active) {
      if (live.has(record.id)) this.#records.set(record.id, record);
    }
    for (const id of [...this.#records.keys()]) {
      if (!live.has(id)) this.#records.delete(id);
    }
    this.#running = event.run !== undefined;
    this.#inbox = event.inbox.map((item) => ({ id: String(item.id), mode: inboxMode(item.mode) }));
    this.#usage = convertUsage(event.usage);
    this.#agent = {
      model: {
        provider: event.agent.model?.provider ?? "",
        modelId: event.agent.model?.modelId ?? "",
      },
      thinkingLevel: event.agent.thinkingLevel ?? "off",
      instructions: event.agent.instructions ?? "",
    };

    const messages: Message[] = [];
    for (const entry of event.entries) {
      const message = this.#convertEntry(entry);
      if (message !== undefined) messages.push(message);
    }
    this.#setWindow(messages);

    const partial = event.generation?.message;
    if (partial !== undefined) {
      const message = asStreaming(
        convertMessage(partial, {
          id: provisionalMessageId(this.#attempt),
          now: this.#now,
        }),
      );
      if (message !== undefined) this.#openProvisional(message);
    }
    return [{ type: "snapshot", trace, value: this.view() }];
  }

  /** Translates one pi commit. Unknown or reserved events map to nothing. */
  map(event: AgentEvent, trace: string): RuntimeEvent[] {
    switch (event.type) {
      case "snapshot":
        return this.seed(event, trace);
      case "message_start":
        return this.#messageStart(event.message, trace);
      case "message_update":
        return this.#messageUpdate(event.changes, trace);
      case "message_end":
        return this.#messageEnd(event.entry, trace);
      case "run_start":
        this.#running = true;
        return [this.#status(trace)];
      case "run_end":
        this.#running = false;
        this.#closeProvisional();
        this.#attemptOpen = false;
        return [this.#status(trace)];
      case "inbox_update":
        this.#inbox = event.items.map((item) => ({
          id: String(item.id),
          mode: inboxMode(item.mode),
        }));
        return [this.#status(trace)];
      case "submission":
        return this.#submission(event.record, trace);
      case "usage_changed":
        this.#usage = convertUsage(event.usage);
        return [];
      case "agent_changed":
        this.#agent = {
          model: {
            provider: event.agent.model?.provider ?? "",
            modelId: event.agent.model?.modelId ?? "",
          },
          thinkingLevel: event.agent.thinkingLevel ?? "off",
          instructions: event.agent.instructions ?? "",
        };
        return [];
      case "deferred_poll":
        // F23: upstream dropped the partial, so the client must drop the provisional
        // too. Only a snapshot can say that, and `running` stays true: polling is work.
        this.#closeProvisional();
        return [
          { type: "snapshot", trace, value: { ...this.view(), running: true } },
          this.#status(trace),
        ];
      default:
        return [];
    }
  }

  /** Records a submission the adapter read itself, so the view and ledger agree. */
  record(record: SubmissionRecord, trace: string): RuntimeEvent[] {
    return this.#submission(record, trace);
  }

  /** Teaches the ledger a record without publishing an event: `submit` replies per connection. */
  observe(record: SubmissionRecord): void {
    this.#remember(record);
  }

  /** One committed entry as a domain message, for `history`. */
  entryMessage(entry: EntryRecord): Message | undefined {
    return this.#convertEntry(entry);
  }

  /** Committed entry ids of the messages the client can page back to. */
  historyCursor(): string | undefined {
    return this.#truncatedBefore;
  }

  #submission(record: SubmissionRecord, trace: string): RuntimeEvent[] {
    const converted = this.#remember(record);
    return converted === undefined ? [] : [{ type: "submission", trace, record: converted }];
  }

  #remember(record: SubmissionRecord): Submission | undefined {
    const converted = convertSubmission(record);
    if (converted === undefined) return undefined;
    if (converted.entryId !== undefined && converted.requestId.length > 0) {
      this.#requestByEntry.set(converted.entryId, converted.requestId);
      this.#attachRequestId(converted.entryId, converted.requestId);
    }
    this.#records.set(converted.id, converted);
    return converted;
  }

  /**
   * The user entry is committed in the same commit as its submission record, but the
   * `message_end` for it arrives first, so the request id lands on the message right after
   * and a later snapshot carries what the live append could not.
   */
  #attachRequestId(entryId: string, requestId: string): void {
    const index = this.#messages.findIndex((message) => message.id === entryId);
    const message = index < 0 ? undefined : this.#messages[index];
    if (message === undefined || message.requestId !== undefined) return;
    this.#messages[index] = { ...message, requestId };
  }

  #messageStart(
    message: Extract<AgentEvent, { type: "message_start" }>["message"],
    trace: string,
  ): RuntimeEvent[] {
    if (message.role !== "assistant") return [];
    if (message.stopReason === "deferred") return [];
    // A re-announcement keeps its attempt; a genuinely new attempt is the last one plus
    // one, even when the attach snapshot already counted the current attempt.
    const id =
      this.#provisional ??
      provisionalMessageId(this.#attemptOpen ? Math.max(this.#attempt, 1) : this.#attempt + 1);
    // A partial is always in flight, whatever the resolved message's `stopReason` says:
    // the entry that ends the attempt is what carries the final state.
    const converted = asStreaming(convertMessage(message, { id, now: this.#now }));
    if (converted === undefined) return [];
    if (this.#provisional !== null) {
      // The same attempt re-announced with its accumulated content (F4): keep the id and
      // replace the content wholesale instead of streaming it twice.
      if (this.#withheld) return [];
      if (messageBytes(converted) > this.#maxMessageBytes) return this.#withdrawProvisional(trace);
      this.#replaceMessage(converted);
      const changes: DeltaChange[] = [{ kind: "message", message: converted }];
      return [{ type: "delta", trace, messageId: id, changes }];
    }
    if (!this.#attemptOpen) this.#attempt += 1;
    this.#attemptOpen = true;
    this.#provisional = id;
    return this.#appendProvisional(converted, trace);
  }

  #messageUpdate(changes: readonly MessageChange[], trace: string): RuntimeEvent[] {
    const id = this.#provisional;
    if (id === null || this.#withheld) return [];
    const index = this.#messages.findIndex((item) => item.id === id);
    // A delta for an unknown id belongs to a state a snapshot already reset (F8).
    if (index < 0) return [];
    const converted: DeltaChange[] = [];
    for (const change of changes) {
      switch (change.type) {
        case "text_delta":
        case "thinking_delta":
          converted.push({
            kind: change.type === "text_delta" ? "text" : "thinking",
            index: change.contentIndex,
            append: change.delta,
          });
          break;
        case "toolcall_delta": {
          const block = (this.#messages[index] as Message).blocks[change.contentIndex];
          converted.push({
            kind: "toolcall",
            index: change.contentIndex,
            callId: block !== undefined && block.type === "toolCall" ? block.callId : "",
            path: change.path,
            append: change.delta,
          });
          break;
        }
        case "message": {
          const message = asStreaming(convertMessage(change.message, { id, now: this.#now }));
          if (message !== undefined) converted.push({ kind: "message", message });
          break;
        }
        default: {
          const block = convertBlock(change.block);
          if (block !== undefined) {
            converted.push({ kind: "block", index: change.contentIndex, block });
          }
        }
      }
    }
    if (converted.length === 0) return [];
    let message = this.#messages[index] as Message;
    for (const change of converted) message = applyChange(message, change);
    this.#messages[index] = message;
    if (this.#provisionalBytesExceeded()) return this.#withdrawProvisional(trace);
    return [{ type: "delta", trace, messageId: id, changes: converted }];
  }

  #messageEnd(entry: EntryRecord, trace: string): RuntimeEvent[] {
    if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return [];
    const replaces = this.#provisional ?? undefined;
    const message = this.#convertEntry(entry);
    this.#provisional = null;
    this.#withheld = false;
    if (entry.kind === "pi.assistant") this.#attemptOpen = false;
    if (message === undefined) return [];
    this.#upsert(message, replaces);
    return [
      {
        type: "append",
        trace,
        message,
        ...(replaces === undefined ? {} : { replaces }),
      },
    ];
  }

  #appendProvisional(message: Message, trace: string): RuntimeEvent[] {
    if (messageBytes(message) > this.#maxMessageBytes) {
      this.#withheld = true;
      return this.#withdrawProvisional(trace);
    }
    this.#messages.push(message);
    this.#trim();
    return [{ type: "append", trace, message }];
  }

  #openProvisional(message: Message): void {
    this.#provisional = message.id;
    if (messageBytes(message) > this.#maxMessageBytes) {
      this.#withheld = true;
      return;
    }
    this.#messages.push(message);
    this.#trim();
  }

  /** PROTOCOL.md: an over-limit attempt is withdrawn through a snapshot, streaming null. */
  #withdrawProvisional(trace: string): RuntimeEvent[] {
    this.#withheld = true;
    this.#dropProvisional();
    return [{ type: "snapshot", trace, value: this.view() }, this.#status(trace)];
  }

  /** Ends the attempt without a committed entry (a run that ended, or a deferred poll). */
  #closeProvisional(): void {
    this.#dropProvisional();
    this.#provisional = null;
    this.#withheld = false;
    // The closed attempt keeps its id: the next attempt must not reuse `p_a<n>`.
    this.#attemptOpen = false;
  }

  #dropProvisional(): void {
    const id = this.#provisional;
    if (id === null) return;
    this.#messages = this.#messages.filter((message) => message.id !== id);
  }

  #provisionalBytesExceeded(): boolean {
    const id = this.#provisional;
    if (id === null) return false;
    const message = this.#messages.find((item) => item.id === id);
    return message !== undefined && messageBytes(message) > this.#maxMessageBytes;
  }

  #status(trace: string): RuntimeEvent {
    return {
      type: "status",
      trace,
      running: this.#running,
      streaming: this.#streaming(),
      inbox: [...this.#inbox],
    };
  }

  #streaming(): string | null {
    return this.#withheld ? null : this.#provisional;
  }

  #convertEntry(entry: EntryRecord): Message | undefined {
    const model = entry.model?.[0];
    if (model === undefined) return undefined;
    if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return undefined;
    const id = entryMessageId(entry.id);
    const requestId = this.#requestByEntry.get(id);
    const message = convertMessage(model, {
      id,
      now: this.#now,
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (message === undefined) return undefined;
    if (messageBytes(message) > this.#maxMessageBytes) return this.#notice(id, message.createdAt);
    return message;
  }

  /** The withheld answer's replacement: the entry's own id and timestamp, so a reconnect sees the same. */
  #notice(id: string, createdAt: string): Message {
    return {
      id,
      role: "notice",
      state: "complete",
      createdAt,
      blocks: [{ type: "text", text: OVERSIZED_NOTICE }],
    };
  }

  #replaceMessage(message: Message): void {
    const index = this.#messages.findIndex((item) => item.id === message.id);
    if (index >= 0) this.#messages[index] = message;
    else this.#messages.push(message);
    this.#trim();
  }

  #upsert(message: Message, replaces?: string): void {
    let index = replaces === undefined ? -1 : this.#messages.findIndex((m) => m.id === replaces);
    if (index < 0) index = this.#messages.findIndex((item) => item.id === message.id);
    if (index >= 0) this.#messages[index] = message;
    else this.#messages.push(message);
    this.#trim();
  }

  #setWindow(messages: readonly Message[]): void {
    this.#messages = [...messages];
    this.#truncatedBefore = undefined;
    this.#trim();
  }

  #trim(): void {
    if (this.#messages.length <= this.#window) return;
    const dropped = this.#messages.slice(0, this.#messages.length - this.#window);
    const first = dropped.find((message) => message.id.startsWith("e_"));
    if (first !== undefined) this.#truncatedBefore = first.id;
    this.#messages = this.#messages.slice(-this.#window);
  }
}

/** The provisional is `streaming` and has no stop reason until its entry commits. */
const asStreaming = (message: Message | undefined): Message | undefined =>
  message === undefined
    ? undefined
    : {
        id: message.id,
        role: "assistant",
        state: "streaming",
        createdAt: message.createdAt,
        blocks: message.blocks,
      };

/** Applies one change to a message; the snapshot fold must agree with the wire's. */
export const applyChange = (message: Message, change: DeltaChange): Message => {
  if (change.kind === "message") return change.message;
  const blocks = [...message.blocks];
  if (change.kind === "block") {
    blocks[change.index] = change.block;
    return { ...message, blocks };
  }
  const block = blocks[change.index];
  if (block === undefined) return message;
  if (change.kind === "text" && block.type === "text") {
    blocks[change.index] = { type: "text", text: block.text + change.append };
    return { ...message, blocks };
  }
  if (change.kind === "thinking" && block.type === "thinking") {
    blocks[change.index] = { type: "thinking", text: block.text + change.append };
    return { ...message, blocks };
  }
  if (change.kind === "toolcall" && block.type === "toolCall") {
    const call: ContentBlock = structuredClone(block);
    if (call.type !== "toolCall") return message;
    let node = call.args as Record<string | number, unknown>;
    for (const key of change.path.slice(0, -1)) {
      const next = node[key];
      if (next === null || typeof next !== "object") return message;
      node = next as Record<string | number, unknown>;
    }
    const leaf = change.path[change.path.length - 1];
    if (leaf === undefined) return message;
    const prior = node[leaf];
    node[leaf] = `${typeof prior === "string" ? prior : ""}${change.append}`;
    blocks[change.index] = call;
    return { ...message, blocks };
  }
  return message;
};

export const createEventMapper = (options: EventMapperOptions): EventMapper =>
  new EventMapper(options);

export { stopReasonOf };
