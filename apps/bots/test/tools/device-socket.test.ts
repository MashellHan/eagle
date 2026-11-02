import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { readConfig } from "../../src/config.ts";
import type { BotDirectory } from "../../src/core/BotDirectory.ts";
import type { BotRegistry } from "../../src/core/BotRegistry.ts";
import type { RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { HistoryCoordinator } from "../../src/history/coordinator.ts";
import { startDaemon } from "../../src/main.ts";
import { pageHead } from "../../src/runtime/pi/historyIncremental.ts";
import {
  type DeviceRequest,
  operationDigest,
  SocketDevicePort,
} from "../../src/tools/devices/port.ts";
import { DeviceChannel } from "../../src/tools/devices/socket.ts";
import { TriggerProducers } from "../../src/triggers/producers.ts";
import { waitFor } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

const fixture = async (handle: (socket: Socket, request: Record<string, unknown>) => void) => {
  const root = await mkdtemp(join(tmpdir(), "device-port-"));
  const path = join(root, "access-v1.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        handle(socket, JSON.parse(line));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("typed approval decodes the host envelope and preserves its operation bindings", async () => {
  const operation = { kind: "command", command: "pwd" };
  const request: DeviceRequest = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    sourceBotId: "bot-one",
    action: "run",
    operation,
    digest: operationDigest(operation),
  };
  const approval = {
    operationId: request.operationId,
    sourceDeviceId: randomUUID(),
    targetDeviceId: request.targetDeviceId,
    digest: request.digest,
    policyVersion: 2,
    expiresAt: Date.now() + 60000,
    signature: "test-signature",
  };
  const bench = await fixture((socket, frame) => {
    assert.equal(frame.method, "approval.request");
    assert.deepEqual((frame.params as { request: unknown }).request, request);
    socket.write(`${JSON.stringify({ requestId: frame.requestId, result: { approval } })}\n`);
  });
  try {
    assert.deepEqual(await new SocketDevicePort(bench.path).approve(request, 2), approval);
  } finally {
    await bench.close();
  }
});

test("device v1 JSONL keeps split Unicode and correlates out-of-order replies", async () => {
  const requests: Record<string, unknown>[] = [];
  const bench = await fixture((socket, request) => {
    requests.push(request);
    if (requests.length === 2) {
      for (const value of [...requests].reverse()) {
        const frame = Buffer.from(
          `${JSON.stringify({ requestId: value.requestId, result: { name: "书房 Mac", method: value.method } })}\n`,
        );
        const split = frame.indexOf(Buffer.from("书")) + 1;
        socket.write(frame.subarray(0, split));
        socket.write(frame.subarray(split));
      }
    }
  });
  const channel = new DeviceChannel(bench.path);
  try {
    const result = await Promise.all([channel.call("status"), channel.call("directory")]);
    assert.deepEqual(result, [
      { name: "书房 Mac", method: "status" },
      { name: "书房 Mac", method: "directory" },
    ]);
    assert.equal(
      requests.every((request) => typeof request.requestId === "string"),
      true,
    );
  } finally {
    channel.close();
    await bench.close();
  }
});

test("device channel refuses wrong IDs, oversized frames and management methods", async () => {
  for (const response of [
    `${JSON.stringify({ requestId: randomUUID(), result: {} })}\n`,
    "x".repeat(524289),
    "not-json\n",
  ]) {
    const bench = await fixture((socket) => socket.write(response));
    const channel = new DeviceChannel(bench.path);
    try {
      await assert.rejects(
        channel.call("status"),
        /invalid_device_response|device_frame_too_large/,
      );
      await assert.rejects(
        channel.call("policy.set", { mode: "all-approve" }),
        /device_method_forbidden/,
      );
    } finally {
      channel.close();
      await bench.close();
    }
  }
});

