import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RemoteMachineClient } from "../../src/tools/remote/client.ts";
import { RemoteError } from "../../src/tools/remote/keychain.ts";
import type { RemoteDestination } from "../../src/tools/remote/protocol.ts";

test("remote client authenticates real WS, validates replies and denies after revocation", async () => {
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const seen: {
    url?: string | undefined;
    owner?: string | undefined;
    access?: string | undefined;
    messages: unknown[];
  } = { messages: [] };
  let mode = "success";
  let allowed = true;
  let release = () => {};
  server.on("upgrade", (request, socket, head) => {
    seen.url = request.url;
    seen.owner = request.headers.authorization;
    seen.access = request.headers["cf-access-client-secret"] as string;
    if (request.headers.authorization !== `Bearer ${owner}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "auth") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "redirect") {
      socket.end(
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/leak\r\nContent-Length: 0\r\n\r\n",
      );
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
        seen.messages.push(message);
        if (message.type === "ping") {
          client.send('{"type":"pong"}');
          return;
        }
        const operation = {
          id: message.operation?.id ?? message.operationId,
          state: "succeeded",
          stdout: "actual fixture result",
          stderr: "",
          exitCode: 0,
        };
        const result = { type: "result", requestId: message.requestId, operation };
        if (mode === "wrong-id") operation.id = "foreign";
        if (mode === "extra") Object.assign(result, { owner: "unexpected" });
        if (mode === "secret") operation.stdout = owner;
        if (mode === "cancel") {
          client.send(
            JSON.stringify({
              type: "cancel-ack",
              requestId: message.requestId,
              operationId: message.operationId,
              requested: true,
            }),
          );
          return;
        }
        if (mode === "stall") return;
        if (mode === "hold") {
          release = () => client.send(JSON.stringify(result));
          return;
        }
        client.send(JSON.stringify(result), { binary: mode === "binary" });
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = 'fixture-"quoted"-owner-credential-0123456789';
  const destination: RemoteDestination = {
    namespace: "a".repeat(64),
    botId: "bot-a",
    revision: "revision-a",
    target: {
      alias: "build-mac",
      enabled: true,
      origin,
      machineId: "machine-b",
      credentialRef: "fixture-ref",
      operations: ["command.exec", "herdr.setup"],
    },
  };
  const binding = {
    namespace: destination.namespace,
    botId: destination.botId,
    credentialRef: destination.target.credentialRef,
    origin,
  };
  const client = new RemoteMachineClient({
    read: async () => ({
      binding,
      ownerToken: owner,
      accessClientID: "fixture-access-id",
      accessClientSecret: "fixture-access-secret",
    }),
    status: async () => true,
    remove: async () => {},
  });
  const authorize = () => {
    if (!allowed) throw new RemoteError("denied");
  };
  try {
    const status = await client.request(destination, { type: "status" }, authorize);
    assert.equal(status.type, "status");
    const operation = {
      id: "fixture-operation",
      machineId: "machine-b",
      tool: "command.exec" as const,
      program: "/usr/bin/printf",
      args: ["safe"],
    };
    const result = await client.request(destination, { type: "run", operation }, authorize);
    assert.equal(result.type, "result");
    assert.equal(seen.owner === `Bearer ${owner}`, true);
    assert.equal(seen.access === "fixture-access-secret", true);
    assert.equal(seen.url, "/api/v1/execution?machine=machine-b");
    assert.equal(JSON.stringify(seen.messages).includes(owner), false);
    const count = seen.messages.length;
    await assert.rejects(
      client.request(
        destination,
        { type: "run", operation: { ...operation, args: [owner] } },
        authorize,
      ),
    );
    await assert.rejects(
      client.request(
        destination,
        { type: "run", operation: { ...operation, args: ["x".repeat(8192), "y".repeat(8192)] } },
        authorize,
      ),
    );
    assert.equal(
      seen.messages.length,
      count,
      "raw credential fields rejected before sending even when JSON would escape them",
    );
    for (const next of ["wrong-id", "extra", "binary", "secret", "redirect", "auth"]) {
      mode = next;
      await assert.rejects(
        client.request(destination, { type: "get", operationId: operation.id }, authorize),
        (error: unknown) =>
          error instanceof RemoteError && (next !== "auth" || error.code === "authentication"),
      );
    }
    mode = "cancel";
    assert.equal(
      (await client.request(destination, { type: "cancel", operationId: operation.id }, authorize))
        .type,
      "cancel-ack",
    );
    mode = "hold";
    const held = client.request(destination, { type: "get", operationId: operation.id }, authorize);
    await new Promise((resolve) => setTimeout(resolve, 30));
    allowed = false;
    release();
    await assert.rejects(
      held,
      (error: unknown) => error instanceof RemoteError && error.code === "denied",
    );
    allowed = true;
    mode = "stall";
    const controller = new AbortController();
    const aborted = client.request(
      destination,
      { type: "get", operationId: operation.id },
      authorize,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(aborted);
    const start = performance.now();
    await assert.rejects(
      client.request(destination, { type: "get", operationId: operation.id }, authorize),
    );
    assert.ok(
      performance.now() - start < 6500,
      "a stalled socket observes the five-second total deadline",
    );
  } finally {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.close();
    await once(server, "close");
  }
});
