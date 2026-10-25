// Bot lifecycle (docs/bots/ARCHITECTURE.md "Bot lifecycle"): the catalog, the one in-flight
// open per bot, idle close, quarantine with its retry, the startup recovery scan and
// delete. The registry owns state; the service owns routing; the adapter owns the Harness.
import { randomUUID } from "node:crypto";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type { BotConfig, BotDirectory } from "./BotDirectory.ts";
import {
  type BotState,
  type BotSummary,
  ClassifiedFailure,
  type ErrorKind,
  type Failure,
} from "./domain.ts";
import { newFailure } from "./failures.ts";
import type { RuntimeBotSpec, RuntimeHandle } from "./RuntimePort.ts";

const Events = {
  catalogLoadOk: declareEvent("core.catalog.load.ok"),
  catalogWriteOk: declareEvent("core.catalog.write.ok"),
  catalogWriteFail: declareEvent("core.catalog.write.fail"),
  resolveFail: declareEvent("core.bot.resolve.fail"),
  catalogLoadFail: declareEvent("core.catalog.load.fail"),
  openStart: declareEvent("core.bot.open.start"),
  openOk: declareEvent("core.bot.open.ok"),
  openFail: declareEvent("core.bot.open.fail"),
  closeOk: declareEvent("core.bot.close.ok"),
  closeFail: declareEvent("core.bot.close.fail"),
  closeDegrade: declareEvent("core.bot.close.degrade"),
  deleteStart: declareEvent("core.delete.start"),
  deleteOk: declareEvent("core.delete.ok"),
  deleteFail: declareEvent("core.delete.fail"),
  reconcileOk: declareEvent("core.reconcile.ok"),
  recoveryStart: declareEvent("core.recovery.start"),
  recoveryBotOk: declareEvent("core.recovery.bot.ok"),
  recoveryBotFail: declareEvent("core.recovery.bot.fail"),
  recoveryOk: declareEvent("core.recovery.ok"),
} as const;

type Entry = {
  config: BotConfig;
  /** The wire state; `closing` is internal and never leaves the registry. */
  state: BotState;
  closing: boolean;
  handle: RuntimeHandle | undefined;
  opening: Promise<RuntimeHandle> | undefined;
  subscribers: number;
  unavailable: { readonly reason: ErrorKind; readonly message: string } | undefined;
  cancelIdle: (() => void) | undefined;
  cancelRetry: (() => void) | undefined;
  /** Resolves when an in-flight close or delete settles; an open waits on it. */
  settling: Promise<void> | undefined;
};

export type RegistryOptions = {
  readonly directory: BotDirectory;
  readonly openRuntime: (spec: RuntimeBotSpec) => Promise<RuntimeHandle>;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly log: Log;
  readonly idleCloseMs: number;
  readonly quarantineRetryMs: number;
  readonly closeDeadlineMs: number;
  /** Timers, so idle close and the quarantine retry are testable without sleeping. */
  readonly setTimer?: (run: () => void, delayMs: number) => () => void;
  readonly now?: () => Date;
  readonly newBotId?: () => string;
  /** Trace for daemon-created work: idle closes, retries, the recovery scan. */
  readonly bootTrace?: () => string;
  /** Encoded size of one `BotSummary`: the catalog event has to fit the frame cap. */
  readonly measureSummary?: (summary: BotSummary) => number;
  /** PROTOCOL.md, "Limits": one `BotSummary` is at most 1 200 encoded bytes. */
  readonly maxSummaryBytes?: number;
};

export const MAX_SUMMARY_BYTES = 1_200;
/** PROTOCOL.md, "Limits": the catalog holds at most this many bots. */
export const MAX_CATALOG_BOTS = 200;

const jsonBytes = (summary: BotSummary): number =>
  Buffer.byteLength(JSON.stringify(summary), "utf8");

