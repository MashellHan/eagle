import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";

const root = mkdtempSync(join(tmpdir(), "eagle-native-execution-"));
const binary = join(root, "native-execution");
const token = "isolated-native-execution-owner-at-least-32-characters";
let server: Server;
let foreign: Server;
let ws: WebSocketServer;
let mode = "roundtrip";
let foreignRequests = 0;
let received = 0;
let cancelled = 0;
const observed: string[] = [];

before(async () => {
  const supported = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk";
  const sdk =
    process.env.EAGLE_TEST_SDK ??
    (existsSync(supported)
      ? supported
      : spawnSync("xcrun", ["--show-sdk-path"], {
          encoding: "utf8",
        }).stdout.trim());
  const compiled = spawnSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-sdk",
      sdk,
      "-parse-as-library",
      resolve(
        "apps/macos/Sources/EagleFeatures/Machines/MachineConnection.swift",
      ),
      resolve(
        "apps/macos/Sources/EagleFeatures/Machines/MachineExecution.swift",
      ),
      resolve("tests/fixtures/native-execution.swift"),
      "-o",
      binary,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  foreign = createServer((_request, response) => {
    foreignRequests++;
    response.end();
  });
  foreign.on("upgrade", (_request, socket) => {
    foreignRequests++;
    socket.end();
  });
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  ws = new WebSocketServer({ noServer: true });
  server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(
      request.headers["cf-access-client-id"],
      "isolated-native-exec-access-id",
    );
    assert.equal(
      request.headers["cf-access-client-secret"],
      "isolated-native-exec-access-secret",
    );
    assert.equal(request.url, "/api/v1/execution?machine=native-mac");
    received++;
    if (mode === "authentication") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "redirect") {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${(foreign.address() as AddressInfo).port}/foreign\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    ws.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => {});
      client.on("message", (bytes) => {
        assert.equal(String(bytes).includes(token), false);
        const message = JSON.parse(String(bytes));
        if (message.type === "ping") {
          client.send(JSON.stringify({ type: "pong" }));
          return;
        }
        observed.push(message.type);
        if (message.type === "cancel") cancelled++;
        if (mode === "cancelled") return;
        if (mode === "invalid") {
          client.send(
            JSON.stringify({
              type: "result",
              requestId: message.requestId,
              operation: {
                id: "wrong-identity",
                state: "succeeded",
                stdout: "bad",
                stderr: "",
                exitCode: 0,
              },
            }),
          );
          return;
        }
        if (mode === "secret") {
          client.send(
            JSON.stringify({
              type: "result",
              requestId: message.requestId,
              operation: {
                id: "native-operation",
                state: "succeeded",
                stdout: token,
                stderr: "",
                exitCode: 0,
              },
            }),
          );
          return;
        }
        if (mode === "oversize") {
          client.send("x".repeat(530_000));
          return;
        }
        if (mode === "bad-capability")
          client.send(
            JSON.stringify({
              type: "status",
              machineId: "native-mac",
              online: true,
              agentVersion: "1.1.0-alpha.2",
              observedAt: "2026-10-28T08:00:00.000Z",
              capabilities: {
                commands: false,
                herdr: {
                  state: "ready",
                  enabled: false,
                  installed: true,
                  version: null,
                  session: null,
                  revision: "one",
                  sessions: [],
                  checks: {
                    cli: true,
                    server: false,
                    session: null,
                    tools: null,
                  },
                  observedAt: null,
                },
              },
            }),
          );
        const value =
          message.type === "cancel"
            ? {
                type: "cancel-ack",
                requestId: message.requestId,
                operationId: "native-operation",
                requested: true,
              }
            : {
                type: "result",
                requestId: message.requestId,
                operation: {
                  id: "native-operation",
                  state: "succeeded",
                  stdout: "actual machine result",
                  stderr: "",
                  exitCode: 0,
                },
              };
        client.send(JSON.stringify(value));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
});
after(async () => {
  for (const client of ws?.clients ?? []) client.terminate();
  ws?.close();
  for (const s of [server, foreign])
    if (s) await new Promise<void>((done) => s.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});
async function invoke(value: string) {
  mode = value;
  const process = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  process.stdout.on("data", (part) => {
    output += part;
  });
  process.stderr.on("data", (part) => {
    output += part;
  });
  process.stdin.end(
    JSON.stringify({
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token,
      mode,
    }),
  );
  const timer = setTimeout(() => process.kill("SIGKILL"), 10_000);
  const [code] = await once(process, "exit");
  clearTimeout(timer);
  assert.equal(output.includes(token), false);
  assert.equal(code, 0, output);
  assert.match(output, /native-execution-pass/);
}
test("native URLSession WS sends header-only credentials and exchanges actual run/get/cancel replies", async () => {
  await invoke("roundtrip");
  assert.deepEqual(observed, ["run", "get", "cancel"]);
});
test("native WS recognizes real authentication failure and refuses cross-origin redirect", async () => {
  await invoke("authentication");
  await invoke("redirect");
  assert.equal(foreignRequests, 0);
});
test("native WS refuses wrong operation identity, secret and oversized output", async () => {
  for (const value of ["invalid", "secret", "oversize", "bad-capability"])
    await invoke(value);
});
test("closing a native caller does not send remote cancellation or replay", async () => {
  const before = received;
  const cancels = cancelled;
  await invoke("cancelled");
  assert.equal(received, before + 1);
  assert.equal(cancelled, cancels);
});
