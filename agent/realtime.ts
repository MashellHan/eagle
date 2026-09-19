import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  AgentMessageSchema,
  BridgeMessageSchema,
  type LiveTopology,
  type Subscription,
  TopologySchema,
} from "../src/shared/realtime.ts";
import {
  type AgentConfig,
  checkUrl,
  normalizeSnapshot,
  redact,
  type Snapshot,
} from "./collector.ts";

export function socketRequest(
  path: string,
  method: string,
  params: object,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const socket = createConnection(path);
    const id = randomUUID();
    let bytes = "",
      settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Missing response"));
    };
    const abort = () => finish(new Error("Cancelled"));
    const timer = setTimeout(() => finish(new Error("Herdr timeout")), 5000);
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("error", () => finish(new Error("Herdr unavailable")));
    socket.on("end", () => finish(new Error("Herdr disconnected")));
    socket.on("connect", () => {
      if (!signal.aborted)
        socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      bytes += chunk;
      if (bytes.length > 4 * 1024 * 1024) {
        finish(new Error("Herdr response too large"));
        return;
      }
      const end = bytes.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(bytes.slice(0, end));
        if (response.id !== id || response.error || !response.result)
          throw new Error();
        finish(undefined, response.result);
      } catch {
        finish(new Error("Invalid Herdr response"));
      }
    });
  });
}
type Watch = {
  subscription: Subscription;
  abort: AbortController;
  force: boolean;
  path?: string;
  topology?: LiveTopology;
  revisions: Map<string, number>;
  queue: Promise<void>;
};
export class LiveBridge {
  private watches = new Map<string, Watch>();
  private secrets: string[];
  private send: (
    message: import("zod").infer<typeof AgentMessageSchema>,
  ) => void;
  private resolve: (session: string, signal: AbortSignal) => Promise<string>;
  constructor(
    secrets: string[],
    send: (message: import("zod").infer<typeof AgentMessageSchema>) => void,
    resolve: (session: string, signal: AbortSignal) => Promise<string>,
  ) {
    this.secrets = secrets;
    this.send = send;
    this.resolve = resolve;
  }
  receive(value: unknown) {
    const parsed = BridgeMessageSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid relay message");
    const message = parsed.data;
    if (message.type === "subscriptions") {
      const wanted = new Map(message.spaces.map((s) => [s.spaceId, s]));
      for (const [key, watch] of this.watches)
        if (
          wanted.get(key)?.subscriptionId !== watch.subscription.subscriptionId
        ) {
          watch.abort.abort();
          this.watches.delete(key);
        }
      for (const subscription of message.spaces) {
        const previous = this.watches.get(subscription.spaceId);
        if (previous) {
          previous.force = true;
          continue;
        }
        const watch: Watch = {
          subscription,
          abort: new AbortController(),
          force: true,
          revisions: new Map(),
          queue: Promise.resolve(),
        };
        this.watches.set(subscription.spaceId, watch);
        void this.watch(watch);
      }
    } else if (message.type === "input") {
      const watch = this.watches.get(message.spaceId);
      const ack = (status: "delivered" | "rejected" | "unknown") =>
        this.send({
          type: "ack",
          clientId: message.clientId,
          seq: message.seq,
          status,
        });
      if (
        !watch ||
        watch.subscription.subscriptionId !== message.subscriptionId
      ) {
        ack("rejected");
        return;
      }
      watch.queue = watch.queue.then(async () => {
        let dispatched = false;
        try {
          if (
            !watch.path ||
            watch.abort.signal.aborted ||
            redact(message.text, this.secrets) !== message.text
          ) {
            ack("rejected");
            return;
          }
          const result = await socketRequest(
            watch.path,
            "session.snapshot",
            {},
            watch.abort.signal,
          );
          const raw = result.snapshot as Snapshot;
          const pane = raw.panes.find(
            (p) =>
              p.pane_id === message.paneId &&
              p.terminal_id === message.terminalId &&
              `${message.spaceId.slice(0, message.spaceId.indexOf(":"))}:${p.workspace_id}` ===
                message.spaceId,
          );
          if (!pane || watch.abort.signal.aborted) {
            ack("rejected");
            return;
          }
          dispatched = true;
          await socketRequest(
            watch.path,
            "pane.send_input",
            { pane_id: pane.pane_id, text: message.text, keys: message.keys },
            watch.abort.signal,
          );
          watch.force = true;
          ack("delivered");
        } catch {
          ack(dispatched ? "unknown" : "rejected");
        }
      });
    }
  }
  private async watch(watch: Watch) {
    const { spaceId } = watch.subscription;
    const session = spaceId.slice(0, spaceId.indexOf(":"));
    const signal = watch.abort.signal;
    try {
      watch.path = await this.resolve(session, signal);
      while (!signal.aborted) {
        const result = await socketRequest(
          watch.path,
          "session.snapshot",
          {},
          signal,
        );
        const raw = result.snapshot as Omit<Snapshot, "panes"> & {
          panes: (Snapshot["panes"][number] & { revision: number })[];
        };
        const space = normalizeSnapshot(raw, session).find(
          (s) => s.id === spaceId,
        );
        if (!space) throw new Error("Space unavailable");
        const topology = TopologySchema.parse({
          type: "topology",
          ...watch.subscription,
          tabs: space.tabs.map((t) => ({
            id: t.id,
            name: redact(t.name, this.secrets).slice(0, 240),
            panes: t.panes.map((p) => ({
              id: p.id,
              terminalId: raw.panes.find((r) => r.pane_id === p.id)
                ?.terminal_id,
              title: redact(p.title, this.secrets).slice(0, 240),
              rect: p.rect,
            })),
          })),
        });
        const force =
          watch.force ||
          JSON.stringify(topology) !== JSON.stringify(watch.topology);
        watch.force = false;
        if (signal.aborted) return;
        if (force) {
          this.send(topology);
          watch.topology = topology;
        }
        const panes = topology.tabs.flatMap((t) => t.panes);
        // ponytail: bounded screen polling, one loop per subscribed Space; use native output events if profiling warrants it.
        for (let i = 0; i < panes.length; i += 4)
          await Promise.all(
            panes.slice(i, i + 4).map(async (p) => {
              const current = raw.panes.find((r) => r.pane_id === p.id);
              if (
                !force &&
                watch.revisions.get(p.terminalId) === current?.revision
              )
                return;
              const result = await socketRequest(
                watch.path ?? "",
                "pane.read",
                {
                  pane_id: p.id,
                  source: "visible",
                  format: "text",
                  strip_ansi: true,
                },
                signal,
              );
              const read = result.read as { revision: number; text: string };
              if (signal.aborted) return;
              const frame = AgentMessageSchema.parse({
                type: "frame",
                ...watch.subscription,
                paneId: p.id,
                terminalId: p.terminalId,
                revision: read.revision,
                text: redact(read.text, this.secrets).slice(-32000),
                observedAt: new Date().toISOString(),
              });
              this.send(frame);
              watch.revisions.set(p.terminalId, read.revision);
            }),
          );
        for (const key of watch.revisions.keys())
          if (!panes.some((p) => p.terminalId === key))
            watch.revisions.delete(key);
        await delay(350, undefined, { signal });
      }
    } catch {
      if (!signal.aborted)
        this.send({ type: "unavailable", ...watch.subscription });
    } finally {
      watch.abort.abort();
      if (this.watches.get(spaceId) === watch) this.watches.delete(spaceId);
    }
  }
  close() {
    for (const watch of this.watches.values()) watch.abort.abort();
    this.watches.clear();
  }
}

