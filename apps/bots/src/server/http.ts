// The daemon's HTTP surface and its upgrade (docs/bots/PROTOCOL.md "HTTP endpoints"):
// ready checks and the catalog, with the bearer token checked before anything else runs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { BotRegistry } from "../core/BotRegistry.ts";
import type { ConversationService } from "../core/ConversationService.ts";
import { ClassifiedFailure } from "../core/domain.ts";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type { ServerEvent } from "../protocol/frames.ts";
import { MAX_TITLE_CHARS } from "../protocol/limits.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";
import { parseBearer, tokenMatches } from "./auth.ts";
import { serverFailure } from "./failures.ts";
import { attachConnection, CLOSE, MAX_CONNECTIONS, refuseUpgrade } from "./socket.ts";

const Events = {
  authFail: declareEvent("transport.auth.fail"),
  openReject: declareEvent("transport.conn.open.reject"),
} as const;

export type ServerOptions = {
  readonly token: string;
  readonly log: Log;
  readonly registry: BotRegistry;
  readonly service: ConversationService;
  readonly version: string;
  readonly instance: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly pid?: number;
  /** 0 asks the kernel for a free port, which is what tests do. */
  readonly port: number;
};

export type Daemon = {
  readonly server: Server;
  readonly port: number;
  /** Every catalog change reaches every connection as an absolute `bots` event. */
  broadcastCatalog(): void;
  close(): Promise<void>;
};

/** How long a shutdown waits for clients to acknowledge the close frame. */
const SHUTDOWN_GRACE_MS = 500;

const onceClosed = (socket: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > 8 * 1024) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (bytes === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const title = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as { title?: unknown }).title;
  return typeof value === "string" ? value.trim() : undefined;
};

export const startServer = async (options: ServerOptions): Promise<Daemon> => {
  const { log, registry, service, token } = options;
  let connections = 0;
  /** Upgrades accepted but not completed: a refused upgrade must not hold a slot. */
  let pending = 0;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const sockets = new Set<WebSocket>();
  /** One frame writer per live connection, for the daemon-wide catalog event. */
  const writers = new Map<WebSocket, (event: ServerEvent) => void>();
  const instance = options.instance ?? `i_${process.pid}`;
  let sequence = 0;

  const server = createServer((request, response) => {
    void route(request, response);
  });
  const wss = new WebSocketServer({ noServer: true });

  const broadcastCatalog = (): void => {
    const bots = registry.summaries();
    for (const writer of writers.values()) writer({ type: "bots", bots });
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (closing) {
      // PROTOCOL.md, "Close codes": the daemon is going away, so no new work is accepted.
      json(response, 503, {
        error: { kind: "internal", message: "the daemon is shutting down" },
      });
      return;
    }
    if (path === "/v1/health") {
      json(response, 200, {
        version: options.version,
        protocolVersion: PROTOCOL_VERSION,
        instance,
        pid: options.pid ?? process.pid,
        bots: registry.summaries().length,
      });
      return;
    }
    if (!tokenMatches(token, parseBearer(request.headers.authorization))) {
      log.emit("warn", "transport", Events.authFail, {
        trace: `tr_http_${process.pid}`,
        failure: serverFailure("auth_failed", "transport"),
        detail: { reason: "invalid" },
      });
      json(response, 401, {
        error: { kind: "auth_failed", message: "a bearer token is required" },
      });
      return;
    }
    try {
      if (path === "/v1/bots" && request.method === "GET") {
        json(response, 200, { bots: registry.summaries() });
        return;
      }
      if (path === "/v1/bots" && request.method === "POST") {
        const name = title(await readBody(request));
        if (name === undefined || name.length === 0 || name.length > MAX_TITLE_CHARS) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "a title is required" },
          });
          return;
        }
        const bot = await registry.create(name, `tr_http_${++sequence}`);
        broadcastCatalog();
        json(response, 201, { bot });
        return;
      }
      const match = /^\/v1\/bots\/([A-Za-z0-9_-]+)$/.exec(path);
      if (match !== null) {
        const id = match[1] as string;
        if (request.method === "PATCH") {
          const name = title(await readBody(request));
          if (name === undefined || name.length === 0 || name.length > MAX_TITLE_CHARS) {
            json(response, 400, {
              error: { kind: "invalid_command", message: "a title is required" },
            });
            return;
          }
          const bot = await registry.rename(id, name, `tr_http_${++sequence}`);
          broadcastCatalog();
          json(response, 200, { bot });
          return;
        }
        if (request.method === "DELETE") {
          await registry.remove(id, `tr_http_${++sequence}`);
          broadcastCatalog();
          response.writeHead(204).end();
          return;
        }
      }
      json(response, 404, { error: { kind: "unknown_bot", message: "no such endpoint" } });
    } catch (error) {
      const classified = error instanceof ClassifiedFailure ? error : undefined;
      const kind = classified?.failure.kind ?? "storage_failed";
      const status =
        kind === "unknown_bot"
          ? 404
          : kind === "internal"
            ? 409
            : kind === "limit_exceeded" || kind === "invalid_command"
              ? 400
              : 500;
      json(response, status, {
        error: { kind, message: classified?.message ?? "the request failed" },
      });
    }
  };

  server.on("upgrade", (request, socket, head) => {
    if (closing) {
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (!tokenMatches(token, parseBearer(request.headers.authorization))) {
      log.emit("warn", "transport", Events.authFail, {
        trace: `tr_http_${process.pid}`,
        failure: serverFailure("auth_failed", "transport"),
        detail: { reason: "invalid" },
      });
      refuseUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (connections + pending >= MAX_CONNECTIONS) {
      log.emit("warn", "transport", Events.openReject, {
        trace: `tr_http_${process.pid}`,
        failure: serverFailure("limit_exceeded", "transport"),
        detail: { reason: "queue_overflow" },
      });
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    pending += 1;
    // A handshake ws refuses (bad headers, wrong method) aborts the socket without ever
    // calling back, so the slot has to be released from the socket's own close event.
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) pending = Math.max(0, pending - 1);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      pending = Math.max(0, pending - 1);
      connections += 1;
      const connId = `c_${++sequence}`;
      const write = attachConnection(ws, {
        log,
        service,
        registry,
        connId,
        server: { version: options.version, instance, pid: options.pid ?? process.pid },
        capabilities: options.capabilities,
        register: (socket) => {
          sockets.add(socket);
        },
        unregister: (socket) => {
          sockets.delete(socket);
          writers.delete(socket);
          connections = Math.max(0, connections - 1);
        },
      });
      writers.set(ws, write);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const stop = async (): Promise<void> => {
    closing = true;
    const open = [...sockets];
    // Tell every client the daemon is going away (4001/4010 in PROTOCOL.md) instead of
    // dropping the TCP connection: a terminate reads as a crash and skips the backoff.
    for (const socket of open) {
      if (socket.readyState === WebSocket.OPEN) socket.close(CLOSE.shutdown, "shutdown");
    }
    await Promise.race([
      Promise.all(open.map((socket) => onceClosed(socket))),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    port,
    broadcastCatalog,
    close: () => {
      shutdown ??= stop();
      return shutdown;
    },
  };
};