test("device port fails closed on cancellation, EOF, timeout and broad socket permissions", async () => {
  const bench = await fixture(() => {});
  try {
    const channel = new DeviceChannel(bench.path, 25);
    await assert.rejects(channel.call("status"), /device_timeout/);
    channel.close();
    const controller = new AbortController();
    controller.abort();
    const cancelled = new DeviceChannel(bench.path);
    await assert.rejects(
      cancelled.call("directory", undefined, controller.signal),
      /device_cancelled/,
    );
    cancelled.close();
    await chmod(bench.path, 0o666);
    const insecure = new DeviceChannel(bench.path);
    await assert.rejects(insecure.call("status"), /insecure_device_socket/);
    insecure.close();
  } finally {
    await bench.close();
  }
  const eof = await fixture((socket) => socket.end());
  const channel = new DeviceChannel(eof.path);
  try {
    await assert.rejects(channel.call("status"), /device_disconnected/);
  } finally {
    channel.close();
    await eof.close();
  }
});

test("device errors are stable codes without copying arbitrary server content", async () => {
  const bench = await fixture((socket, request) =>
    socket.write(
      `${JSON.stringify({ requestId: request.requestId, error: "private command or secret" })}\n`,
    ),
  );
  const channel = new DeviceChannel(bench.path);
  try {
    await assert.rejects(channel.call("status"), /^Error: device_request_failed$/);
  } finally {
    channel.close();
    await bench.close();
  }
});

test("optional history IPC events stay separate and single-consumer attach releases on close", async () => {
  let owner: Socket | undefined;
  const bench = await fixture((socket, request) => {
    if (request.method === "history.attach") {
      if (owner && owner !== socket) {
        socket.write(
          `${JSON.stringify({ requestId: request.requestId, error: "history_consumer_busy" })}\n`,
        );
        return;
      }
      owner = socket;
      socket.once("close", () => {
        if (owner === socket) owner = undefined;
      });
      socket.write(`${JSON.stringify({ type: "history.ready", enabled: true, ready: true })}\n`);
    }
    socket.write(
      `${JSON.stringify({ requestId: request.requestId, result: { enabled: true, ready: true } })}\n`,
    );
  });
  const events: unknown[] = [];
  let disconnected = false;
  const first = new DeviceChannel(bench.path, 1000, {
    event: (event) => events.push(event),
    closed: () => {
      disconnected = true;
    },
  });
  const second = new DeviceChannel(bench.path, 1000, { event: () => {} });
  try {
    assert.deepEqual(await first.call("history.attach"), { enabled: true, ready: true });
    await assert.rejects(second.call("history.attach"), /history_consumer_busy/);
    assert.equal(events.length, 1);
    first.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(disconnected, true);
    assert.deepEqual(await second.call("history.attach"), { enabled: true, ready: true });
    await assert.rejects(second.call("history.set", { enabled: true }), /device_method_forbidden/);
  } finally {
    first.close();
    second.close();
    await bench.close();
  }
});

test("a transient history notice does not disconnect the optional single consumer", async () => {
  let attached: Socket | undefined;
  let notices = 0;
  const bench = await fixture((socket, request) => {
    if (request.method === "history.attach") attached = socket;
    if (request.method === "history.changed") notices++;
    socket.write(
      `${JSON.stringify({
        requestId: request.requestId,
        ...(request.method === "history.changed"
          ? { error: "history_busy" }
          : {
              result: request.method === "history.peers" ? [] : { enabled: true, ready: true },
            }),
      })}\n`,
    );
  });
  const stack = await startStack();
  const coordinator = new HistoryCoordinator(bench.path, stack.registry, stack.directory, () => {});
  try {
    await waitFor(() => notices === 1, "the existing attachment's transient notice response");
    await new Promise<void>((done) => setTimeout(done, 20));
    assert.equal(
      attached?.destroyed,
      false,
      "Device Service owns bounded notice retry; Bots must retain attach",
    );
  } finally {
    await coordinator.close();
    await stack.close();
    await bench.close();
  }
});

