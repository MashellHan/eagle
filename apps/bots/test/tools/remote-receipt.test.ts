import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { WebSocketServer } from "ws";
import { remoteExtension } from "../../src/tools/remote/tools.ts";

test("a forged receipt cannot relabel an old operation as a new grant before real WS cancel", async () => {
  const server = createServer();
  const ws = new WebSocketServer({ server });
  let cancels = 0;
  ws.on("connection", (client) =>
    client.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.type === "cancel") {
        cancels += 1;
        client.send(
          JSON.stringify({
            type: "cancel-ack",
            requestId: request.requestId,
            operationId: request.operationId,
            requested: true,
          }),
        );
      } else {
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
      }
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let revision = "first-revision";
  let reference = "first-credential";
  let alias = "build-mac";
  const extension = remoteExtension({
    botId: "bot-a",
    receiptKey: "fixture-daemon-private-receipt-key-0123456789",
    read: () => ({
      namespace: "a".repeat(64),
      revision,
      targets: [
        {
          alias,
          enabled: true,
          origin: `http://127.0.0.1:${address.port}`,
          machineId: "machine-b",
          credentialRef: reference,
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
  const run = extension.tools?.find((tool) => tool.name === "remote_execute");
  const control = extension.tools?.find((tool) => tool.name === "remote_operation");
  assert.ok(run && control);
  let memo: unknown;
  const api = {
    conversationId: 1,
    callId: "original-call",
    memo: async (_name: string, candidate: unknown, context?: unknown) => {
      if (context !== undefined) memo ??= candidate;
      return memo;
    },
  } as unknown as ToolExecutionApi;
  try {
    const initial = await run.execute(
      {
        target: alias,
        operation: { tool: "command.exec", program: "/usr/bin/printf", args: ["safe"] },
      },
      api,
      BACKGROUND_CONTEXT,
    );
    const output = initial.output?.[0];
    assert.ok(output?.type === "text");
    const receipt = JSON.parse(output.text).receipt as string;
    const [payload, mac] = receipt.split(".");
    assert.ok(payload);
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const valid = await control.execute(
      { receipt, action: "cancel" },
      { ...api, conversationId: 2 } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    assert.equal(
      valid.isError,
      false,
      "the documented permission boundary is the Bot, not the conversation",
    );
    assert.equal(cancels, 1);
    revision = "new-revision";
    reference = "new-credential";
    alias = "new-alias";
    const forged =
      Buffer.from(JSON.stringify({ ...raw, revision, credentialRef: reference, alias })).toString(
        "base64url",
      ) + (mac === undefined ? "" : `.${mac}`);
    const rejected = await control.execute(
      { receipt: forged, action: "cancel" },
      api,
      BACKGROUND_CONTEXT,
    );
    assert.equal(cancels, 1, "tampering must be rejected before sending a remote mutation");
    assert.equal(rejected.isError, true);
    const stale = await control.execute({ receipt, action: "cancel" }, api, BACKGROUND_CONTEXT);
    assert.equal(stale.isError, true);
    assert.equal(cancels, 1);
  } finally {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.close();
    await once(server, "close");
  }
});
