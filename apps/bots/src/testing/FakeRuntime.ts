// A scripted runtime for core tests. Each bot id gets its own handle and state, opening
// the same id twice returns the same handle, and every emitted event is applied to that
// state, so `submission()`, `history()` and `subscribe()` answer from what was delivered.
import type { ConversationSnapshot, DeltaChange, Message, Submission } from "../core/domain.ts";
import type {
  RuntimeBotSpec,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeHistory,
  RuntimePort,
  RuntimeSubscription,
  SubmitInput,
} from "../core/RuntimePort.ts";

export type FakeScript = {
  /** Events emitted after a submit is admitted. */
  readonly onSubmit?: (input: SubmitInput) => RuntimeEvent[];
};

export class FakeHandle implements RuntimeHandle {
  readonly spec: RuntimeBotSpec;
  readonly opens: string[] = [];
  readonly closes: { trace: string; deadlineMs: number }[] = [];
  readonly #script: FakeScript;
  #snapshot: ConversationSnapshot;
  /** Every message ever committed, in order: the window may move, history may not. */
  #committed: Message[] = [];
  #sink: ((event: RuntimeEvent) => void) | undefined;
  #submissions = new Map<string, Submission>();

  closed = false;

  constructor(
    spec: RuntimeBotSpec,
    options: { script?: FakeScript; snapshot?: (() => ConversationSnapshot) | undefined },
  ) {
    this.spec = spec;
    this.#script = options.script ?? {};
    this.#snapshot = options.snapshot?.() ?? {
      botId: spec.id,
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    };
    this.#committed = [...this.#snapshot.messages];
    for (const record of this.#snapshot.pending) this.#submissions.set(record.requestId, record);
  }

  get snapshot(): ConversationSnapshot {
    return this.#snapshot;
  }