test("a remote peer Bot failure cannot suppress local pending drain or the same Bot from a healthy peer", async () => {
  const peerA = randomUUID();
  const peerB = randomUUID();
  const botId = "b_pending_bot";
  const branchId = `${randomUUID()}/c1`;
  const page = {
    version: 1,
    engine: "pi-durable@1.4.0",
    botId,
    branchId,
    conversationId: branchId,
    head: pageHead(branchId, null),
    tip: null,
    cursor: null,
    snapshot: null,
    hasMore: false,
    records: [],
  };
  let imports = 0;
  let healthyPages = 0;
  const handle = {
    async importHistoryPage() {
      imports++;
      return { pending: imports === 1 };
    },
  } as unknown as RuntimeHandle;
  const registry = {
    summaries: () => [{ id: botId }],
    handleOf: () => undefined,
    observeHandles: () => () => {},
    importHistoryCatalog: async () => {},
    touch: () => true,
    open: async () => handle,
    release: () => {},
  } as unknown as BotRegistry;
  const directory = { observeChanges: () => () => {} } as unknown as BotDirectory;
  const bench = await fixture((socket, frame) => {
    let result: unknown = { enabled: true, ready: true };
    if (frame.method === "history.peers") result = [{ deviceId: peerA }, { deviceId: peerB }];
    socket.write(`${JSON.stringify({ requestId: frame.requestId, result })}\n`);
    if (frame.method !== "history.send") return;
    const params = frame.params as {
      targetDeviceId: string;
      payload: {
        type: string;
        id: string;
        request: { method: string; input?: { selection: string } };
      };
    };
    const query = params.payload.request;
    let failed = false;
    if (query.method === "catalog") result = { bots: [], hasMore: false };
    else if (query.method === "branches")
      result = {
        branches: [
          { branchId, conversationId: branchId, selection: page.head },
          ...(params.targetDeviceId === peerA
            ? [
                {
                  branchId: `${branchId}-other`,
                  conversationId: branchId,
                  selection: "b".repeat(64),
                },
              ]
            : []),
        ],
        cursor: null,
        hasMore: false,
      };
    else {
      failed = params.targetDeviceId === peerA && query.input?.selection !== page.head;
      if (params.targetDeviceId === peerB) healthyPages++;
      result = page;
    }
    socket.write(
      `${JSON.stringify({
        type: "history.packet",
        sourceDeviceId: params.targetDeviceId,
        payload: { type: "reply", id: params.payload.id, result, failed },
      })}\n`,
    );
  });
  const coordinator = new HistoryCoordinator(bench.path, registry, directory, () => {});
  try {
    await waitFor(
      () => imports >= 3 && healthyPages > 0,
      "local drain and healthy peer for the same Bot",
    );
  } finally {
    await coordinator.close();
    await bench.close();
  }
});

test("coordinator close joins a late real Bot open and never runs history after close", async (t) => {
  const stack = await startStack({ real: true });
  const botId = "b_late_open";
  await stack.registry.importHistoryCatalog(
    {
      bots: [{ id: botId, title: "late open", createdAt: new Date().toISOString() }],
      hasMore: false,
    },
    "tr_close",
  );
  const opening = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  let began = false;
  let operations = 0;
  const open = stack.registry.open.bind(stack.registry);
  t.mock.method(stack.registry, "open", async (...args: Parameters<typeof open>) => {
    began = true;
    await opening.promise;
    const handle = await open(...args);
    handle.listHistoryBranches = async () => {
      operations++;
      return { branches: [], cursor: null, hasMore: false };
    };
    opened.resolve();
    return handle;
  });
  let attached: Socket | undefined;
  const bench = await fixture((socket, request) => {
    if (request.method === "history.attach") attached = socket;
    socket.write(
      `${JSON.stringify({
        requestId: request.requestId,
        result: request.method === "history.peers" ? [] : { enabled: true, ready: true },
      })}\n`,
    );
  });
  const coordinator = new HistoryCoordinator(bench.path, stack.registry, stack.directory, () => {});
  try {
    await waitFor(() => attached !== undefined, "attachment");
    attached?.write(
      `${JSON.stringify({
        type: "history.packet",
        sourceDeviceId: randomUUID(),
        payload: { type: "pull", id: randomUUID(), request: { method: "branches", botId } },
      })}\n`,
    );
    await waitFor(() => began, "actual coordinator Bot open");
    const closing = coordinator.close();
    const shutdown = Promise.resolve(closing).then(() => stack.registry.shutdown());
    opening.resolve();
    await shutdown;
    await opened.promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(operations, 0, "an open that completes after close cannot export/import");
    assert.equal(
      stack.registry.handleOf(botId),
      undefined,
      "shutdown owns and closes the late native handle",
    );
  } finally {
    opening.resolve();
    await coordinator.close();
    await stack.close();
    await bench.close();
  }
});

