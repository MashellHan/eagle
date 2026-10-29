import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type WebSocket, WebSocketServer } from "ws";
import { executionWatch } from "../packages/agent/execution-service.ts";
import { FileGrants } from "../packages/agent/file-grants.ts";
import { FileProvider } from "../packages/agent/file-provider.ts";
import { OperationJournal } from "../packages/agent/operation-journal.ts";

test("failed runner construction releases the journal before the service returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "eagle-service-init-"));
  const journalPath = join(root, "private", "operations.sqlite");
  try {
    await assert.rejects(
      executionWatch(
        {
          url: "http://127.0.0.1:1",
          machineId: "constructor-test",
          machineName: "Constructor test",
          token: "isolated-construction-credential-at-least-32-characters",
          intervalSeconds: 30,
        },
        {
          journalPath,
          commands: true,
          workingDirectory: join(root, "does-not-exist"),
        },
        AbortSignal.abort(),
      ),
    );
    const reopened = new OperationJournal(journalPath);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two real WS callers share one file read and both lose access when its grant is revoked before delivery", {
  timeout: 6000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eagle-file-waiters-")));
  const privateRoot = join(root, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  const documents = join(root, "documents");
  mkdirSync(documents);
  const configPath = join(privateRoot, "agent.json");
  const journalPath = join(privateRoot, "operations.sqlite");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const original = FileProvider.prototype.run;
  let watch: Promise<void> | undefined;
  let release = () => {};
  let socket: WebSocket | undefined;
  const messages: {
    type: string;
    requestId?: string;
    code?: string;
    operation?: { state: string; stdout: string };
  }[] = [];
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Bounded waiter deadline");
      await delay(5);
    }
  };
  try {
    await once(server, "listening");
    const config = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      machineId: "waiter-mac",
      machineName: "Waiter fixture",
      token: "isolated-waiter-machine-at-least-32-characters",
      intervalSeconds: 30,
    };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(documents, "held.txt"), "protected fixture content");
    const authority = new FileGrants(configPath);
    const grant = authority.grant({ root: documents, name: "Documents" });
    let completed = false;
    let reads = 0;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    FileProvider.prototype.run = async function (request, signal) {
      reads++;
      const result = await original.call(this, request, signal);
      completed = true;
      await barrier;
      return result;
    };
    server.on("connection", (client) => {
      socket = client;
      client.on("error", () => {});
      client.on("message", (bytes) => {
        const value = JSON.parse(String(bytes));
        if (value.type === "ping")
          client.send(JSON.stringify({ type: "pong" }));
        else messages.push(value);
      });
    });
    watch = executionWatch(
      config,
      {
        journalPath,
        commands: false,
        workingDirectory: ".",
        files: { privateRoot, grants: () => authority.list() },
      },
      abort.signal,
    );
    await until(() => messages.some((message) => message.type === "hello"));
    const clientId = randomUUID();
    const operation = {
      tool: "file.read",
      id: "shared-file",
      machineId: "waiter-mac",
      grantId: grant.id,
      generation: grant.generation,
      path: "held.txt",
    };
    assert(socket);
    socket.send(
      JSON.stringify({ type: "run", clientId, requestId: "first", operation }),
    );
    await until(() => completed);
    socket.send(
      JSON.stringify({ type: "run", clientId, requestId: "second", operation }),
    );
    socket.send(
      JSON.stringify({
        type: "get",
        clientId,
        requestId: "running",
        operationId: operation.id,
      }),
    );
    await until(() =>
      messages.some((message) => message.requestId === "running"),
    );
    assert.equal(
      messages.find((message) => message.requestId === "running")?.operation
        ?.state,
      "running",
    );
    authority.revoke(grant.id);
    release();
    await until(() =>
      ["first", "second"].every((id) =>
        messages.some((message) => message.requestId === id),
      ),
    );
    for (const id of ["first", "second"]) {
      const result = messages.find((message) => message.requestId === id);
      assert.equal(result?.code, "denied");
      assert.equal(result?.operation, undefined);
    }
    assert.equal(reads, 1);
    abort.abort();
    await watch;
    const journal = new OperationJournal(journalPath);
    try {
      assert.equal(journal.get("shared-file")?.state, "failed");
      assert.equal(journal.get("shared-file")?.stdout, "");
    } finally {
      journal.close();
    }
  } finally {
    release();
    FileProvider.prototype.run = original;
    abort.abort();
    await watch?.catch(() => {});
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit extra secrets are filtered before the real file WS reply and journal persistence", {
  timeout: 5000,
}, async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "eagle-service-secrets-")),
  );
  const privateRoot = join(root, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  const documents = join(root, "documents");
  mkdirSync(documents);
  const extra = "opaque-extra-fixture-" + randomUUID();
  writeFileSync(join(documents, "text"), `before ${extra} after`);
  const journalPath = join(privateRoot, "operations.sqlite");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  let work: Promise<void> | undefined;
  try {
    await once(server, "listening");
    const response = new Promise<{
      type: string;
      operation: { stdout: string };
    }>((resolve) => {
      server.on("connection", (socket) =>
        socket.on("message", (bytes) => {
          const value = JSON.parse(String(bytes));
          if (value.type === "hello")
            socket.send(
              JSON.stringify({
                type: "run",
                requestId: "read-extra",
                clientId: randomUUID(),
                operation: {
                  tool: "file.read",
                  id: "extra-secret",
                  machineId: "extra-mac",
                  grantId: "docs",
                  generation: "one",
                  path: "text",
                },
              }),
            );
          if (value.type === "ping")
            socket.send(JSON.stringify({ type: "pong" }));
          if (value.type === "result" || value.type === "error") resolve(value);
        }),
      );
    });
    work = executionWatch(
      {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        machineId: "extra-mac",
        machineName: "Extra fixture",
        intervalSeconds: 30,
        token: "isolated-service-machine-token-at-least-32-characters",
      },
      {
        journalPath,
        commands: false,
        workingDirectory: ".",
        files: {
          privateRoot,
          grants: () => [{ id: "docs", generation: "one", root: documents }],
          secrets: [extra],
        },
      },
      controller.signal,
    );
    const value = await Promise.race([
      response,
      work.then(() => {
        throw new Error("Agent returned before result");
      }),
    ]);
    assert.equal(value.type, "result");
    assert.equal(value.operation.stdout, "before [REDACTED] after");
    controller.abort();
    await work;
    const journal = new OperationJournal(journalPath);
    try {
      assert.equal(
        journal.get("extra-secret")?.stdout,
        "before [REDACTED] after",
      );
    } finally {
      journal.close();
    }
  } finally {
    controller.abort();
    await work?.catch(() => {});
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
