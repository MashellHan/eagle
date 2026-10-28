import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { WebSocketServer } from "ws";
import { remoteExtension } from "../../src/tools/remote/tools.ts";

test("a saved remote memo with a missing target journal preserves its receipt without issuing another run", async () => {
  const server = createServer();
  const ws = new WebSocketServer({ server });
  let runs = 0;
  const queries: string[] = [];
  ws.on("connection", (client) =>
    client.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.type === "run") {
        runs += 1;
        client.send(
          JSON.stringify({
            type: "result",
            requestId: request.requestId,
            operation: {
              id: request.operation.id,
              state: "running",
              stdout: "",
              stderr: "",
              exitCode: null,
            },
          }),
        );
      } else {
        queries.push(request.operationId);
        client.send(
          JSON.stringify({
            type: "error",
            requestId: request.requestId,
            operationId: request.operationId,
            code: "not_found",
          }),
        );
      }
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const extension = remoteExtension({
    botId: "bot-a",
    receiptKey: "fixture-daemon-receipt-token-0123456789",
    read: () => ({
      namespace: "a".repeat(64),
      revision: "first-revision",
      targets: [
        {
          alias: "build-mac",
          enabled: true,
          origin: `http://127.0.0.1:${address.port}`,
          machineId: "machine-b",
          credentialRef: "fixture-ref",
          operations: ["command.exec"],
        },
      ],
    }),
    credentials: {
      read: async (binding) => ({ binding, ownerToken: "fixture-owner-0123456789-abcdefghij" }),
      status: async () => true,
      remove: async () => {},
    },
  });
  const tool = extension.tools?.find((value) => value.name === "remote_execute");
  assert.ok(tool);
  let memo: unknown;
  const api = {
    conversationId: 1,
    callId: "original-call",
    memo: async (_name: string, candidate: unknown, context?: unknown) => {
      if (context !== undefined) memo ??= candidate;
      return memo;
    },
  } as unknown as ToolExecutionApi;
  const args = {
    target: "build-mac",
    operation: { tool: "command.exec", program: "/usr/bin/printf", args: ["safe"] },
  };
  try {
    const initial = await tool.execute(args, api, BACKGROUND_CONTEXT);
    assert.equal(initial.isError, false);
    const recovered = await tool.execute(args, api, BACKGROUND_CONTEXT);
    assert.equal(runs, 1, "a missing result is not permission to repeat a side effect");
    assert.equal(queries.length, 1);
    assert.equal(recovered.isError, true);
    const output = recovered.output?.[0];
    assert.ok(output?.type === "text");
    assert.equal(JSON.parse(output.text).error, "not_found");
    assert.equal(typeof JSON.parse(output.text).receipt, "string");
  } finally {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.close();
    await once(server, "close");
  }
});
