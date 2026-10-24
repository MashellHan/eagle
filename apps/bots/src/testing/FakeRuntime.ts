// A scripted runtime for core tests. Each bot id gets its own handle and state, opening
// the same id twice returns the same handle, and every emitted event is applied to that
// state, so `submission()`, `history()` and `subscribe()` answer from what was delivered.
import type { ConversationSnapshot, Message, Submission } from "../core/domain.ts";
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
      id: `s_${this.#submissions.size + 1}`,
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
    const messages: readonly Message[] = this.#snapshot.messages;
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

  #apply(event: RuntimeEvent): void {
    if (event.type === "append") {
      const messages = [...this.#snapshot.messages];
      const replaced = event.replaces ? messages.findIndex((m) => m.id === event.replaces) : -1;
      const existing = messages.findIndex((m) => m.id === event.message.id);
      const target = replaced >= 0 ? replaced : existing;
      if (target >= 0) messages[target] = event.message;
      else messages.push(event.message);
      // A replaced provisional is gone, so a streaming pointer at it must move too.
      const streaming =
        event.replaces && this.#snapshot.streaming === event.replaces
          ? event.message.state === "streaming"
            ? event.message.id
            : null
          : this.#snapshot.streaming;
      this.#snapshot = { ...this.#snapshot, messages, streaming };
      return;
    }
    if (event.type === "delta") {
      const messages = this.#snapshot.messages.map((message) => {
        if (message.id !== event.messageId) return message;
        const blocks = message.blocks.map((block) => ({ ...block })) as {
          type: string;
          text?: string;
          [key: string]: unknown;
        }[];
        for (const change of event.changes) {
          if (change.kind === "text" || change.kind === "thinking") {
            const block = blocks[change.index];
            if (block && typeof block.text === "string") block.text += change.append;
          } else if (change.kind === "block") {
            blocks[change.index] = { ...change.block } as never;
          } else if (change.kind === "message") {
            return change.message;
          }
        }
        return { ...message, blocks: blocks as never };
      });
      this.#snapshot = { ...this.#snapshot, messages };
      return;
    }
    if (event.type === "snapshot") {
      this.#snapshot = event.value;
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