test("daemon shutdown stops core admission before joining a held history native open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bots-close-history-"));
  let attached: Socket | undefined;
  const bench = await fixture((socket, request) => {
    if (request.method === "history.attach") attached = socket;
    socket.write(
      `${JSON.stringify({
        requestId: request.requestId,
        result: request.method === "history.peers" ? [] : { enabled: true, ready: true },
      })}\n`,
    );
  });
  let schedulerStopped = false;
  const stop = TriggerProducers.prototype.stop;
  t.mock.method(TriggerProducers.prototype, "stop", function (this: TriggerProducers) {
    schedulerStopped = true;
    stop.call(this);
  });
  const daemon = await startDaemon(
    readConfig({
      argv: ["--root", root, "--port", "0"],
      env: { BOTS_DEVICE_SOCKET: bench.path },
    }),
  );
  const opening = Promise.withResolvers<void>();
  let began = false;
  let opened = false;
  let shutAfterOpen = false;
  let closing: Promise<void> | undefined;
  let socket: WebSocket | undefined;
  try {
    const bot = await daemon.registry.create("held history", "tr_close_history");
    const open = daemon.registry.open.bind(daemon.registry);
    t.mock.method(daemon.registry, "open", async (...args: Parameters<typeof open>) => {
      began = true;
      await opening.promise;
      const handle = await open(...args);
      opened = true;
      return handle;
    });
    const shutdown = daemon.registry.shutdown.bind(daemon.registry);
    t.mock.method(daemon.registry, "shutdown", () => {
      shutAfterOpen = opened;
      return shutdown();
    });
    socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/v1/socket`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", resolve);
      socket?.once("error", reject);
    });
    const welcome = new Promise<void>((resolve) => socket?.once("message", () => resolve()));
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, client: "close-history" }));
    await welcome;
    await waitFor(() => attached !== undefined, "history attachment");
    attached?.write(
      `${JSON.stringify({
        type: "history.packet",
        sourceDeviceId: randomUUID(),
        payload: {
          type: "pull",
          id: randomUUID(),
          request: { method: "branches", botId: bot.id },
        },
      })}\n`,
    );
    await waitFor(() => began, "actual coordinator native open");
    let finished = false;
    closing = daemon.close().then(() => {
      finished = true;
    });
    const health = await fetch(`http://127.0.0.1:${daemon.port}/v1/health`).catch(() => undefined);
    assert.deepEqual(
      { schedulerStopped, acceptingHTTP: health?.status === 200 },
      { schedulerStopped: true, acceptingHTTP: false },
      "optional history cannot hold core admission open during shutdown",
    );
    await waitFor(() => socket?.readyState === WebSocket.CLOSED, "shutdown WebSocket close");
    assert.equal(finished, false, "native history leases still join before registry shutdown");
    opening.resolve();
    await closing;
    assert.equal(shutAfterOpen, true, "registry shutdown follows the late native open");
    assert.equal(daemon.registry.handleOf(bot.id), undefined);
  } finally {
    opening.resolve();
    socket?.terminate();
    await (closing ?? daemon.close());
    await bench.close();
    await rm(root, { recursive: true, force: true });
  }
});
