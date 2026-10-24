// A scripted runtime for core tests. It implements the port exactly, keeps no
// persistence, and lets a test decide when each event is delivered.
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

export class FakeRuntime implements RuntimePort {
  readonly #script: FakeScript;
  readonly #clock: () => number;
  readonly opens: string[] = [];
  readonly closes: { trace: string; deadlineMs: number }[] = [];
  #snapshot: ConversationSnapshot;
  #sink: ((event: RuntimeEvent) => void) | undefined;
  #submissions = new Map<string, Submission>();
  #closed = false;

  constructor(
    options: { script?: FakeScript; clock?: () => number; snapshot?: ConversationSnapshot } = {},
  ) {
    this.#script = options.script ?? {};
    this.#clock = options.clock ?? (() => 0);
    this.#snapshot = options.snapshot ?? {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    };
  }

  async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
    this.opens.push(spec.id);
    return new FakeHandle(this);
  }

  get closed(): boolean {
    return this.#closed;
  }

  emit(event: RuntimeEvent): void {
    this.#sink?.(event);
  }

  attach(sink: (event: RuntimeEvent) => void): RuntimeSubscription {
    this.#sink = sink;
    return { snapshot: this.#snapshot, detach: () => (this.#sink = undefined) };
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
    for (const event of this.#script.onSubmit?.(input) ?? []) this.emit(event);
    return record;
  }

  submission(key: { submissionId: string } | { requestId: string }): Submission | undefined {
    if ("submissionId" in key) {
      return [...this.#submissions.values()].find((record) => record.id === key.submissionId);
    }
    return this.#submissions.get(key.requestId);
  }

  history(input: { beforeEntryId?: string; limit: number }): RuntimeHistory {
    const messages: readonly Message[] = this.#snapshot.messages;
    const end = input.beforeEntryId
      ? Math.max(
          0,
          messages.findIndex((message) => message.id === input.beforeEntryId),
        )
      : messages.length;
    const start = Math.max(0, end - input.limit);
    return { messages: messages.slice(start, end), hasMore: start > 0 };
  }

  async close(trace: string, deadlineMs: number): Promise<"closed" | "timeout"> {
    this.closes.push({ trace, deadlineMs });
    this.#closed = true;
    return "closed";
  }

  bus(now = this.#clock()): number {
    return now;
  }
}

export class FakeHandle implements RuntimeHandle {
  readonly #runtime: FakeRuntime;

  constructor(runtime: FakeRuntime) {
    this.#runtime = runtime;
  }

  subscribe(trace: string, sink: (event: RuntimeEvent) => void): Promise<RuntimeSubscription> {
    void trace;
    return Promise.resolve(this.#runtime.attach(sink));
  }

  submit(input: SubmitInput): Promise<Submission> {
    return this.#runtime.submit(input);
  }

  submission(
    key: { submissionId: string } | { requestId: string },
  ): Promise<Submission | undefined> {
    return Promise.resolve(this.#runtime.submission(key));
  }

  history(input: { beforeEntryId?: string; limit: number }): Promise<RuntimeHistory> {
    return Promise.resolve(this.#runtime.history(input));
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
    return Promise.resolve({ run: false, tasks: false });
  }

  close(trace: string, deadlineMs: number): Promise<"closed" | "timeout"> {
    return this.#runtime.close(trace, deadlineMs);
  }
}