  subscribe(trace: string, sink: (event: RuntimeEvent) => void): Promise<RuntimeSubscription> {
    void trace;
    this.#sink = sink;
    return Promise.resolve({ snapshot: this.#snapshot, detach: () => (this.#sink = undefined) });
  }

  async submit(input: SubmitInput): Promise<Submission> {
    const existing = this.#submissions.get(input.requestId);
    if (existing) return existing;
    const record: Submission = {
      id: this.#nextSubmissionId(),
      requestId: input.requestId,
      status: "queued",
    };
    this.#submissions.set(input.requestId, record);
    this.#snapshot = { ...this.#snapshot, pending: [...this.#snapshot.pending, record] };
    for (const event of this.#script.onSubmit?.(input) ?? []) this.emit(event);
    return this.#submissions.get(input.requestId) ?? record;
  }

  submission(
    key: { submissionId: string } | { requestId: string },
  ): Promise<Submission | undefined> {
    const found =
      "submissionId" in key
        ? [...this.#submissions.values()].find((record) => record.id === key.submissionId)
        : this.#submissions.get(key.requestId);
    return Promise.resolve(found);
  }

  history(input: { beforeEntryId?: string; limit: number }): Promise<RuntimeHistory> {
    const messages: readonly Message[] = this.#committed;
    const end = input.beforeEntryId
      ? Math.max(
          0,
          messages.findIndex((message) => message.id === input.beforeEntryId),
        )
      : messages.length;
    const start = Math.max(0, end - input.limit);
    return Promise.resolve({ messages: messages.slice(start, end), hasMore: start > 0 });
  }

  abort(trace: string): Promise<void> {
    void trace;
    return Promise.resolve();
  }

  recover(trace: string): Promise<void> {
    void trace;
    return Promise.resolve();
  }

  busy(): Promise<{ run: boolean; tasks: boolean }> {
    return Promise.resolve({ run: this.#snapshot.running, tasks: false });
  }

  close(trace: string, deadlineMs: number): Promise<"closed" | "timeout"> {
    this.closes.push({ trace, deadlineMs });
    this.closed = true;
    this.#sink = undefined;
    return Promise.resolve("closed");
  }

  /** Delivers an event and applies it to this bot's state. */
  emit(event: RuntimeEvent): void {
    this.#apply(event);
    this.#sink?.(event);
  }

  /** Never collides with an id restored from a snapshot. */
  #nextSubmissionId(): string {
    let highest = 0;
    for (const id of [...this.#submissions.values()].map((record) => record.id)) {
      const match = /^s_(\d+)$/.exec(id);
      if (match?.[1]) highest = Math.max(highest, Number(match[1]));
    }
    return `s_${highest + 1}`;
  }

  #apply(event: RuntimeEvent): void {
    if (event.type === "append") {
      this.#committed = upsert(this.#committed, event.message, event.replaces);
      const messages = upsert(this.#snapshot.messages, event.message, event.replaces);
      // A provisional becomes the streaming target; anything else that supersedes it
      // clears the pointer, so a late joiner sees the real attempt state.
      let streaming = this.#snapshot.streaming;
      if (event.message.state === "streaming") streaming = event.message.id;
      else if (streaming === event.message.id || streaming === event.replaces) streaming = null;
      this.#snapshot = { ...this.#snapshot, messages, streaming };
      return;
    }
    if (event.type === "delta") {
      const update = (message: Message): Message => applyChanges(message, event.changes);
      const hasTarget = (message: Message): boolean => message.id === event.messageId;
      this.#committed = this.#committed.map((message) =>
        hasTarget(message) ? update(message) : message,
      );
      const messages = this.#snapshot.messages.map((message) =>
        hasTarget(message) ? update(message) : message,
      );
      this.#snapshot = { ...this.#snapshot, messages };
      return;
    }
    if (event.type === "snapshot") {
      this.#snapshot = event.value;
      // The window may shrink, but committed history stays readable through history().
      for (const message of event.value.messages) {
        this.#committed = upsert(this.#committed, message);
      }
      // The snapshot is the authority for pending, running and streaming; keep any
      // settled record the ledger already knows about.
      for (const record of event.value.pending) this.#submissions.set(record.requestId, record);
      return;
    }
    if (event.type === "status") {
      // running comes from the snapshot, which was just replaced.
      this.#snapshot = {
        ...this.#snapshot,
        running: event.running,
        streaming: event.streaming,
        inbox: event.inbox,
      };
      return;
    }
    if (event.type === "submission") {
      this.#submissions.set(event.record.requestId, event.record);
      const pending = this.#snapshot.pending
        .filter((record) => record.id !== event.record.id)
        .concat(
          event.record.status === "done" || event.record.status === "unanswered"
            ? []
            : [event.record],
        );
      this.#snapshot = { ...this.#snapshot, pending };
    }
  }
}

const upsert = (messages: readonly Message[], message: Message, replaces?: string): Message[] => {
  const next = [...messages];
  const replaced = replaces === undefined ? -1 : next.findIndex((item) => item.id === replaces);
  const existing = next.findIndex((item) => item.id === message.id);
  const target = replaced >= 0 ? replaced : existing;
  if (target >= 0) next[target] = message;
  else next.push(message);
  return next;
};

/** Applies delta changes in order: a message replacement swaps the working message. */
const applyChanges = (message: Message, changes: readonly DeltaChange[]): Message => {
  let current = message;
  let blocks = [...current.blocks];
  for (const change of changes) {
    if (change.kind === "message") {
      current = change.message;
      blocks = [...current.blocks];
      continue;
    }
    if (change.kind === "block") {
      blocks[change.index] = change.block;
      continue;
    }
    const block = blocks[change.index];
    if (block === undefined) continue;
    if (
      (change.kind === "text" && block.type === "text") ||
      (change.kind === "thinking" && block.type === "thinking")
    ) {
      blocks[change.index] = { ...block, text: block.text + change.append };
      continue;
    }
    if (change.kind === "toolcall" && block.type === "toolCall") {
      const call = structuredClone(block);
      appendAtPath(call, change.path, change.append);
      blocks[change.index] = call;
    }
  }
  return { ...current, blocks };
};

/** A toolcall path is rooted at the block: `["args","q"]` appends to `block.args.q`. */
const appendAtPath = (root: object, path: readonly (string | number)[], append: string): void => {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") return;
    node = next as Record<string | number, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  const prior = node[leaf];
  node[leaf] = `${typeof prior === "string" ? prior : ""}${append}`;
};

export class FakeRuntime implements RuntimePort {
  readonly #options: {
    script?: FakeScript;
    snapshot?: (() => ConversationSnapshot) | undefined;
  };
  readonly handles = new Map<string, FakeHandle>();

  constructor(
    options: { script?: FakeScript; snapshot?: (() => ConversationSnapshot) | undefined } = {},
  ) {
    this.#options = options;
  }

  async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
    const existing = this.handles.get(spec.id);
    if (existing) return existing;
    const handle = new FakeHandle(spec, this.#options);
    this.handles.set(spec.id, handle);
    return handle;
  }

  handle(id: string): FakeHandle {
    const found = this.handles.get(id);
    if (!found) throw new Error(`bot ${id} is not open`);
    return found;
  }
}
