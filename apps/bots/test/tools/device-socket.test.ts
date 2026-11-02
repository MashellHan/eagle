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
import { pageHead, validateHistoryPage } from "../../src/runtime/pi/historyIncremental.ts";
import {
  type DeviceRequest,
  operationDigest,
  SocketDevicePort,
} from "../../src/tools/devices/port.ts";
import { DeviceChannel } from "../../src/tools/devices/socket.ts";
import { TriggerProducers } from "../../src/triggers/producers.ts";
import { text, trace, waitFor } from "../support/pi.ts";
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
    if (params.payload.type !== "pull") return;
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

test("an encrypted changed Bot preempts a multi-branch catch-up and empty echoes do not announce", async () => {
  const peer = randomUUID();
  const oldBot = "b_old_many_branches";
  const freshBot = "b_fresh_priority";
  const oldBranches = Array.from({ length: 8 }, () => `${randomUUID()}/c1`);
  const freshBranch = `${randomUUID()}/c1`;
  const page = (botId: string, branchId: string) => ({
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
  });
  const imported: string[] = [];
  const reads: string[] = [];
  let notices = 0;
  let attached: Socket | undefined;
  let releaseOld: (() => void) | undefined;
  const registry = {
    summaries: () => [{ id: oldBot }, { id: freshBot }],
    handleOf: () => undefined,
    observeHandles: () => () => {},
    importHistoryCatalog: async () => {},
    touch: () => true,
    open: async (botId: string) => ({
      importHistoryPage: async () => {
        imported.push(botId);
        return { pending: false };
      },
    }),
    release: () => {},
  } as unknown as BotRegistry;
  const directory = { observeChanges: () => () => {} } as unknown as BotDirectory;
  const bench = await fixture((socket, frame) => {
    if (frame.method === "history.attach") attached = socket;
    if (frame.method === "history.changed") notices++;
    socket.write(
      `${JSON.stringify({ requestId: frame.requestId, result: frame.method === "history.peers" ? [{ deviceId: peer }] : { enabled: true, ready: true } })}\n`,
    );
    if (frame.method !== "history.send") return;
    const { payload } = frame.params as {
      payload: {
        type: string;
        id: string;
        request: { method: string; botId: string; input?: { selection: string } };
      };
    };
    if (payload.type !== "pull") {
      notices++;
      return;
    }
    const query = payload.request;
    reads.push(`${query.method}/${query.botId ?? ""}`);
    const result =
      query.method === "catalog"
        ? { bots: [], hasMore: false }
        : query.method === "branches"
          ? {
              branches: (query.botId === oldBot ? oldBranches : [freshBranch]).map((branchId) => ({
                branchId,
                conversationId: branchId,
                selection: page(query.botId, branchId).head,
              })),
              cursor: null,
              hasMore: false,
            }
          : page(
              query.botId,
              query.input?.selection === page(freshBot, freshBranch).head
                ? freshBranch
                : (oldBranches.find(
                    (branch) => page(oldBot, branch).head === query.input?.selection,
                  ) as string),
            );
    const reply = () =>
      socket.write(
        `${JSON.stringify({ type: "history.packet", sourceDeviceId: peer, payload: { type: "reply", id: payload.id, result, failed: false } })}\n`,
      );
    if (query.method === "page" && query.botId === oldBot && !releaseOld)
      releaseOld = () => {
        reply();
      };
    else reply();
  });
  const coordinator = new HistoryCoordinator(bench.path, registry, directory, () => {});
  try {
    await waitFor(() => releaseOld !== undefined, "one old branch page is held");
    const first = reads.length;
    attached?.write(`${JSON.stringify({ type: "history.changed", sourceDeviceId: peer })}\n`);
    attached?.write(
      `${JSON.stringify({ type: "history.packet", sourceDeviceId: peer, payload: { type: "changed", botIds: [freshBot], catalog: false } })}\n`,
    );
    releaseOld?.();
    await waitFor(() => imported.includes(freshBot), "the hinted fresh Bot imports");
    const next = reads.slice(first);
    assert.equal(
      next[0],
      `branches/${freshBot}`,
      "fresh work cannot wait for the rest of the peer's old branches",
    );
    assert.ok(
      next.indexOf(`page/${freshBot}`) < oldBranches.length,
      "fresh import is bounded by reads, not old branch count",
    );
    await waitFor(
      () => imported.filter((bot) => bot === oldBot).length === oldBranches.length,
      "old work is retained",
    );
    await waitFor(
      () => reads.filter((read) => read === "catalog/").length === 2,
      "the last coarse notice received during a scan is retained",
    );
    await waitFor(() => notices === 3, "initial catalog hint and compatibility notice finish");
    const idle = notices;
    const count = reads.length;
    for (let echo = 0; echo < 2; echo++) {
      attached?.write(
        `${JSON.stringify({ type: "history.packet", sourceDeviceId: peer, payload: { type: "changed", botIds: [oldBot], catalog: false } })}\n`,
      );
      await waitFor(() => reads.length > count + echo, "a bounded duplicate branch directory read");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(notices, idle, "empty/duplicate receives must not cause another announce");
    assert.equal(
      reads.filter((read) => read === `page/${oldBot}`).length,
      oldBranches.length,
      "unchanged immutable heads are not pulled again",
    );
  } finally {
    releaseOld?.();
    await coordinator.close();
    await bench.close();
  }
});

test("a Bot created during an existing coarse scan imports its catalog before old branches", async () => {
  const peer = randomUUID();
  const origin = randomUUID();
  const oldBot = "b_known_old_catalog";
  const freshBot = "b_created_mid_scan";
  const known = [oldBot];
  const oldBranches = Array.from({ length: 8 }, () => `${randomUUID()}/c1`);
  const freshBranch = `${origin}/c1`;
  const imports: string[] = [];
  const reads: string[] = [];
  let created = false;
  let attached: Socket | undefined;
  let release: (() => void) | undefined;
  const page = (botId: string, branchId: string) => {
    const tip = botId === freshBot ? `${origin}/e1` : null;
    return {
      version: 1,
      engine: "pi-durable@1.4.0",
      botId,
      branchId,
      conversationId: branchId,
      tip,
      head: pageHead(branchId, tip),
      cursor: tip ? "1" : null,
      snapshot: tip ? "1" : null,
      hasMore: false,
      records: tip
        ? [
            {
              previous: null,
              entry: {
                id: tip,
                originId: origin,
                conversationId: branchId,
                kind: "model",
                model: [{ role: "user", content: "new Bot committed user", timestamp: 1 }],
              },
            },
          ]
        : [],
    };
  };
  const registry = {
    summaries: () => known.map((id) => ({ id })),
    handleOf: () => undefined,
    observeHandles: () => () => {},
    importHistoryCatalog: async (value: { bots: { id: string }[] }) => {
      for (const bot of value.bots) if (!known.includes(bot.id)) known.push(bot.id);
    },
    touch: (botId: string) => known.includes(botId),
    open: async (botId: string) => ({
      importHistoryPage: async (input: unknown) => {
        const received = validateHistoryPage(input);
        if (botId === freshBot)
          assert.match(JSON.stringify(received.records), /new Bot committed user/);
        imports.push(botId);
        return { pending: false };
      },
    }),
    release: () => {},
  } as unknown as BotRegistry;
  const directory = { observeChanges: () => () => {} } as unknown as BotDirectory;
  const bench = await fixture((socket, frame) => {
    if (frame.method === "history.attach") attached = socket;
    socket.write(
      `${JSON.stringify({
        requestId: frame.requestId,
        result:
          frame.method === "history.peers" ? [{ deviceId: peer }] : { enabled: true, ready: true },
      })}\n`,
    );
    if (frame.method !== "history.send") return;
    const { payload } = frame.params as {
      payload: {
        type: string;
        id: string;
        request: {
          method: string;
          botId: string;
          input?: { selection: string };
        };
      };
    };
    if (payload.type !== "pull") return;
    const query = payload.request;
    reads.push(`${query.method}/${query.botId ?? ""}`);
    const ids = query.botId === oldBot ? oldBranches : [freshBranch];
    const result =
      query.method === "catalog"
        ? { bots: created ? [{ id: freshBot }] : [], hasMore: false }
        : query.method === "branches"
          ? {
              branches: ids.map((branchId) => ({
                branchId,
                conversationId: branchId,
                selection: page(query.botId, branchId).head,
              })),
              cursor: null,
              hasMore: false,
            }
          : page(
              query.botId,
              ids.find(
                (branchId) => page(query.botId, branchId).head === query.input?.selection,
              ) as string,
            );
    const reply = () =>
      socket.write(
        `${JSON.stringify({
          type: "history.packet",
          sourceDeviceId: peer,
          payload: { type: "reply", id: payload.id, result, failed: false },
        })}\n`,
      );
    if (query.method === "page" && query.botId === oldBot && !release)
      release = () => {
        reply();
      };
    else reply();
  });
  const coordinator = new HistoryCoordinator(bench.path, registry, directory, () => {});
  try {
    await waitFor(() => release !== undefined, "existing coarse scan's first old page is held");
    assert.deepEqual(known, [oldBot]);
    const before = reads.length;
    created = true;
    attached?.write(
      `${JSON.stringify({
        type: "history.packet",
        sourceDeviceId: peer,
        payload: { type: "changed", botIds: [freshBot], catalog: true },
      })}\n`,
    );
    release?.();
    await waitFor(
      () => imports.includes(freshBot),
      "new catalog and committed user import automatically",
    );
    assert.equal(
      imports.indexOf(freshBot),
      1,
      "only the already running old page may precede the new Bot",
    );
    assert.equal(reads[before], "catalog/", "new metadata cannot queue behind old branch pages");
    await waitFor(
      () => imports.filter((id) => id === oldBot).length === oldBranches.length,
      "preempted coarse branches remain queued",
    );
  } finally {
    release?.();
    await coordinator.close();
    await bench.close();
  }
});

test("hot and coarse scans import all five delta pages before caching the newer head", async (t) => {
  const peer = randomUUID();
  const origin = randomUUID();
  const botId = "b_interleaved_delta";
  const branchId = `${origin}/c1`;
  const records = Array.from({ length: 162 }, (_, index) => ({
    previous: index ? `${origin}/e${index}` : null,
    entry: {
      id: `${origin}/e${index + 1}`,
      originId: origin,
      conversationId: branchId,
      kind: "model",
      model: [{ role: "user", content: `committed record ${index + 1}`, timestamp: index }],
    },
  }));
  const imported = new Set<string>();
  let tip = 1;
  let injected = false;
  let attached: Socket | undefined;
  const registry = {
    summaries: () => [{ id: botId }],
    handleOf: () => undefined,
    observeHandles: () => () => {},
    importHistoryCatalog: async () => {},
    touch: () => true,
    open: async () => ({
      importHistoryPage: async (input: unknown) => {
        const page = validateHistoryPage(input);
        for (const record of page.records) imported.add(record.entry.id);
        if (tip === 161 && page.records[0]?.entry.id === `${origin}/e2` && !injected) {
          injected = true;
          tip = 162;
          attached?.write(
            `${JSON.stringify({
              type: "history.packet",
              sourceDeviceId: peer,
              payload: { type: "changed", botIds: [botId], catalog: false },
            })}\n`,
          );
        }
        return { pending: false };
      },
    }),
    release: () => {},
  } as unknown as BotRegistry;
  const directory = { observeChanges: () => () => {} } as unknown as BotDirectory;
  const bench = await fixture((socket, frame) => {
    if (frame.method === "history.attach") attached = socket;
    socket.write(
      `${JSON.stringify({
        requestId: frame.requestId,
        result:
          frame.method === "history.peers" ? [{ deviceId: peer }] : { enabled: true, ready: true },
      })}\n`,
    );
    if (frame.method !== "history.send") return;
    const { payload } = frame.params as {
      payload: {
        type: string;
        id: string;
        request: {
          method: string;
          input?: { selection: string; after?: string };
        };
      };
    };
    if (payload.type !== "pull") return;
    const query = payload.request;
    let result: unknown;
    if (query.method === "catalog") result = { bots: [], hasMore: false };
    else if (query.method === "branches")
      result = {
        branches: [
          {
            branchId,
            conversationId: branchId,
            selection: pageHead(branchId, `${origin}/e${tip}`),
          },
        ],
        cursor: null,
        hasMore: false,
      };
    else {
      const bound = [1, 161, 162].find(
        (end) => pageHead(branchId, `${origin}/e${end}`) === query.input?.selection,
      );
      assert.ok(bound);
      const after = query.input?.after;
      const start = after === undefined ? Math.max(0, bound - 32) : Number(after);
      const end = Math.min(bound, start + 32);
      result = {
        version: 1,
        engine: "pi-durable@1.4.0",
        botId,
        branchId,
        conversationId: branchId,
        tip: `${origin}/e${bound}`,
        head: pageHead(branchId, `${origin}/e${bound}`),
        snapshot: String(bound),
        cursor: String(end),
        hasMore: end < bound,
        records: records.slice(start, end),
      };
    }
    socket.write(
      `${JSON.stringify({
        type: "history.packet",
        sourceDeviceId: peer,
        payload: { type: "reply", id: payload.id, result, failed: false },
      })}\n`,
    );
  });
  const coordinator = new HistoryCoordinator(bench.path, registry, directory, () => {});
  try {
    await waitFor(() => imported.size === 1, "initial native ancestor imports");
    tip = 161;
    attached?.write(`${JSON.stringify({ type: "history.changed", sourceDeviceId: peer })}\n`);
    await waitFor(() => injected, "H2 hint arrives during the first H1 delta receive");
    await waitFor(
      () => imported.size === records.length,
      "every old delta record and the new H2 record",
    );
    assert.equal(imported.size, 162);
  } finally {
    t.diagnostic(
      `imported ${imported.size}/${records.length}; missing entries: ${records
        .filter((record) => !imported.has(record.entry.id))
        .map((record) => record.entry.id.split("/e")[1])
        .join(",")}`,
    );
    await coordinator.close();
    await bench.close();
  }
});

test("a native commit retains its last Bot hint after busy, while empty imports and opens stay quiet", async () => {
  const stack = await startStack({ real: true });
  const botId = await stack.createBot("native notice");
  const peer = randomUUID();
  const hints: { botIds: string[]; catalog: boolean }[] = [];
  let published = 0;
  const bench = await fixture((socket, frame) => {
    let error: string | undefined;
    if (frame.method === "history.send") {
      const { payload } = frame.params as {
        payload: {
          type: string;
          id: string;
          botIds: string[];
          catalog: boolean;
          request?: { method: string };
        };
      };
      if (payload.type === "changed") {
        hints.push(payload);
        if (payload.botIds.includes(botId)) {
          if (hints.filter((hint) => hint.botIds.includes(botId)).length === 1)
            error = "history_busy";
          else published++;
        }
      } else if (payload.type === "pull") {
        socket.write(
          `${JSON.stringify({
            type: "history.packet",
            sourceDeviceId: peer,
            payload: {
              type: "reply",
              id: payload.id,
              failed: false,
              result:
                payload.request?.method === "catalog"
                  ? { bots: [], hasMore: false }
                  : { branches: [], hasMore: false, cursor: null },
            },
          })}\n`,
        );
      }
    }
    socket.write(
      `${JSON.stringify({
        requestId: frame.requestId,
        ...(error
          ? { error }
          : {
              result:
                frame.method === "history.peers"
                  ? [{ deviceId: peer }]
                  : { enabled: true, ready: true },
            }),
      })}\n`,
    );
  });
  const held = Promise.withResolvers<void>();
  const handle = await stack.registry.open(botId, trace);
  let observing = false;
  const observe = handle.observeHistoryChanges?.bind(handle);
  assert.ok(observe);
  handle.observeHistoryChanges = (listener) => {
    observing = true;
    return observe(listener);
  };
  const coordinator = new HistoryCoordinator(bench.path, stack.registry, stack.directory, () => {});
  try {
    await waitFor(() => hints.some((hint) => hint.catalog), "initial catalog hint");
    await waitFor(() => observing, "native observer attached outside open");
    const baseline = hints.length;
    const empty = validateHistoryPage(await handle.exportHistoryPage?.());
    assert.deepEqual(empty.records, []);
    await handle.importHistoryPage?.(empty);
    await handle.importHistoryPage?.(empty);
    await new Promise<void>((done) => setTimeout(done, 100));
    assert.equal(hints.length, baseline, "open and duplicate empty native receives do not notify");
    let calls = 0;
    stack.faux?.setResponses([
      async () => {
        calls++;
        await held.promise;
        return text("after the hint has retried");
      },
    ]);
    await handle.submit({
      requestId: "r_last_hint",
      text: "a single committed user",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => published === 1,
      "last Bot hint retries busy without another commit or renewal",
    );
    assert.equal(calls, 1);
    const attempts = hints.filter((hint) => hint.botIds.includes(botId));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0], "the failed Bot IDs survive the retry");
  } finally {
    held.resolve();
    await coordinator.close();
    await stack.close();
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