export async function realtimeWatch(config: AgentConfig, signal: AbortSignal) {
  const url = new URL("/api/v1/realtime-agent", checkUrl(config.url));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let retry = 1000;
  while (!signal.aborted) {
    let authFailure = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${config.token}` },
        handshakeTimeout: 10000,
        maxPayload: 262144,
        followRedirects: false,
      });
      const bridge = new LiveBridge(
        [config.token],
        (message) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 524288) {
            ws.close(1013, "Slow connection");
            return;
          }
          ws.send(JSON.stringify(message));
        },
        async (session, watchSignal) => {
          const { stdout } = await promisify(execFile)(
            "herdr",
            ["session", "list", "--json"],
            { timeout: 8000, maxBuffer: 1048576, signal: watchSignal },
          );
          const found = JSON.parse(stdout).sessions.find(
            (s: { name: string; running: boolean }) =>
              s.name === session && s.running,
          );
          if (!found?.socket_path) throw new Error("Session unavailable");
          return found.socket_path;
        },
      );
      let lastMessage = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 30000) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, 10000);
      const stop = () => ws.terminate();
      signal.addEventListener("abort", stop, { once: true });
      ws.on("open", () => {
        retry = 1000;
        console.log(JSON.stringify({ event: "realtime_connected" }));
      });
      ws.on("message", (data) => {
        lastMessage = Date.now();
        try {
          bridge.receive(JSON.parse(String(data)));
        } catch {
          ws.close(1008, "Invalid relay message");
        }
      });
      ws.on("unexpected-response", (_request, response) => {
        authFailure = [401, 403].includes(response.statusCode ?? 0);
        response.destroy();
        ws.terminate();
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        clearInterval(heartbeat);
        signal.removeEventListener("abort", stop);
        bridge.close();
        resolve();
      });
    });
    if (authFailure)
      throw new Error(
        "Realtime authentication rejected; fix secure configuration",
      );
    if (!signal.aborted) {
      await delay(retry, undefined, { signal }).catch(() => {});
      retry = Math.min(retry * 2, 30000);
    }
  }
}
