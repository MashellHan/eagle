import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import type { RemoteConfiguration } from "../../src/core/domain.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

const results = (events: RuntimeEvent[]) =>
  events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .flatMap((block) => (block.type === "toolResult" ? [block] : []));
const settled = (events: RuntimeEvent[]) =>
  waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "remote tool completed",
    10_000,
  );

test("real Harness resolves deferred remote tools, recovers a lost WS reply and keeps receipts on one authorized machine", async () => {
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const credential = "isolated-owner-runtime-remote-0123456789";
  const messages: Record<string, unknown>[] = [];
  const journal = new Map<string, object>();
  let dropFirst = true;
  let hold = false;
  let release = () => {};
  let marker = "";
  server.on("upgrade", (request, socket, head) => {
    if (
      request.headers.authorization !== `Bearer ${credential}` ||
      request.url !== "/api/v1/execution?machine=machine-b"
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    ws.handleUpgrade(request, socket, head, (client) => {
      client.send(
        JSON.stringify({
          type: "status",
          machineId: "machine-b",
          online: true,
          observedAt: new Date().toISOString(),
          agentVersion: "1.1.0-alpha.2",
          capabilities: { commands: true },
        }),
      );
      client.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString());
        messages.push(message);
        if (message.type === "ping") {
          client.send('{"type":"pong"}');
          return;
        }
        if (message.type === "cancel") {
          client.send(
            JSON.stringify({
              type: "cancel-ack",
              requestId: message.requestId,
              operationId: message.operationId,
              requested: false,
            }),
          );
          return;
        }
        if (message.type === "run") {
          assert.equal(message.operation.machineId, "machine-b");
          appendFileSync(marker, "effect\n");
          journal.set(message.operation.id, {
            id: message.operation.id,
            state: "succeeded",
            stdout: "remote fixture result",
            stderr: "",
            exitCode: 0,
          });
          if (dropFirst) {
            dropFirst = false;
            client.terminate();
            return;
          }
        }
        const id = message.operation?.id ?? message.operationId;
        const operation = journal.get(id);
        const reply =
          operation === undefined
            ? { type: "error", code: "not_found", requestId: message.requestId, operationId: id }
            : { type: "result", requestId: message.requestId, operation };
        if (hold) {
          release = () => client.send(JSON.stringify(reply));
          return;
        }
        client.send(JSON.stringify(reply));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let grants: RemoteConfiguration = {
    namespace: "a".repeat(64),
    revision: "revision-a",
    targets: [
      {
        alias: "build-mac",
        enabled: true,
        origin,
        machineId: "machine-b",
        credentialRef: "runtime-fixture-ref",
        operations: ["command.exec", "herdr.setup"],
      },
    ],
  };
  const bench = await createBench({
    remote: (spec) => ({
      botId: spec.id,
      receiptKey: "fixture-daemon-receipt-token-0123456789",
      read: () => (spec.id === "b_runtime" ? grants : { ...grants, targets: [] }),
      credentials: {
        read: async (binding) => ({ binding, ownerToken: credential }),
        status: async () => true,
        remove: async () => {},
      },
    }),
  });
  marker = join(bench.dir, "effect.txt");
  let handle: Awaited<ReturnType<typeof bench.runtime.open>> | undefined;
  try {
    handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["remote"] });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      assistant([toolCall("tool_search", { query: "remote" })], { stopReason: "toolUse" }),
      assistant([toolCall("remote_status", { target: "build-mac" })], { stopReason: "toolUse" }),
      assistant(
        [
          toolCall("remote_execute", {
            target: "build-mac",
            operation: { tool: "command.exec", program: "/usr/bin/printf", args: ["safe"] },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistant("done"),
    ]);
    await handle.submit({
      requestId: "r_remote_1",
      text: "run once on build-mac",
      whenBusy: "followUp",
      trace,
    });
    await settled(events);
    const executed = results(events).find((result) => result.name === "remote_execute");
    assert.ok(executed, "the real Harness called the deferred remote extension");
    assert.equal(executed.isError, false, executed.text);
    assert.equal(existsSync(marker), true);
    assert.equal(
      readFileSync(marker, "utf8"),
      "effect\n",
      "lost reply recovery queries the admitted ID without another run",
    );
    const value = JSON.parse(executed.text);
    assert.match(value.operationId, /^br_[a-f0-9]{64}$/);
    assert.equal(messages.filter((message) => message.type === "run").length, 1);
    assert.equal(
      messages.some(
        (message) => message.type === "get" && message.operationId === value.operationId,
      ),
      true,
    );
    assert.equal(JSON.stringify(events).includes(credential), false);
    assert.equal(JSON.stringify(bench.records).includes(credential), false);
    events.length = 0;
    bench.faux.setResponses([
      assistant([toolCall("remote_operation", { receipt: value.receipt, action: "get" })], {
        stopReason: "toolUse",
      }),
      assistant([toolCall("remote_operation", { receipt: value.receipt, action: "cancel" })], {
        stopReason: "toolUse",
      }),
      assistant("done"),
    ]);
    await handle.submit({
      requestId: "r_remote_2",
      text: "query and cancel the original",
      whenBusy: "followUp",
      trace,
    });
    await settled(events);
    assert.equal(
      results(events).filter((result) => result.name === "remote_operation" && !result.isError)
        .length,
      2,
    );
    assert.equal(readFileSync(marker, "utf8"), "effect\n");
    events.length = 0;
    hold = true;
    bench.faux.setResponses([
      assistant([toolCall("remote_operation", { receipt: value.receipt, action: "get" })], {
        stopReason: "toolUse",
      }),
      assistant("done"),
    ]);
    const previous = messages.length;
    await handle.submit({
      requestId: "r_remote_3",
      text: "query while permission is revoked",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => messages.length > previous, "query admitted");
    grants = { ...grants, revision: "revision-revoked", targets: [] };
    release();
    await settled(events);
    const denied = results(events).find((result) => result.name === "remote_operation");
    assert.ok(denied?.isError);
    assert.equal(JSON.parse(denied.text).error, "denied");
    assert.equal(denied.text.includes("remote fixture result"), false);
  } finally {
    await handle?.close(trace, 1000);
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.close();
    await once(server, "close");
    await bench.cleanup();
  }
});
