// Failure classification (docs/bots/RUNTIME.md, "Failure channels"). pi reports trouble
// through four channels that can describe the same underlying failure, so only this
// module mints a failure identity, once per episode key, and the channels merely carry
// the classification.

import type { ReportInfo, SessionEnd, WatchEnd } from "@earendil-works/pi-durable";
import type { ErrorKind } from "../../core/domain.ts";

/** A failure the adapter mints: its layer is always one of the two adapter layers. */
export type AdapterFailure = {
  readonly id: string;
  readonly kind: ErrorKind;
  readonly layer: "runtime" | "pi";
};

/** A failure as the adapter reports it: the identity, its kind, and a content-free text. */
export type Classification = {
  readonly failure: AdapterFailure;
  readonly message: string;
  readonly reason?: string;
};

/** A classification, and whether this notification is the one that minted it. */
export type Minted = {
  readonly classification: Classification;
  readonly minted: boolean;
};

/** Fixed texts: a report's own message can echo model output, so it never travels. */
const MESSAGE: Readonly<Record<ErrorKind, string>> = {
  auth_failed: "the model endpoint refused the credentials",
  unknown_bot: "the bot is unknown",
  invalid_command: "the command was refused",
  limit_exceeded: "the bot is at its queue limit",
  version_mismatch: "the protocol version is not served",
  model_error: "the model request failed",
  session_failed: "the session failed",
  task_faulted: "a task failed",
  task_parked: "a task was parked after repeated interruptions",
  extension_error: "an extension failed",
  storage_failed: "the session storage failed",
  internal: "an internal failure",
};

const LISTENER_WINDOW_MS = 60_000;
/** The first two listener errors of a window are recoverable; every third mints one. */
const LISTENER_ESCALATE_AT = 3;

export type ClassifierOptions = {
  readonly now?: () => number;
};

export class FailureClassifier {
  readonly #now: () => number;
  readonly #episodes = new Map<string, Classification>();
  #next = 0;
  #generation = 1;
  #listenerErrors: number[] = [];

  constructor(options: ClassifierOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** The harness episode: a reopen starts a new one, so a later failure is a new identity. */
  get generation(): number {
    return this.#generation;
  }

  nextGeneration(): number {
    this.#generation += 1;
    this.#listenerErrors = [];
    return this.#generation;
  }

  /** Mints once per episode key; a repeated notification gets the existing identity. */
  classify(key: string, kind: ErrorKind, layer: "runtime" | "pi"): Minted {
    const known = this.#episodes.get(key);
    if (known !== undefined) return { classification: known, minted: false };
    this.#next += 1;
    const classification: Classification = {
      failure: { id: `f_${this.#next}`, kind, layer },
      message: MESSAGE[kind],
      reason: kind,
    };
    this.#episodes.set(key, classification);
    return { classification, minted: true };
  }

  /** A task that faulted while running, deduped against the same task's report. */
  taskFailed(event: { readonly taskId: string; readonly kind: string }): Minted {
    return this.classify(`task:${event.taskId}`, "task_faulted", "pi");
  }

  /** `HarnessOptions.onReport`; the channel never mints on its own. */
  report(info: ReportInfo): Minted | undefined {
    switch (info.type) {
      case "task_parked":
        return this.classify(`task:${info.task.id}`, "task_parked", "pi");
      case "task_faulted":
        return this.classify(`task:${info.task.id}`, "task_faulted", "pi");
      case "task_error":
        return this.classify(`task:${info.task.id}`, "task_faulted", "pi");
      case "migration_failed":
      case "task_outdated":
        return this.classify(`task:${info.task.id}`, "internal", "pi");
      case "extension_error":
        return this.classify(
          info.task === undefined
            ? `extension:${info.extension ?? "unknown"}`
            : `task:${info.task.id}`,
          "extension_error",
          "pi",
        );
      case "host_error":
        return this.classify(`host:${info.callback}`, "internal", "pi");
      case "session_failed":
        return this.#sessionFailed();
      case "listener_error":
        return this.#listenerError();
    }
  }

  /** A watch that ended. Only `listener_error` and `session_failed` are faults. */
  watchEnd(end: WatchEnd): Minted | undefined {
    if (end.reason === "listener_error") return this.#listenerError();
    if (end.reason === "session_failed") return this.#sessionFailed();
    return undefined;
  }

  /** `harness.closed`: a close we asked for is not a failure, a failed session is. */
  sessionEnd(end: SessionEnd): Minted | undefined {
    return end.reason === "failed" ? this.#sessionFailed() : undefined;
  }

  /** A submit the daemon refused before admission: the client keeps its text. */
  refusedBusy(): Minted {
    return this.classify("submit:busy", "limit_exceeded", "runtime");
  }

  /** Storage or session trouble inside one submit. */
  submitFailed(cause: unknown): Minted {
    // A failed session is one episode: the same identity the session's other channels
    // report, so the daemon never shows two failures for one storage error.
    if (isSessionFailure(cause))
      return this.classify(`harness:${this.#generation}`, "storage_failed", "pi");
    return this.classify(`submit:${this.#generation}`, "internal", "runtime");
  }

  #sessionFailed(): Minted {
    return this.classify(`harness:${this.#generation}`, "storage_failed", "pi");
  }

  #listenerError(): Minted | undefined {
    const now = this.#now();
    this.#listenerErrors = this.#listenerErrors.filter((at) => now - at < LISTENER_WINDOW_MS);
    this.#listenerErrors.push(now);
    const count = this.#listenerErrors.length;
    if (count < LISTENER_ESCALATE_AT || count % LISTENER_ESCALATE_AT !== 0) return undefined;
    return this.classify(`listener:${count}`, "internal", "pi");
  }
}

const isSessionFailure = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "SessionFailed";
