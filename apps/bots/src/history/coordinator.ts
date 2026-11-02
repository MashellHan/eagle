import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BotDirectory } from "../core/BotDirectory.ts";
import type { BotRegistry } from "../core/BotRegistry.ts";
import type { RuntimeHandle } from "../core/RuntimePort.ts";
import { historyPageRequest, validateHistoryPage } from "../runtime/pi/historyIncremental.ts";
import { DeviceChannel } from "../tools/devices/socket.ts";

// This product owns its private IPC codec; it does not import Device Service packages.
const bot = z.string().regex(/^b_[A-Za-z0-9_-]{6,}$/);
const request = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("catalog"), known: z.array(bot).max(200) }),
  z.strictObject({
    method: z.literal("branches"),
    botId: bot,
    after: z.string().max(128).optional(),
  }),
  z.strictObject({ method: z.literal("page"), botId: bot, input: historyPageRequest }),
]);
const packet = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("changed"),
    botIds: z.array(bot).max(32),
    catalog: z.boolean(),
    branches: z
      .array(z.strictObject({ botId: bot, selection: z.string().min(1).max(128) }))
      .max(32)
      .optional(),
  }),
  z.strictObject({ type: z.literal("pull"), id: z.uuid(), request }),
  z.strictObject({
    type: z.literal("reply"),
    id: z.uuid(),
    result: z.unknown(),
    failed: z.boolean(),
  }),
]);
const event = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("history.ready"), enabled: z.boolean(), ready: z.boolean() }),
  z.strictObject({ type: z.literal("history.changed"), sourceDeviceId: z.uuid() }),
  z.strictObject({
    type: z.literal("history.packet"),
    sourceDeviceId: z.uuid(),
    payload: z.unknown(),
  }),
]);
const branches = z.strictObject({
  branches: z
    .array(
      z.strictObject({
        branchId: z.string().max(128),
        conversationId: z.string().max(128),
        selection: z.string().max(128),
      }),
    )
    .max(32),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
type Drain = { botId: string; page: ReturnType<typeof validateHistoryPage> };
type Backfill = { peer: string; botId: string; selection: string; before: string; until: string };

/** Optional, rebuildable scheduling only. Every imported record and usable head stays native. */
export class HistoryCoordinator {
  readonly #registry: BotRegistry;
  readonly #path: string;
  readonly #changed: (botId?: string) => void;
  readonly #detachers: (() => void)[];
  readonly #handles = new Map<string, { handle: RuntimeHandle; detach: () => void }>();
  readonly #pending = new Map<
    string,
    { peer: string; resolve(value: unknown): void; reject(): void }
  >();
  readonly #fresh = new Set<string>();
  readonly #scans = new Map<string, AsyncGenerator<void>>();
  readonly #scanAgain = new Set<string>();
  readonly #hot = new Map<
    string,
    {
      peer: string;
      botId: string | undefined;
      selection: string | undefined;
      scan: AsyncGenerator<void>;
      again: boolean;
      started: boolean;
    }
  >();
  readonly #heads = new Map<string, string>();
  readonly #peers = new Set<string>();
  readonly #precisePeers = new Set<string>();
  readonly #dirtyBots = new Set<string>();
  #catalogDirty = false;
  #notifying = false;
  readonly #backfill = new Map<string, Backfill>();
  readonly #gaps = new Map<string, Backfill>();
  readonly #tails = new Map<string, string>();
  readonly #drains = new Map<string, Drain>();
  readonly #unavailableBots = new Set<string>();
  readonly #unavailableReads = new Set<string>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #retryPeers = new Set<string>();
  #channel: DeviceChannel | undefined;
  #closed = false;
  #ready = false;
  #working = false;
  #serving = 0;
  #reconnect?: NodeJS.Timeout;
  #retry: NodeJS.Timeout | undefined;
  #botRetry: NodeJS.Timeout | undefined;
  #notice: NodeJS.Timeout | undefined;

  constructor(
    path: string,
    registry: BotRegistry,
    directory: BotDirectory,
    changed: (botId?: string) => void,
  ) {
    this.#path = path;
    this.#registry = registry;
    this.#changed = changed;
    this.#detachers = [
      directory.observeChanges(() => this.#announce()),
      registry.observeHandles(() => this.#observeHandles()),
    ];
    setImmediate(() => {
      void this.#connect();
    });
  }

  #observeHandles() {
    if (this.#closed) return;
    for (const summary of this.#registry.summaries()) {
      const handle = this.#registry.handleOf(summary.id);
      if (this.#handles.get(summary.id)?.handle === handle) continue;
      this.#handles.get(summary.id)?.detach();
      this.#handles.delete(summary.id);
      if (handle) {
        this.#handles.set(summary.id, {
          handle,
          detach: handle.observeHistoryChanges?.(() => this.#announce(summary.id)) ?? (() => {}),
        });
      }
    }
  }

  async #connect() {
    if (this.#closed) return;
    const channel = new DeviceChannel(this.#path, 5000, {
      event: (value) => this.#event(value),
      closed: () => this.#disconnected(channel),
    });
    this.#channel = channel;
    try {
      const status = z
        .strictObject({ enabled: z.boolean(), ready: z.boolean() })
        .parse(await channel.call("history.attach"));
      if (channel === this.#channel) await this.#available(status.ready);
    } catch {
      channel.close();
    }
  }

  #disconnected(channel: DeviceChannel) {
    if (this.#channel !== channel) return;
    this.#channel = undefined;
    this.#ready = false;
    this.#precisePeers.clear();
    clearTimeout(this.#retry);
    this.#retry = undefined;
    for (const pending of this.#pending.values()) pending.reject();
    this.#pending.clear();
    if (!this.#closed) {
      this.#reconnect = setTimeout(() => {
        void this.#connect();
      }, 1000);
      this.#reconnect.unref();
    }
  }

  async #available(ready: boolean) {
    this.#ready = ready;
    if (!ready) return;
    const peers = z
      .array(z.object({ deviceId: z.uuid() }))
      .max(32)
      .parse(await this.#channel?.call("history.peers"));
    this.#peers.clear();
    for (const peer of peers) {
      this.#peers.add(peer.deviceId);
      this.#queueFresh(peer.deviceId);
    }
    void this.#channel?.call("history.changed").catch(() => {});
    this.#announce();
    void this.#work();
  }

  #event(input: unknown) {
    const value = event.parse(input);
    if (value.type === "history.ready") {
      void this.#available(value.ready).catch(() => this.#channel?.close());
    } else if (value.type === "history.changed") {
      this.#peers.add(value.sourceDeviceId);
      this.#queueFresh(value.sourceDeviceId);
      void this.#work();
    } else {
      const parsed = packet.safeParse(value.payload);
      if (!parsed.success) return;
      if (parsed.data.type === "changed") {
        this.#peers.add(value.sourceDeviceId);
        const hint = parsed.data;
        if (hint.branches) this.#precisePeers.add(value.sourceDeviceId);
        else this.#precisePeers.delete(value.sourceDeviceId);
        for (const botId of hint.botIds)
          this.#queueHot(
            value.sourceDeviceId,
            botId,
            hint.branches?.find((branch) => branch.botId === botId)?.selection,
          );
        if (parsed.data.catalog) this.#queueHot(value.sourceDeviceId);
        void this.#work();
      } else if (parsed.data.type === "reply") {
        const pending = this.#pending.get(parsed.data.id);
        if (pending?.peer !== value.sourceDeviceId) return;
        this.#pending.delete(parsed.data.id);
        if (parsed.data.failed) pending.reject();
        else pending.resolve(parsed.data.result);
      } else if (this.#serving < 2 && this.#ready) {
        this.#serving++;
        void this.#serve(value.sourceDeviceId, parsed.data).finally(() => {
          this.#serving--;
        });
      }
    }
  }

  #queueFresh(peer: string) {
    if (this.#scans.has(peer)) this.#scanAgain.add(peer);
    this.#fresh.add(peer);
  }

  #queueHot(peer: string, botId?: string, selection?: string) {
    const key = `${peer}/${botId ?? "catalog"}${selection ? `/${selection}` : ""}`;
    const work = this.#hot.get(key);
    if (work) work.again = true;
    else
      this.#hot.set(key, {
        peer,
        botId,
        selection,
        scan:
          botId === undefined
            ? this.#catchUpCatalog(peer)
            : this.#catchUpBot(peer, botId, selection),
        again: false,
        started: false,
      });
  }

  #announce(botId?: string) {
    if (botId) this.#dirtyBots.add(botId);
    else this.#catalogDirty = true;
    this.#scheduleNotice();
  }

  #scheduleNotice(delay = 40) {
    if (
      !this.#ready ||
      this.#notice ||
      this.#notifying ||
      this.#closed ||
      !this.#peers.size ||
      (!this.#dirtyBots.size && !this.#catalogDirty)
    )
      return;
    this.#notice = setTimeout(() => {
      this.#notice = undefined;
      void this.#sendNotice();
    }, delay);
    this.#notice.unref();
  }

  async #sendNotice() {
    this.#notifying = true;
    const botIds = [...this.#dirtyBots].slice(0, 32);
    for (const id of botIds) this.#dirtyBots.delete(id);
    const catalog = this.#catalogDirty;
    this.#catalogDirty = false;
    const branches: { botId: string; selection: string }[] = [];
    for (const botId of botIds) {
      try {
        const selection = await this.#withBot(botId, async (handle) =>
          handle.currentHistoryBranch?.(),
        );
        if (selection) branches.push({ botId, selection });
      } catch {
        /* The Bot hint still schedules its ordinary branch directory. */
      }
    }
    let failed = false;
    let coarse = false;
    for (const peer of this.#peers) {
      if (this.#closed || !this.#ready) {
        failed = true;
        break;
      }
      try {
        await this.#send(peer, { type: "changed", botIds, catalog, branches });
        coarse ||= !this.#precisePeers.has(peer);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      for (const id of botIds) this.#dirtyBots.add(id);
      this.#catalogDirty ||= catalog;
    }
    this.#notifying = false;
    if (!failed && coarse) void this.#channel?.call("history.changed").catch(() => {});
    this.#scheduleNotice(failed ? 1000 : 40);
  }

  async #withBot<T>(botId: string, run: (handle: RuntimeHandle) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("history_closed");
    const operation = (async () => {
      if (!this.#registry.touch(botId)) throw new Error("history_bot_unavailable");
      try {
        const handle = await this.#registry.open(botId, "tr_history_pull");
        if (this.#closed) throw new Error("history_closed");
        return await run(handle);
      } finally {
        this.#registry.release(botId);
      }
    })();
    this.#operations.add(operation);
    try {
      return await operation;
    } finally {
      this.#operations.delete(operation);
    }
  }

  async #serve(peer: string, pull: Extract<z.infer<typeof packet>, { type: "pull" }>) {
    let result: unknown = null;
    let failed = false;
    // The Device Service encrypts the whole reply. Reserve its actual JSON wrapper,
    // so a legitimate large tool result can use the native 128 KiB page boundary.
    const reply = { type: "reply", id: pull.id, failed, result: null };
    const maxBytes = 128 * 1024 - (Buffer.byteLength(JSON.stringify(reply)) - 4);
    try {
      const query = pull.request;
      if (query.method === "catalog") result = this.#registry.exportHistoryCatalog(query.known);
      else
        result = await this.#withBot(query.botId, async (handle) => {
          if (query.method === "branches")
            return handle.listHistoryBranches?.(query.after ? { after: query.after } : {});
          return handle.exportHistoryPage?.({
            ...(query.input.selection === undefined ? {} : { selection: query.input.selection }),
            ...(query.input.after === undefined ? {} : { after: query.input.after }),
            ...(query.input.before === undefined ? {} : { before: query.input.before }),
            ...(query.input.until === undefined ? {} : { until: query.input.until }),
            limit: 32,
            maxBytes,
          });
        });
    } catch {
      failed = true;
    }
    const payload = { type: "reply", id: pull.id, failed, result: result ?? null };
    try {
      await this.#send(peer, payload);
    } catch {
      /* Other errors or sustained backpressure keep the original pull timeout. */
    }
  }

  async #send(peer: string, payload: unknown) {
    const channel = this.#channel;
    // Keep brief capacity pressure inside the existing peer pull budget.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (this.#closed || !this.#ready || !channel || channel !== this.#channel)
        throw new Error("history_pull_unavailable");
      try {
        return await channel.call("history.send", { targetDeviceId: peer, payload });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "history_busy" || Date.now() >= deadline)
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("history_busy");
  }

  async #pull(peer: string, query: z.infer<typeof request>): Promise<unknown> {
    if (this.#closed || !this.#ready || !this.#channel) throw new Error("history_pull_unavailable");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("history_pull_timeout"));
      }, 5000);
      this.#pending.set(id, {
        peer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: () => {
          clearTimeout(timer);
          reject(new Error("history_pull_unavailable"));
        },
      });
      void this.#channel
        ?.call("history.send", {
          targetDeviceId: peer,
          payload: { type: "pull", id, request: query },
        })
        .catch(() => {
          this.#pending.get(id)?.reject();
          this.#pending.delete(id);
        });
    });
  }

  async #receive(botId: string, input: unknown) {
    const page = validateHistoryPage(input);
    if (page.botId !== botId) throw new Error("history_bot_conflict");
    const receipt = await this.#withBot(botId, async (handle) => handle.importHistoryPage?.(page));
    if (page.records.length) this.#changed(botId);
    if (receipt?.pending) this.#drains.set(`${botId}/${page.head}`, { botId, page });
    return page;
  }

  #retryBot(botId: string, peer?: string) {
    if (this.#closed) return;
    if (peer) {
      this.#unavailableReads.add(`${peer}/${botId}`);
      this.#retryPeers.add(peer);
    } else this.#unavailableBots.add(botId);
    if (this.#botRetry) return;
    this.#botRetry = setTimeout(() => {
      this.#botRetry = undefined;
      this.#unavailableBots.clear();
      this.#unavailableReads.clear();
      for (const peer of this.#retryPeers) this.#queueFresh(peer);
      this.#retryPeers.clear();
      void this.#work();
    }, 1000);
    this.#botRetry.unref();
  }

  async *#catchUpCatalog(peer: string) {
    for (;;) {
      const catalog = await this.#pull(peer, {
        method: "catalog",
        known: this.#registry.summaries().map((bot) => bot.id),
      });
      const before = new Set(this.#registry.summaries().map((bot) => bot.id));
      await this.#registry.importHistoryCatalog(catalog, "tr_history_catalog");
      for (const bot of this.#registry.summaries()) {
        if (!before.has(bot.id)) this.#queueHot(peer, bot.id);
      }
      if (this.#registry.summaries().length !== before.size) this.#changed();
      yield;
      if (!(catalog as { hasMore: boolean }).hasMore) break;
    }
  }

  async *#catchUp(peer: string) {
    yield* this.#catchUpCatalog(peer);
    for (const bot of this.#registry.summaries()) yield* this.#catchUpBot(peer, bot.id);
  }

  async *#catchUpBot(peer: string, botId: string, selection?: string) {
    if (this.#closed || !this.#ready) return;
    if (this.#unavailableBots.has(botId) || this.#unavailableReads.has(`${peer}/${botId}`)) return;
    try {
      if (!this.#registry.summaries().some((bot) => bot.id === botId))
        yield* this.#catchUpCatalog(peer);
      let after: string | undefined;
      do {
        const list = selection
          ? { branches: [{ branchId: selection, selection }], cursor: null, hasMore: false }
          : branches.parse(
              await this.#pull(peer, {
                method: "branches",
                botId: botId,
                ...(after ? { after } : {}),
              }),
            );
        if (!selection) yield;
        for (const branch of list.branches) {
          const key = `${peer}/${botId}/${branch.branchId}`;
          const gap = this.#gaps.get(key);
          if (gap && !this.#backfill.has(key)) this.#backfill.set(key, gap);
          if (/^[a-f0-9]{64}$/.test(branch.selection) && this.#heads.get(key) === branch.selection)
            continue;
          for (let budget = 0; budget < 4; budget++) {
            const tail = this.#tails.get(key);
            const page = await this.#receive(
              botId,
              await this.#pull(peer, {
                method: "page",
                botId: botId,
                input: { selection: branch.selection, ...(tail ? { after: tail } : {}) },
              }),
            );
            const progress = tail ? page.cursor : page.snapshot;
            if (progress) this.#tails.set(key, progress);
            if (!tail && page.records[0]?.previous && page.cursor && page.snapshot) {
              const backfill = {
                peer,
                botId: botId,
                selection: branch.selection,
                before: page.cursor,
                until: page.snapshot,
              };
              this.#gaps.set(key, backfill);
              if (page.hasMore) this.#backfill.set(key, backfill);
            }
            const complete = !tail || !page.hasMore || !page.cursor;
            if (complete) this.#heads.set(key, branch.selection);
            else if (budget === 3) this.#queueHot(peer, botId, selection);
            if (selection && budget === 0) this.#queueHot(peer, botId);
            yield;
            if (complete) break;
          }
        }
        after = list.hasMore ? (list.cursor ?? undefined) : undefined;
      } while (after);
    } catch {
      this.#retryBot(botId, peer);
    }
  }

  async #work() {
    if (this.#working || this.#retry || !this.#ready || this.#closed) return;
    this.#working = true;
    let activePeer: string | undefined;
    let freshTurn = true;
    try {
      while (
        this.#ready &&
        !this.#closed &&
        (this.#hot.size || this.#fresh.size || this.#backfill.size || this.#drains.size)
      ) {
        const peer = this.#fresh.values().next().value;
        const hot =
          [...this.#hot.entries()].find(([, work]) => !work.started) ??
          this.#hot.entries().next().value;
        const drainWork = [...this.#drains.entries()].find(
          ([, drain]) => !this.#unavailableBots.has(drain.botId),
        );
        const backfillWork = [...this.#backfill.entries()].find(
          ([, backfill]) =>
            !this.#unavailableBots.has(backfill.botId) &&
            !this.#unavailableReads.has(`${backfill.peer}/${backfill.botId}`),
        );
        activePeer = undefined;
        if (hot && (!hot[1].started || freshTurn || (!backfillWork && !drainWork))) {
          const [key, work] = hot;
          activePeer = work.peer;
          work.started = true;
          freshTurn = false;
          const done = (await work.scan.next()).done;
          this.#hot.delete(key);
          if (done) {
            if (work.again) this.#queueHot(work.peer, work.botId, work.selection);
          } else this.#hot.set(key, work);
        } else if (peer && (freshTurn || (!backfillWork && !drainWork))) {
          activePeer = peer;
          freshTurn = false;
          const scan = this.#scans.get(peer) ?? this.#catchUp(peer);
          this.#scans.set(peer, scan);
          if ((await scan.next()).done) {
            this.#scans.delete(peer);
            this.#fresh.delete(peer);
            if (this.#scanAgain.delete(peer)) this.#fresh.add(peer);
          } else {
            this.#fresh.delete(peer);
            this.#fresh.add(peer);
          }
        } else if (drainWork) {
          freshTurn = true;
          const [key, drain] = drainWork;
          try {
            const receipt = await this.#withBot(
              drain.botId,
              (handle) =>
                handle.importHistoryPage?.({ ...drain.page, records: [] }) ??
                Promise.resolve(undefined),
            );
            if (!receipt?.pending) {
              this.#drains.delete(key);
              this.#changed(drain.botId);
            }
          } catch {
            this.#retryBot(drain.botId);
          }
        } else if (backfillWork) {
          freshTurn = true;
          const [key, backfill] = backfillWork;
          try {
            const page = await this.#receive(
              backfill.botId,
              await this.#pull(backfill.peer, {
                method: "page",
                botId: backfill.botId,
                input: {
                  selection: backfill.selection,
                  before: backfill.before,
                  until: backfill.until,
                },
              }),
            );
            if (page.records.length && page.records[0]?.previous && page.cursor) {
              const next = { ...backfill, before: page.cursor };
              this.#gaps.set(key, next);
              if (page.hasMore) this.#backfill.set(key, next);
              else this.#backfill.delete(key);
            } else {
              this.#backfill.delete(key);
              if (page.records.length) this.#gaps.delete(key);
            }
          } catch {
            this.#retryBot(backfill.botId, backfill.peer);
          }
        } else break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      if (activePeer) {
        this.#scans.delete(activePeer);
        this.#fresh.add(activePeer);
      }
      if (
        error instanceof Error &&
        ["history_pull_timeout", "history_pull_unavailable"].includes(error.message)
      ) {
        // A failed read must not tear down the attachment serving the other peer's pulls.
        this.#retry = setTimeout(() => {
          this.#retry = undefined;
          void this.#work();
        }, 1000);
        this.#retry.unref();
      } else this.#channel?.close();
    } finally {
      this.#working = false;
    }
  }

  async close() {
    this.#closed = true;
    this.#ready = false;
    clearTimeout(this.#reconnect);
    clearTimeout(this.#retry);
    clearTimeout(this.#botRetry);
    clearTimeout(this.#notice);
    for (const detach of this.#detachers) detach();
    for (const observer of this.#handles.values()) observer.detach();
    this.#handles.clear();
    this.#channel?.close();
    // Let late opens release their leases before the daemon shuts native handles down.
    await Promise.allSettled([...this.#operations]);
  }
}