/** UUIDv7: the timestamp prefix keeps catalog and directory order stable. */
export const newBotId = (now: number = Date.now()): string => {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  const random = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((random[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((random[8] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index += 1) bytes[index] = random[index] ?? 0;
  const hex = bytes.toString("hex");
  return `b_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const unavailable = (reason: ErrorKind, message: string) => ({ reason, message });

export class BotRegistry {
  readonly #options: RegistryOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #boot: () => string;
  #sequence = 0;
  /** Creations in flight, so two concurrent creates cannot both take the last slot. */
  #creating = 0;

  constructor(options: RegistryOptions) {
    this.#options = options;
    this.#boot =
      options.bootTrace ??
      (() => {
        this.#sequence += 1;
        return `tr_boot_${this.#sequence}`;
      });
  }

  /** Loads the catalog, finishes an interrupted delete, then scans for active work. */
  async start(): Promise<void> {
    const trace = this.#boot();
    let bots: readonly BotConfig[];
    try {
      const reconciled = await this.#options.directory.reconcile();
      this.#options.log.emit("info", "core", Events.reconcileOk, {
        trace,
        detail: { count: reconciled.finishedDeletes.length },
      });
      bots = await this.#options.directory.load();
      this.#options.log.emit("info", "core", Events.catalogLoadOk, {
        trace,
        detail: { count: bots.length },
      });
    } catch (error) {
      const failure = newFailure("storage_failed");
      this.#options.log.emit("error", "core", Events.catalogLoadFail, {
        trace,
        failure,
        origin: true,
      });
      throw new ClassifiedFailure(failure, "runtime", "the catalog could not be loaded", {
        cause: error,
      });
    }
    for (const config of bots) {
      this.#entries.set(config.id, {
        config,
        state: "catalogued",
        closing: false,
        handle: undefined,
        opening: undefined,
        subscribers: 0,
        unavailable: undefined,
        cancelIdle: undefined,
        cancelRetry: undefined,
        settling: undefined,
      });
    }
    await this.#recover(trace);
  }

  /** One summary per catalogued bot, in catalog order. */
  summaries(): readonly BotSummary[] {
    return [...this.#entries.values()].map((entry) => this.#summary(entry));
  }

  state(botId: string): BotState | undefined {
    return this.#entries.get(botId)?.state;
  }

  /** True while a close, delete or shutdown owns this bot's lifecycle. */
  settling(botId: string): boolean {
    const entry = this.#entries.get(botId);
    return entry !== undefined && (entry.settling !== undefined || entry.closing);
  }

  /** The handle the registry currently owns; absent after an idle close or a delete. */
  handleOf(botId: string): RuntimeHandle | undefined {
    return this.#entries.get(botId)?.handle;
  }

  async create(title: string, trace: string): Promise<BotSummary> {
    if (this.#entries.size + this.#creating >= MAX_CATALOG_BOTS) {
      throw new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "catalog is full");
    }
    this.#creating += 1;
    try {
      return await this.#create(title, trace);
    } finally {
      this.#creating -= 1;
    }
  }

  async #create(title: string, trace: string): Promise<BotSummary> {
    if (this.#entries.size >= MAX_CATALOG_BOTS) {
      throw new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "catalog is full");
    }
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const config: BotConfig = {
      id: (this.#options.newBotId ?? (() => newBotId()))(),
      title,
      createdAt: at,
      updatedAt: at,
      model: this.#options.model,
    };
    // Checked before the write: a summary the `bots` event cannot carry must not exist.
    this.#assertSummary({ ...config, state: "catalogued" });
    await this.#write(trace, config.id, () => this.#options.directory.create(config));
    const entry: Entry = {
      config,
      state: "catalogued",
      closing: false,
      handle: undefined,
      opening: undefined,
      subscribers: 0,
      unavailable: undefined,
      cancelIdle: undefined,
      cancelRetry: undefined,
      settling: undefined,
    };
    this.#entries.set(config.id, entry);
    // Creation never waits for a Harness: reply first, warm afterwards.
    void this.open(config.id, trace).catch(() => undefined);
    return this.#summary(entry);
  }

  async rename(botId: string, title: string, trace: string): Promise<BotSummary> {
    const entry = this.#entry(botId, trace);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    this.#assertSummary({ ...entry.config, title, updatedAt: at, state: entry.state });
    const config = await this.#write(trace, botId, () =>
      this.#options.directory.rename(botId, title, at),
    );
    entry.config = config;
    void trace;
    return this.#summary(entry);
  }

  /** Closes the handle, then removes the directory in its two idempotent steps. */
  async remove(botId: string, trace: string): Promise<void> {
    const entry = this.#entry(botId, trace);
    if (entry.state === "quarantined") {
      throw new ClassifiedFailure(
        newFailure("internal"),
        "not_admitted",
        "the bot is quarantined; its close must finish first",
      );
    }
    this.#options.log.emit("info", "core", Events.deleteStart, { trace, botId });
    entry.closing = true;
    this.#cancelTimers(entry);
    let finish: () => void = () => undefined;
    // The whole delete is one settling window: an open that arrives while the directory
    // is being moved would create a handle for a bot the catalog no longer has.
    entry.settling = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await this.#delete(entry, botId, trace);
    } finally {
      entry.settling = undefined;
      finish();
    }
  }

  async #delete(entry: Entry, botId: string, trace: string): Promise<void> {
    // A warm-up open that is still in flight must settle first, or the handle it creates
    // would own an sqlite file the delete already moved to `trash/`.
    if (entry.opening !== undefined) await entry.opening.catch(() => undefined);
    if (entry.handle !== undefined) {
      const closing = entry.handle.close(trace, this.#options.closeDeadlineMs);
      entry.settling = closing.then(
        () => undefined,
        () => undefined,
      );
      const outcome = await closing;
      entry.settling = undefined;
      if (outcome === "timeout") {
        // A close that did not finish owns the handle: nothing may move or rewrite the
        // directory until the retry reports `closed` (ARCHITECTURE.md, quarantine).
        this.#quarantine(entry, trace);
        throw new ClassifiedFailure(
          newFailure("internal"),
          "not_admitted",
          "the bot's close timed out; it is quarantined",
        );
      }
    }
    try {
      await this.#options.directory.remove(botId);
    } catch (error) {
      const failure = newFailure("storage_failed");
      entry.closing = false;
      this.#options.log.emit("error", "core", Events.deleteFail, {
        trace,
        botId,
        failure,
        origin: true,
        detail: { reason: "upstream" },
      });
      throw new ClassifiedFailure(failure, "runtime", "the bot could not be deleted", {
        cause: error,
      });
    }
    this.#entries.delete(botId);
    this.#options.log.emit("info", "core", Events.deleteOk, { trace, botId, detail: { count: 1 } });
  }

  /**
   * The handle for this bot, opening it at most once. Two subscribers share one open, a
   * quarantined bot refuses, and a failed open leaves the bot `unavailable` with the
   * classification the caller must carry.
   */
  async open(botId: string, trace: string): Promise<RuntimeHandle> {
    const entry = this.#entry(botId, trace);
    // A close (idle, delete or shutdown) owns the handle until it settles. Opening during
    // that window would create a second Harness over one sqlite file, and the close would
    // then clear the handle it never owned (ARCHITECTURE.md, "Bot lifecycle").
    if (entry.settling !== undefined) {
      await entry.settling.catch(() => undefined);
      if (this.#entries.get(botId) !== entry) {
        throw this.#unresolved(botId, trace);
      }
    }
    if (entry.state === "quarantined") {
      throw new ClassifiedFailure(
        newFailure("unknown_bot"),
        "not_admitted",
        "the bot is quarantined",
      );
    }
    if (entry.handle !== undefined && !entry.closing) return entry.handle;
    // A warm-up open already in flight is the one an explicit open joins.
    entry.opening ??= this.#openOnce(entry, trace);
    return entry.opening;
  }

  /** `recover`: re-opens an unavailable bot, retries parked work otherwise. */
  async recover(botId: string, trace: string): Promise<void> {
    const entry = this.#entry(botId, trace);
    if (entry.state === "quarantined") {
      throw new ClassifiedFailure(
        newFailure("internal"),
        "not_admitted",
        "the bot is quarantined; its close must finish first",
      );
    }
    if (entry.handle === undefined) {
      await this.open(botId, trace);
      return;
    }
    await entry.handle.recover(trace);
  }

  /**
   * The runtime reported its session dead: the Harness closed itself, so the handle is
   * gone and the bot is unavailable until `recover` opens it again.
   */
  markUnavailable(
    botId: string,
    reason: ErrorKind,
    message: string,
    options: { readonly dropHandle?: boolean } = {},
  ): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return false;
    // A dead session takes the handle with it; an escalated watch leaves the harness
    // alive, so the handle stays owned and `recover` re-attaches it instead of opening a
    // second owner over the same sqlite file.
    if (options.dropHandle !== false) entry.handle = undefined;
    entry.state = "unavailable";
    entry.unavailable = unavailable(reason, message);
    entry.closing = false;
    return true;
  }

  /** `recover` brought the bot back: the catalog may say idle again. */
  markRecovered(botId: string): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined || entry.state !== "unavailable") return false;
    entry.state = "idle";
    entry.unavailable = undefined;
    return true;
  }

  /** The run state the service observed; returns true when the catalog changed. */
  markRunning(botId: string, running: boolean): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return false;
    // An unavailable bot is not made healthy by a status event: only `recover` clears it.
    if (entry.state !== "idle" && entry.state !== "running") return false;
    const next: BotState = running ? "running" : "idle";
    if (entry.state === next) return false;
    entry.state = next;
    return true;
  }

  /** A subscription started: the bot must stay open while it lasts. */
  touch(botId: string): void {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return;
    this.#touch(entry);
  }

  /** The last subscription ended: close after the idle window if the bot is quiet. */
  release(botId: string): void {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return;
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (entry.subscribers === 0) this.#scheduleIdle(entry);
  }

  async shutdown(): Promise<void> {
    const trace = this.#boot();
    // One shared deadline for the whole shutdown: a stalled handle must not multiply the
    // budget by the number of bots (ARCHITECTURE.md, "Bot lifecycle", rule 6).
    const deadline = Date.now() + this.#options.closeDeadlineMs;
    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        this.#cancelTimers(entry);
        if (entry.handle === undefined) return;
        const handle = entry.handle;
        entry.closing = true;
        const remaining = Math.max(1, deadline - Date.now());
        const closing = handle.close(trace, remaining).catch(() => "timeout" as const);
        entry.settling = closing.then(
          () => undefined,
          () => undefined,
        );
        const outcome = await closing;
        entry.settling = undefined;
        if (outcome === "timeout") {
          // The handle stays owned: quarantining without it would leave nothing to retry.
          entry.handle = handle;
          this.#quarantine(entry, trace);
          return;
        }
        entry.handle = undefined;
        entry.state = "catalogued";
        entry.closing = false;
      }),
    );
  }

  /** The id never resolved, so nothing below core is reached: this is the origin. */
  #unresolved(botId: string, trace: string): ClassifiedFailure {
    const failure = newFailure("unknown_bot", "core");
    this.#options.log.emit("error", "core", Events.resolveFail, {
      trace,
      botId,
      failure,
      origin: true,
    });
    return new ClassifiedFailure(failure, "not_admitted", "unknown bot");
  }

  #entry(botId: string, trace: string): Entry {
    const entry = this.#entries.get(botId);
    if (entry === undefined) throw this.#unresolved(botId, trace);
    return entry;
  }

  async #openOnce(entry: Entry, trace: string): Promise<RuntimeHandle> {
    const started = performance.now();
    entry.state = "opening";
    this.#options.log.emit("info", "core", Events.openStart, { trace, botId: entry.config.id });
    try {
      const handle = await this.#options.openRuntime({
        id: entry.config.id,
        dir: this.#options.directory.botDir(entry.config.id),
        model: entry.config.model,
        trace,
      });
      entry.handle = handle;
      entry.state = "idle";
      entry.unavailable = undefined;
      this.#options.log.emit("info", "core", Events.openOk, {
        trace,
        botId: entry.config.id,
        durMs: Math.round(performance.now() - started),
      });
      if (entry.subscribers === 0) this.#scheduleIdle(entry);
      return handle;
    } catch (error) {
      const failure: Failure =
        error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
      entry.state = "unavailable";
      entry.unavailable = unavailable(failure.kind, "the bot could not be opened");
      const own = failure.layer === "core";
      this.#options.log.emit(own ? "error" : "warn", "core", Events.openFail, {
        trace,
        botId: entry.config.id,
        failure,
        ...(own ? { origin: true as const } : { propagated: true }),
        durMs: Math.round(performance.now() - started),
      });
      throw error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(failure, "runtime", "the bot could not be opened", {
            cause: error,
          });
    } finally {
      entry.opening = undefined;
    }
  }

  #touch(entry: Entry): void {
    entry.subscribers += 1;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
  }

  #scheduleIdle(entry: Entry): void {
    entry.cancelIdle?.();
    const setTimer = this.#options.setTimer ?? defaultTimer;
    entry.cancelIdle = setTimer(() => {
      entry.cancelIdle = undefined;
      void this.#idleClose(entry);
    }, this.#options.idleCloseMs);
  }

  async #idleClose(entry: Entry): Promise<void> {
    if (entry.subscribers > 0 || entry.handle === undefined) return;
    if (entry.state === "quarantined" || entry.closing) return;
    const trace = this.#boot();
    const busy = await entry.handle.busy().catch(() => ({ run: false, tasks: false }));
    // A subscription or a delete can arrive while `busy()` was in flight.
    if (entry.subscribers > 0 || entry.closing || entry.handle === undefined) return;
    if (busy.run || busy.tasks) {
      // A background task keeps the bot warm; the close condition reads the port.
      this.#scheduleIdle(entry);
      return;
    }
    const handle = entry.handle;
    entry.closing = true;
    const closing = handle.close(trace, this.#options.closeDeadlineMs);
    entry.settling = closing.then(
      () => undefined,
      () => undefined,
    );
    const outcome = await closing.catch(() => {
      this.#options.log.emit("error", "core", Events.closeFail, {
        trace,
        botId: entry.config.id,
        failure: newFailure("internal", "core"),
        origin: true,
      });
      return "timeout" as const;
    });
    entry.settling = undefined;
    if (outcome === "timeout") {
      this.#quarantine(entry, trace);
      return;
    }
    entry.handle = undefined;
    entry.state = "catalogued";
    entry.closing = false;
    this.#options.log.emit("info", "core", Events.closeOk, {
      trace,
      botId: entry.config.id,
      detail: { quarantined: false },
    });
  }

  /** A close that timed out: the handle stays owned and `open`/`delete` are refused. */
  #quarantine(entry: Entry, trace: string): void {
    entry.state = "quarantined";
    this.#options.log.emit("warn", "core", Events.closeDegrade, {
      trace,
      botId: entry.config.id,
      failure: newFailure("internal"),
      detail: { reason: "quarantine", quarantined: true },
    });
    const setTimer = this.#options.setTimer ?? defaultTimer;
    const retry = () => {
      void entry.handle
        ?.close(trace, this.#options.closeDeadlineMs)
        .then((outcome) => {
          if (outcome === "closed") {
            entry.handle = undefined;
            entry.state = "catalogued";
            entry.closing = false;
            entry.cancelRetry?.();
            entry.cancelRetry = undefined;
            this.#options.log.emit("info", "core", Events.closeOk, {
              trace,
              botId: entry.config.id,
              detail: { quarantined: true },
            });
            return;
          }
          entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
        })
        .catch(() => {
          entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
        });
    };
    entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
  }

  async #recover(trace: string): Promise<void> {
    this.#options.log.emit("info", "core", Events.recoveryStart, { trace });
    let resumed = 0;
    for (const entry of this.#entries.values()) {
      let failure: Failure | undefined;
      const busy = await this.open(entry.config.id, trace)
        .then((handle) => handle.busy())
        .catch((error: unknown) => {
          // The identity the open minted travels with the report: one episode, one id.
          failure =
            error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
          return undefined;
        });
      if (busy === undefined) {
        this.#options.log.emit("warn", "core", Events.recoveryBotFail, {
          trace,
          botId: entry.config.id,
          failure: failure ?? newFailure("storage_failed"),
          detail: { reason: "upstream", propagated: true },
        });
        continue;
      }
      this.#options.log.emit("info", "core", Events.recoveryBotOk, {
        trace,
        botId: entry.config.id,
        detail: { finished: busy.run ? "running" : "idle" },
      });
      if (busy.run || busy.tasks) {
        // The catalog has to say what the scan found: a resumed run is not an idle bot.
        this.markRunning(entry.config.id, true);
        resumed += 1;
        continue;
      }
      // Quiet: keep it open briefly in case a client attaches, then let idle close take it.
      if (entry.subscribers === 0) this.#scheduleIdle(entry);
    }
    this.#options.log.emit("info", "core", Events.recoveryOk, {
      trace,
      detail: { count: resumed },
    });
  }

  #cancelTimers(entry: Entry): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.cancelRetry?.();
    entry.cancelRetry = undefined;
  }

  /** One catalog mutation, one outcome record, at the layer that owns the file. */
  async #write<T>(trace: string, botId: string, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.#options.log.emit("info", "core", Events.catalogWriteOk, {
        trace,
        botId,
        detail: { count: 1 },
      });
      return result;
    } catch (error) {
      const classified = error instanceof ClassifiedFailure ? error : undefined;
      const failure = classified?.failure ?? newFailure("storage_failed", "core");
      this.#options.log.emit("error", "core", Events.catalogWriteFail, {
        trace,
        botId,
        failure,
        origin: true,
      });
      throw error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(failure, "runtime", "the catalog could not be written", {
            cause: error,
          });
    }
  }

  /** Refuses a summary the derived 240 200-byte catalog bound cannot hold. */
  #assertSummary(summary: BotSummary): void {
    const measure = this.#options.measureSummary ?? jsonBytes;
    // The failure that makes a bot unavailable adds a reason and a message to the same
    // summary, so the budget has to hold that variant too: otherwise a failure turns a
    // legal bot into a catalog event the frame budget refuses.
    const worstCase: BotSummary = {
      ...summary,
      unavailable: { reason: "storage_failed", message: "x".repeat(200) },
    };
    if (measure(worstCase) > (this.#options.maxSummaryBytes ?? MAX_SUMMARY_BYTES)) {
      throw new ClassifiedFailure(
        newFailure("limit_exceeded"),
        "not_admitted",
        "the title does not fit the catalog budget",
      );
    }
  }

  #summary(entry: Entry): BotSummary {
    return {
      id: entry.config.id,
      title: entry.config.title,
      createdAt: entry.config.createdAt,
      updatedAt: entry.config.updatedAt,
      model: entry.config.model,
      state: entry.state,
      ...(entry.unavailable === undefined ? {} : { unavailable: entry.unavailable }),
    };
  }
}

const defaultTimer = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};
