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
  readonly #backfill = new Map<string, Backfill>();
  readonly #tails = new Map<string, string>();
  readonly #drains = new Map<string, Drain>();
  #channel: DeviceChannel | undefined;
  #closed = false;
  #ready = false;
  #working = false;
  #serving = 0;
  #reconnect?: NodeJS.Timeout;
  #retry: NodeJS.Timeout | undefined;
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
    for (const summary of this.#registry.summaries()) {
      const handle = this.#registry.handleOf(summary.id);
      if (this.#handles.get(summary.id)?.handle === handle) continue;
      this.#handles.get(summary.id)?.detach();
      this.#handles.delete(summary.id);
      if (handle) {
        this.#handles.set(summary.id, {
          handle,
          detach: handle.observeHistoryChanges?.(() => this.#announce()) ?? (() => {}),
        });
        this.#announce();
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
    for (const peer of peers) this.#fresh.add(peer.deviceId);
    this.#announce();
    void this.#work();
  }

  #event(input: unknown) {
    const value = event.parse(input);
    if (value.type === "history.ready") {
      void this.#available(value.ready).catch(() => this.#channel?.close());
    } else if (value.type === "history.changed") {
      this.#fresh.add(value.sourceDeviceId);
      void this.#work();
    } else {
      const parsed = packet.safeParse(value.payload);
      if (!parsed.success) return;
      if (parsed.data.type === "reply") {
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

  #announce() {
    if (!this.#ready || this.#notice || this.#closed) return;
    this.#notice = setTimeout(() => {
      this.#notice = undefined;
      void this.#channel?.call("history.changed").catch(() => this.#channel?.close());
    }, 40);
    this.#notice.unref();
  }

  async #withBot<T>(botId: string, run: (handle: RuntimeHandle) => Promise<T>): Promise<T> {
    if (!this.#registry.touch(botId)) throw new Error("history_bot_unavailable");
    try {
      return await run(await this.#registry.open(botId, "tr_history_pull"));
    } finally {
      this.#registry.release(botId);
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
    try {
      await this.#channel?.call("history.send", {
        targetDeviceId: peer,
        payload: { type: "reply", id: pull.id, failed, result: result ?? null },
      });
    } catch {
      /* A fresh notice or reconnect retries reads, never execution. */
    }
  }

  async #pull(peer: string, query: z.infer<typeof request>): Promise<unknown> {
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

  async #catchUp(peer: string) {
    for (;;) {
      const catalog = await this.#pull(peer, {
        method: "catalog",
        known: this.#registry.summaries().map((bot) => bot.id),
      });
      await this.#registry.importHistoryCatalog(catalog, "tr_history_catalog");
      this.#changed();
      if (!(catalog as { hasMore: boolean }).hasMore) break;
    }
    for (const bot of this.#registry.summaries()) {
      let after: string | undefined;
      do {
        const list = branches.parse(
          await this.#pull(peer, {
            method: "branches",
            botId: bot.id,
            ...(after ? { after } : {}),
          }),
        );
        for (const branch of list.branches) {
          const key = `${peer}/${bot.id}/${branch.branchId}`;
          let tail = this.#tails.get(key);
          for (let budget = 0; budget < 4; budget++) {
            const page = await this.#receive(
              bot.id,
              await this.#pull(peer, {
                method: "page",
                botId: bot.id,
                input: { selection: branch.selection, ...(tail ? { after: tail } : {}) },
              }),
            );
            if (page.snapshot) this.#tails.set(key, page.snapshot);
            if (!tail && page.hasMore && page.cursor && page.snapshot)
              this.#backfill.set(key, {
                peer,
                botId: bot.id,
                selection: branch.selection,
                before: page.cursor,
                until: page.snapshot,
              });
            if (!tail || !page.hasMore || !page.cursor) break;
            tail = page.cursor;
            this.#tails.set(key, tail);
            if (budget === 3) this.#fresh.add(peer);
          }
        }
        after = list.hasMore ? (list.cursor ?? undefined) : undefined;
      } while (after);
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
        (this.#fresh.size || this.#backfill.size || this.#drains.size)
      ) {
        const peer = this.#fresh.values().next().value;
        activePeer = undefined;
        if (peer && (freshTurn || (!this.#backfill.size && !this.#drains.size))) {
          activePeer = peer;
          freshTurn = false;
          this.#fresh.delete(peer);
          await this.#catchUp(peer);
        } else if (this.#drains.size) {
          freshTurn = true;
          const first = this.#drains.entries().next().value;
          if (!first) break;
          const [key, drain] = first;
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
        } else {
          freshTurn = true;
          const first = this.#backfill.entries().next().value;
          if (!first) break;
          const [key, backfill] = first;
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
          if (page.hasMore && page.cursor)
            this.#backfill.set(key, { ...backfill, before: page.cursor });
          else this.#backfill.delete(key);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      if (activePeer) this.#fresh.add(activePeer);
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

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnect);
    clearTimeout(this.#retry);
    clearTimeout(this.#notice);
    for (const detach of this.#detachers) detach();
    for (const observer of this.#handles.values()) observer.detach();
    this.#handles.clear();
    this.#channel?.close();
  }
}
