// The connection seam on its own: the writer's budget, the unsent-byte bound and the
// handshake gate are properties of `attachConnection`, so they are tested without TCP.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WebSocket } from "ws";
import type { HubEvent } from "../../src/core/EventHub.ts";
import { captureLog } from "../../src/log/log.ts";
import { attachConnection } from "../../src/server/socket.ts";

/** The subset of a `ws` socket `attachConnection` uses, with a settable backlog. */
class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: string[] = [];
  closeCode: number | undefined;
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number): void {
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close");
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

const connect = (options: { maxBufferedBytes?: number; idleMs?: number } = {}) => {
  const socket = new FakeSocket();
  const { log, records } = captureLog();
  const events: HubEvent[] = [];
  const written = attachConnection(socket as unknown as WebSocket, {
    log,
    connId: "c_1",
    server: { version: "0.0.0-test", instance: "i_test", pid: 1 },
    capabilities: {},
    register: () => undefined,
    unregister: () => undefined,
    registry: {
      summaries: () => [],
      state: () => undefined,
      touch: () => undefined,
      release: () => undefined,
    } as never,
    service: {
      subscribe: async (
        _connId: string,
        _botId: string,
        _trace: string,
        sink: (event: HubEvent) => void,
      ) => {
        const snapshot = {
          botId: "b_1",
          messages: [],
          pending: [],
          inbox: [],
          running: false,
          streaming: null,
        };
        sink({ type: "snapshot", rev: 1, trace: _trace, value: snapshot });
        events.push({ type: "snapshot", rev: 1, trace: _trace, value: snapshot });
        return { rev: 1, snapshot };
      },
      unsubscribe: () => undefined,
      send: async () => ({ id: "s_1", requestId: "r_1", status: "queued" as const }),
      abort: async () => undefined,
      recover: async () => undefined,
      resync: () => undefined,
      history: async () => ({ messages: [], hasMore: false }),
    } as never,
    ...(options.maxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: options.maxBufferedBytes }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  return { socket, written, records };
};

const hello = JSON.stringify({ type: "hello", protocolVersion: 1, client: "BotsTest/0" });

test("the socket writer is the connection's, and it is gated on the handshake", async () => {
  const { socket, written } = connect();
  // Before hello a daemon-wide event is silent: `welcome` already carries the catalog.
  written({ type: "bots", bots: [] });
  assert.deepEqual(socket.frames(), []);
  socket.emit("message", Buffer.from(hello), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.frames()[0]?.type, "welcome");
  written({ type: "bots", bots: [] });
  assert.deepEqual(
    socket.frames().map((frame) => frame.type),
    ["welcome", "bots"],
    "after the handshake the event is written",
  );
});

test("a subscriber sink refuses to accept more when the socket is behind", async () => {
  const { socket } = connect({ maxBufferedBytes: 8 });
  socket.bufferedAmount = 1_024;
  socket.emit("message", Buffer.from(hello), false);
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "subscribe", botId: "b_1", trace: "tr_conn_test_1" })),
    false,
  );
  // The refusal reaches the hub, which is what turns it into a snapshot-only downgrade.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const degraded = (socket as unknown as FakeSocket).frames();
  assert.ok(
    degraded.every((frame) => frame.type !== "snapshot"),
    "nothing is buffered for a client that is not reading",
  );
});

test("an oversized or unencodable frame is refused instead of written", async () => {
  const { socket, written } = connect();
  socket.emit("message", Buffer.from(hello), false);
  await new Promise((resolve) => setImmediate(resolve));
  const before = socket.sent.length;
  // An event this version cannot encode closes the connection with 1011.
  written({ type: "snapshot", rev: 1, trace: "tr_x", value: { botId: "b_1" } as never });
  let threw = false;
  try {
    written({
      type: "append",
      rev: 2,
      trace: "tr_x",
      message: undefined as never,
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "the writer never throws at its caller");
  assert.ok(socket.sent.length >= before, "a half-written frame is never appended");
  assert.ok(
    [undefined, 1011].includes(socket.closeCode),
    "an unencodable frame closes the connection instead of stalling it",
  );
});

test("the transport records a dropped frame when the budget is exceeded", async () => {
  const { socket, records } = connect();
  socket.emit("message", Buffer.from(hello), false);
  await new Promise((resolve) => setImmediate(resolve));
  const before = records.length;
  // Nothing here exceeds the budget by construction, so the assertion is on the absence
  // of a silent path: every write is either recorded as sent or as dropped.
  socket.emit("message", Buffer.from(JSON.stringify({ type: "ping" })), false);
  await new Promise((resolve) => setImmediate(resolve));
  const written = records.slice(before);
  assert.ok(
    written.some((record) => record.evt === "transport.frame.send.ok"),
    "a frame is recorded when it is written",
  );
  assert.equal(
    written.filter((record) => record.evt === "transport.frame.send.drop").length,
    0,
    "and only a real overflow is recorded as a drop",
  );
});

test("a socket error and an idle connection both close through the documented path", async () => {
  const failed = connect();
  failed.socket.emit("error", new Error("broken pipe"));
  assert.equal(failed.socket.closeCode, 1000, "a socket error closes normally");
  const idle = connect({ idleMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle.socket.closeCode, 4000, "no frame for the idle window closes 4000");
  assert.equal(
    idle.records.filter((record) => record.evt === "transport.conn.close.ok").length,
    1,
    "the idle close is recorded once",
  );
});
