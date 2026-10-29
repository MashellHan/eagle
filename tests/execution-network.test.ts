import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import WebSocket, { WebSocketServer } from "ws";
import { executionWatch } from "../packages/agent/execution-service.ts";
import { FileGrants } from "../packages/agent/file-grants.ts";
import {
  ExecutionServerMessageSchema,
  ExecutionStatusSchema,
} from "../packages/contracts/src/execution.ts";
import { herdrFixture } from "./fixtures/herdr-fixture.ts";

const owner = "isolated-execution-owner-at-least-32-characters";
const tokens = {
  "exec-mac": "isolated-execution-machine-at-least-32-characters",
  "offline-mac": "isolated-offline-machine-at-least-32-characters",
  "deadline-mac": "isolated-deadline-machine-at-least-32-characters",
  "kind-mac": "isolated-response-kind-machine-at-least-32-characters",
  "retired-mac": "isolated-retired-connection-at-least-32-characters",
  "file-mac": "isolated-file-network-at-least-32-characters",
  "herdr-mac": "isolated-herdr-network-at-least-32-characters",
};
const root = mkdtempSync(join(tmpdir(), "eagle-execution-network-"));
const processes = new Set<ChildProcess>();
const sockets = new Set<WebSocket>();
let mf: Miniflare;
let base: URL;
let agentLog = "";
let proxy: Server;
let upgrades: WebSocketServer;
let acceptedConnections = 0;
let occupiedConnections = 0;
const links: { client: WebSocket; upstream: WebSocket; hold: boolean }[] = [];

async function agentProxy() {
  proxy = createServer((_request, response) => response.writeHead(404).end());
  upgrades = new WebSocketServer({ noServer: true });
  proxy.on("upgrade", (request, socket, head) => {
    const target = new URL(request.url ?? "/", base);
    target.protocol = "ws:";
    const upstream = new WebSocket(target, {
      headers: {
        Authorization: request.headers.authorization ?? "",
        "X-Eagle-Machine": String(request.headers["x-eagle-machine"] ?? ""),
      },
    });
    upstream.on("error", () => {});
    upstream.once("unexpected-response", (_request, response) => {
      if (response.statusCode === 409) occupiedConnections++;
      socket.end(
        `HTTP/1.1 ${response.statusCode} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      response.resume();
      upstream.terminate();
    });
    upstream.once("open", () =>
      upgrades.handleUpgrade(request, socket, head, (client) => {
        const link = { client, upstream, hold: false };
        links.push(link);
        acceptedConnections++;
        client.on("error", () => {});
        client.on("message", (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN)
            upstream.send(data, { binary });
        });
        upstream.on("message", (data, binary) => {
          if (client.readyState === WebSocket.OPEN)
            client.send(data, { binary });
        });
        client.on("close", () => {
          if (!link.hold) upstream.terminate();
        });
        upstream.on("close", (code) => {
          if (client.readyState === WebSocket.OPEN)
            client.close([1005, 1006, 1015].includes(code) ? 1000 : code);
        });
      }),
    );
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

before(async () => {
  const scriptPath = join(root, "worker.mjs");
  // Exercise the production execution route and real MachineState DO directly.
  // This slice does not replace the full Worker entry or any unavailable AI SDK.
  await build({
    stdin: {
      contents: `import { executionRoute } from ${JSON.stringify(resolve("apps/web/src/worker/execution-route.ts"))};
        import { MachineState as ProductionMachineState } from ${JSON.stringify(resolve("apps/web/src/worker/machine.ts"))};
        export class MachineState extends ProductionMachineState {
          delayed = null;
          delayNextClose() { this.ctx.storage.kv.put('fixture-delay-close', true); }
          delayedCloseReady() { return this.delayed !== null; }
          webSocketClose(socket, code, reason) {
            if (socket.deserializeAttachment().role === 'agent' && this.ctx.storage.kv.get('fixture-delay-close')) {
              this.ctx.storage.kv.delete('fixture-delay-close');
              this.delayed = {socket, code, reason};
              this.ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 6000)));
              return;
            }
            super.webSocketClose(socket, code, reason);
          }
          releaseDelayedClose() {
            const event = this.delayed; this.delayed = null;
            if (event) super.webSocketClose(event.socket, event.code, event.reason);
          }
        }
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === '/fixture/revoke') {
            await env.MACHINES.getByName('exec-mac').configure('exec-mac', 'revoke');
            return new Response(null, {status:204});
          }
          const path = new URL(request.url).pathname;
          if (path.startsWith('/fixture/close/')) {
            const machine = env.MACHINES.getByName('retired-mac');
            if (path.endsWith('/delay')) await machine.delayNextClose();
            if (path.endsWith('/release')) await machine.releaseDelayedClose();
            return Response.json({ready: await machine.delayedCloseReady()});
          }
          return await executionRoute(request, env) ?? new Response(null, {status:404});
        }};`,
      resolveDir: process.cwd(),
      sourcefile: "execution-fixture.ts",
      loader: "ts",
    },
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
  });
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "execution-network",
          modules: true,
          script: readFileSync(scriptPath, "utf8"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            MACHINES: { className: "MachineState", useSQLite: true },
          },
          bindings: {
            OWNER_TOKEN: owner,
            AGENT_TOKENS: JSON.stringify(tokens),
            LOCAL_DEV: "false",
          },
        },
      ],
    }),
    resourcePersistencePath: join(root, "cloud"),
    isolatedResourcePersistencePath: join(root, "cloud"),
  });
  base = await mf.ready;
  const agentURL = await agentProxy();
  const directory = join(root, "agent");
  mkdirSync(directory, { mode: 0o700 });
  const configPath = join(directory, "agent.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      url: agentURL,
      machineId: "exec-mac",
      machineName: "Execution test Mac",
      token: tokens["exec-mac"],
      execution: { commands: true, workingDirectory: directory },
    }),
    { mode: 0o600 },
  );
  const agent = spawn(
    process.execPath,
    [resolve("packages/agent/cli.ts"), "serve"],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, EAGLE_CONFIG: configPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.add(agent);
  agent.stdout?.on("data", (chunk: Buffer) => {
    agentLog = (agentLog + chunk.toString()).slice(-16384);
  });
  agent.stderr?.on("data", (chunk: Buffer) => {
    agentLog = (agentLog + chunk.toString()).slice(-16384);
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await status("exec-mac")).online) return;
    if (agent.exitCode !== null) break;
    await delay(25);
  }
  assert.fail(`Standalone Agent did not become ready: ${agentLog}`);
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  for (const link of links) {
    link.client.terminate();
    link.upstream.terminate();
  }
  for (const process of processes) {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGTERM");
      const timer = setTimeout(() => process.kill("SIGKILL"), 2500);
      await once(process, "exit");
      clearTimeout(timer);
    }
  }
  if (proxy)
    await new Promise<void>((resolveClose) =>
      proxy.close(() => resolveClose()),
    );
  upgrades?.close();
  try {
    await mf?.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function status(machine: string) {
  const response = await fetch(
    new URL(`/api/v1/execution/status?machine=${machine}`, base),
    {
      headers: { Authorization: `Bearer ${owner}` },
    },
  );
  assert.equal(response.status, 200);
  return ExecutionStatusSchema.parse(await response.json());
}

async function connect(
  machine = "exec-mac",
  headers: Record<string, string> = { Authorization: `Bearer ${owner}` },
) {
  const url = new URL(`/api/v1/execution?machine=${machine}`, base);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers, handshakeTimeout: 3000 });
  sockets.add(socket);
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (data) =>
    messages.push(ExecutionServerMessageSchema.parse(JSON.parse(String(data)))),
  );
  socket.on("error", () => {});
  const outcome = await new Promise<number>((resolveStatus) => {
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "ping" }));
      resolveStatus(101);
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolveStatus(response.statusCode ?? 0);
    });
    socket.once("error", () => resolveStatus(0));
  });
  return {
    socket,
    outcome,
    async request(value: Record<string, unknown>) {
      socket.send(JSON.stringify(value));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(
          (message) => message.requestId === value.requestId,
        );
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(10);
      }
      assert.fail("No bounded execution reply");
    },
  };
}

const operation = (id: string, program: string, args: string[]) => ({
  id,
  machineId: "exec-mac",
  tool: "command.exec",
  program,
  args,
});

test("real WS Herdr setup uses shared admission, selected session and live capabilities without command permission", {
  timeout: 12_000,
}, async (t) => {
  const f = herdrFixture(t);
  const stop = new AbortController();
  const work = executionWatch(
    {
      url: base.origin,
      machineId: "herdr-mac",
      machineName: "Herdr fixture",
      token: tokens["herdr-mac"],
      intervalSeconds: 30,
    },
    {
      journalPath: join(f.directory, "execution", "operations.sqlite"),
      commands: false,
      workingDirectory: ".",
      herdr: { configPath: f.configPath, binaryCandidates: [f.binary] },
    },
    stop.signal,
  );
  try {
    const deadline = Date.now() + 3000;
    while (!(await status("herdr-mac")).online && Date.now() < deadline)
      await delay(20);
    const viewer = await connect("herdr-mac");
    const probe = await viewer.request({
      type: "run",
      requestId: "probe",
      operation: {
        id: "herdr-probe",
        machineId: "herdr-mac",
        tool: "herdr.setup",
        action: "probe",
      },
    });
    assert.equal(probe.type, "result");
    const initial = JSON.parse((probe.operation as { stdout: string }).stdout);
    assert.equal(initial.state, "disabled");
    const operation = {
      id: "herdr-configure",
      machineId: "herdr-mac",
      tool: "herdr.setup",
      action: "configure",
      session: "work",
      enabled: true,
      expectedRevision: initial.revision,
    };
    const configured = await viewer.request({
      type: "run",
      requestId: "configure",
      operation,
    });
    assert.equal(configured.type, "result");
    const ready = JSON.parse(
      (configured.operation as { stdout: string }).stdout,
    );
    assert.equal(ready.state, "ready");
    assert.deepEqual(ready.checks, {
      cli: true,
      server: true,
      session: true,
      tools: true,
    });
    const same = await viewer.request({
      type: "run",
      requestId: "retry",
      operation,
    });
    assert.deepEqual(same.operation, configured.operation);
    assert.equal(
      (await status("herdr-mac")).capabilities?.herdr?.state,
      "ready",
    );
    const inspector = await viewer.request({
      type: "run",
      requestId: "inspect",
      operation: {
        id: "herdr-inspect",
        machineId: "herdr-mac",
        tool: "herdr.inspect",
        action: "agents",
        session: "work",
        expectedRevision: ready.revision,
      },
    });
    assert.equal(
      JSON.parse((inspector.operation as { stdout: string }).stdout).result
        .agents[0].name,
      "fixture-worker",
    );
    writeFileSync(
      f.binary,
      readFileSync(f.binary, "utf8").replace(
        "name:'fixture-worker',pane_id:",
        "name:'fixture-worker',title:'API_KEY=fixture-secret',old:'API_KEY=[REDACTED]',pane_id:",
      ),
    );
    const filtered = await viewer.request({
      type: "run",
      requestId: "filtered",
      operation: {
        id: "herdr-filtered",
        machineId: "herdr-mac",
        tool: "herdr.inspect",
        action: "agents",
        session: "work",
        expectedRevision: ready.revision,
      },
    });
    assert.equal(filtered.type, "result");
    const filteredJSON = JSON.parse(
      (filtered.operation as { stdout: string }).stdout,
    );
    assert.equal(filteredJSON.result.agents[0].title, "[REDACTED]");
    assert.equal(filteredJSON.result.agents[0].old, "[REDACTED]");
    assert.equal((await status("herdr-mac")).online, true);
    const filteredHistory = await viewer.request({
      type: "get",
      requestId: "filtered-history",
      operationId: "herdr-filtered",
    });
    assert.deepEqual(filteredHistory.operation, filtered.operation);
    const command = await viewer.request({
      type: "run",
      requestId: "command",
      operation: {
        id: "herdr-command",
        machineId: "herdr-mac",
        tool: "command.exec",
        program: "/usr/bin/true",
        args: [],
      },
    });
    assert.equal(command.code, "disabled");
    const disabled = await viewer.request({
      type: "run",
      requestId: "disable",
      operation: {
        id: "herdr-disable",
        machineId: "herdr-mac",
        tool: "herdr.setup",
        action: "disable",
        expectedRevision: ready.revision,
      },
    });
    assert.equal(
      JSON.parse((disabled.operation as { stdout: string }).stdout).state,
      "disabled",
    );
    const history = await viewer.request({
      type: "get",
      requestId: "history",
      operationId: "herdr-configure",
    });
    assert.deepEqual(history.operation, configured.operation);
    viewer.socket.terminate();
  } finally {
    stop.abort();
    await work;
  }
});

test("real WS file execution obeys local grants with commands disabled and hides revoked cached results", async () => {
  const directory = join(root, "file-agent");
  const allowed = join(root, "file-documents");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(allowed);
  writeFileSync(join(allowed, "text.txt"), "remote file result");
  const configPath = join(directory, "agent.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      url: base.origin,
      machineId: "file-mac",
      machineName: "File Mac",
      token: tokens["file-mac"],
      execution: {
        commands: false,
        workingDirectory: "/unused/missing/command-directory",
      },
    }),
    { mode: 0o600 },
  );
  const grants = new FileGrants(configPath);
  const grant = grants.grant({ root: allowed, name: "Documents" });
  const agent = spawn(
    process.execPath,
    [resolve("packages/agent/cli.ts"), "serve"],
    {
      env: { PATH: "/usr/bin:/bin", EAGLE_CONFIG: configPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.add(agent);
  agent.stdout?.resume();
  agent.stderr?.resume();
  const readyBy = Date.now() + 5000;
  while (!(await status("file-mac")).online && Date.now() < readyBy)
    await delay(10);
  assert.equal((await status("file-mac")).online, true);
  const viewer = await connect("file-mac");
  const file = {
    id: "remote-file-once",
    machineId: "file-mac",
    tool: "file.read",
    grantId: grant.id,
    generation: grant.generation,
    path: "text.txt",
  };
  const result = await viewer.request({
    type: "run",
    requestId: "file-first",
    operation: file,
  });
  assert.deepEqual(result.operation, {
    id: file.id,
    state: "succeeded",
    stdout: "remote file result",
    stderr: "",
    exitCode: null,
  });
  writeFileSync(join(allowed, "text.txt"), "changed content");
  assert.deepEqual(
    (
      await viewer.request({
        type: "run",
        requestId: "file-retry",
        operation: file,
      })
    ).operation,
    result.operation,
  );
  const disabled = await viewer.request({
    type: "run",
    requestId: "command-disabled",
    operation: {
      id: "file-mac-command",
      machineId: "file-mac",
      tool: "command.exec",
      program: "/usr/bin/printf",
      args: ["not run"],
    },
  });
  assert.equal(disabled.code, "disabled");
  grants.revoke(grant.id);
  assert.equal(
    (
      await viewer.request({
        type: "get",
        requestId: "revoked-query",
        operationId: file.id,
      })
    ).code,
    "denied",
  );
  assert.equal(
    (
      await viewer.request({
        type: "run",
        requestId: "revoked-retry",
        operation: file,
      })
    ).code,
    "denied",
  );
  const renewed = grants.grant({ root: allowed, name: "Documents" });
  assert.equal(
    (
      await viewer.request({
        type: "run",
        requestId: "new-grant-old-id",
        operation: {
          ...file,
          grantId: renewed.id,
          generation: renewed.generation,
        },
      })
    ).code,
    "conflict",
  );
  viewer.socket.close();
});

async function faultPeer(machine: keyof typeof tokens) {
  const url = new URL("/api/v1/execution-agent", base);
  url.protocol = "ws:";
  const peer = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${tokens[machine]}`,
      "X-Eagle-Machine": machine,
    },
  });
  sockets.add(peer);
  peer.on("error", () => {});
  await once(peer, "open");
  peer.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      machineId: machine,
      instanceId: randomUUID(),
      agentVersion: "isolated-fault-peer",
      capabilities: { commands: false },
    }),
  );
  const heartbeat = setInterval(() => {
    if (peer.readyState === WebSocket.OPEN)
      peer.send(JSON.stringify({ type: "ping" }));
  }, 500);
  peer.once("close", () => clearInterval(heartbeat));
  const deadline = Date.now() + 1000;
  while (!(await status(machine)).online && Date.now() < deadline)
    await delay(5);
  assert.equal((await status(machine)).online, true);
  return peer;
}

function closedWithin(socket: WebSocket, timeout: number): Promise<number> {
  return new Promise((resolveClose, reject) => {
    const done = (code: number) => {
      clearTimeout(timer);
      resolveClose(code);
    };
    const timer = setTimeout(() => {
      socket.off("close", done);
      reject(new Error("Connection did not close within deadline"));
    }, timeout);
    socket.once("close", done);
  });
}

test("a separate no-Herdr Agent advertises actual command capability without a collector report", async () => {
  const current = await status("exec-mac");
  assert.equal(current.online, true);
  assert.equal(current.capabilities?.commands, true);
  assert(current.agentVersion);
  assert.equal((await status("offline-mac")).online, false);
  assert.equal((await status("offline-mac")).capabilities, null);
  for (const secret of [owner, ...Object.values(tokens)])
    assert.equal(agentLog.includes(secret), false);
});

test("production execution authentication rejects machine-as-owner, wrong machine binding and bad Origin", async () => {
  assert.equal(
    (
      await connect("exec-mac", {
        Authorization: `Bearer ${tokens["exec-mac"]}`,
      })
    ).outcome,
    401,
  );
  assert.equal(
    (await connect("exec-mac", { Authorization: "Bearer wrong" })).outcome,
    401,
  );
  assert.equal(
    (
      await connect("exec-mac", {
        Authorization: `Bearer ${owner}`,
        Origin: "https://other.test",
      })
    ).outcome,
    403,
  );
  const response = await mf.dispatchFetch(
    "https://eagle.test/api/v1/execution-agent",
    {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${tokens["exec-mac"]}`,
        "X-Eagle-Machine": "offline-mac",
      },
    },
  );
  assert.equal(response.status, 403);
  const ingest = await mf.dispatchFetch(
    "https://eagle-ingest.hexly.ai/api/v1/execution?machine=exec-mac",
    {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${owner}` },
    },
  );
  assert.equal(ingest.status, 404);
});

test("real HTTP/WS routing returns actual exit status and retries never repeat a file effect", async () => {
  const client = await connect();
  assert.equal(client.outcome, 101);
  const input = operation("network-once", "/bin/sh", [
    "-c",
    "printf x >> network-effect; printf actual; printf err >&2; exit 7",
  ]);
  const first = await client.request({
    type: "run",
    requestId: "run-first",
    operation: input,
  });
  assert.equal(first.type, "result");
  assert.deepEqual(first.operation, {
    id: input.id,
    state: "failed",
    stdout: "actual",
    stderr: "err",
    exitCode: 7,
  });
  const repeat = await client.request({
    type: "run",
    requestId: "run-repeat",
    operation: input,
  });
  assert.deepEqual(repeat.operation, first.operation);
  assert.equal(readFileSync(join(root, "agent/network-effect"), "utf8"), "x");
  const conflict = await client.request({
    type: "run",
    requestId: "run-conflict",
    operation: { ...input, args: ["different"] },
  });
  assert.equal(conflict.code, "conflict");
  client.socket.close();
});

test("offline machine operations are rejected without falling back to the online machine", async () => {
  const client = await connect("offline-mac");
  assert.equal(client.outcome, 101);
  const result = await client.request({
    type: "run",
    requestId: "offline",
    operation: {
      ...operation("offline-op", "/bin/sh", [
        "-c",
        "printf bad > offline-effect",
      ]),
      machineId: "offline-mac",
    },
  });
  assert.equal(result.code, "offline");
  assert.equal(existsSync(join(root, "agent/offline-effect")), false);
  client.socket.close();
});

test("lost viewer connection is reconciled by querying the original durable operation", async () => {
  const first = await connect();
  const input = operation("lost-result", process.execPath, [
    "-e",
    "const fs=require('node:fs');fs.appendFileSync('lost-effect','x');setTimeout(()=>process.stdout.write('done'),250)",
  ]);
  first.socket.send(
    JSON.stringify({
      type: "run",
      requestId: "lost-request",
      operation: input,
    }),
  );
  const deadline = Date.now() + 2000;
  while (!existsSync(join(root, "agent/lost-effect")) && Date.now() < deadline)
    await delay(10);
  assert.equal(existsSync(join(root, "agent/lost-effect")), true);
  first.socket.terminate();
  await delay(300);
  const next = await connect();
  const result = await next.request({
    type: "get",
    requestId: "reconcile",
    operationId: input.id,
  });
  assert.deepEqual(result.operation, {
    id: input.id,
    state: "succeeded",
    stdout: "done",
    stderr: "",
    exitCode: 0,
  });
  assert.equal(readFileSync(join(root, "agent/lost-effect"), "utf8"), "x");
  next.socket.close();
});

test("remote cancellation signals a real process and retains unknown outcome", async () => {
  const client = await connect();
  const input = operation("network-cancel", process.execPath, [
    "-e",
    "require('node:fs').writeFileSync('cancel-ready','1');setInterval(()=>{},1000)",
  ]);
  const running = client.request({
    type: "run",
    requestId: "cancel-run",
    operation: input,
  });
  const deadline = Date.now() + 2000;
  while (!existsSync(join(root, "agent/cancel-ready")) && Date.now() < deadline)
    await delay(10);
  assert.equal(existsSync(join(root, "agent/cancel-ready")), true);
  const ack = await client.request({
    type: "cancel",
    requestId: "cancel-request",
    operationId: input.id,
  });
  assert.equal(ack.requested, true);
  const result = await running;
  assert.equal((result.operation as { state: string }).state, "unknown");
  client.socket.close();
});

test("legal prototype-shaped request IDs keep their own routing entry and receive real results", async () => {
  const client = await connect();
  for (const requestId of ["__proto__", "constructor", "toString"]) {
    const result = await client.request({
      type: "run",
      requestId,
      operation: operation(`reserved-${requestId}`, "/usr/bin/printf", [
        "routed",
      ]),
    });
    assert.equal(result.type, "result");
    assert.equal((result.operation as { stdout: string }).stdout, "routed");
  }
  assert.equal((await status("exec-mac")).online, true);
  client.socket.close();
});

test("Agent network loss and a real temporary 409 preserve running work through reconnection", async () => {
  const client = await connect();
  const input = operation("agent-network-loss", process.execPath, [
    "-e",
    "const fs=require('node:fs');fs.appendFileSync('agent-drop-effect','x');setTimeout(()=>process.stdout.write('completed-during-drop'),2500)",
  ]);
  client.socket.send(
    JSON.stringify({ type: "run", requestId: "agent-lost", operation: input }),
  );
  const started = Date.now() + 2000;
  while (
    !existsSync(join(root, "agent/agent-drop-effect")) &&
    Date.now() < started
  )
    await delay(10);
  assert.equal(existsSync(join(root, "agent/agent-drop-effect")), true);
  const old = links.at(-1);
  assert(old);
  const connections = acceptedConnections;
  const rejections = occupiedConnections;
  old.hold = true;
  old.client.terminate();
  const release = setTimeout(() => old.upstream.terminate(), 2000);
  try {
    const deadline = Date.now() + 7000;
    while (acceptedConnections === connections && Date.now() < deadline)
      await delay(20);
    assert(
      occupiedConnections > rejections,
      "The old cloud connection must actually produce HTTP 409",
    );
    assert(
      acceptedConnections > connections,
      "Agent must reconnect after the old connection is released",
    );
    const recovered = await connect();
    const result = await recovered.request({
      type: "get",
      requestId: "after-agent-drop",
      operationId: input.id,
    });
    assert.deepEqual(result.operation, {
      id: input.id,
      state: "succeeded",
      stdout: "completed-during-drop",
      stderr: "",
      exitCode: 0,
    });
    assert.equal(
      readFileSync(join(root, "agent/agent-drop-effect"), "utf8"),
      "x",
    );
    recovered.socket.close();
  } finally {
    clearTimeout(release);
    old.upstream.terminate();
    client.socket.terminate();
  }
});

test("an Agent that keeps heartbeating but withholds a response cannot hold a viewer indefinitely", async () => {
  const peer = await faultPeer("deadline-mac");
  const client = await connect("deadline-mac");
  let forwarded = 0;
  peer.on("message", (data) => {
    if (JSON.parse(String(data)).type === "get") forwarded++;
  });
  const close = closedWithin(client.socket, 6500);
  client.socket.send(
    JSON.stringify({
      type: "get",
      requestId: "silent-request",
      operationId: "uncertain-operation",
    }),
  );
  try {
    assert.equal(await close, 4004);
    assert.equal(forwarded, 1);
    assert.equal((await status("deadline-mac")).online, true);
  } finally {
    client.socket.terminate();
    peer.terminate();
  }
});

test("a same-ID response of the wrong kind cannot settle the original request", async () => {
  const peer = await faultPeer("kind-mac");
  const client = await connect("kind-mac");
  peer.on("message", (bytes) => {
    const data = JSON.parse(String(bytes));
    if (data.type === "get")
      peer.send(
        JSON.stringify({
          type: "cancel-ack",
          clientId: data.clientId,
          requestId: data.requestId,
          operationId: data.operationId,
          requested: false,
        }),
      );
  });
  const closed = closedWithin(peer, 1500);
  client.socket.send(
    JSON.stringify({
      type: "get",
      requestId: "wrong-kind",
      operationId: "original-operation",
    }),
  );
  try {
    assert.equal(await closed, 1008);
  } finally {
    client.socket.terminate();
    peer.terminate();
  }
});

test("a delayed old Agent close event cannot close a viewer routed to its replacement", async () => {
  const old = await faultPeer("retired-mac");
  await fetch(new URL("/fixture/close/delay", base), { method: "POST" });
  old.terminate();
  const deadline = Date.now() + 1500;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = (
      (await (await fetch(new URL("/fixture/close/status", base))).json()) as {
        ready: boolean;
      }
    ).ready;
    if (!ready) await delay(10);
  }
  assert.equal(ready, true);
  const current = await faultPeer("retired-mac");
  const client = await connect("retired-mac");
  const incoming = once(current, "message");
  const result = client.request({
    type: "get",
    requestId: "current-request",
    operationId: "existing-operation",
  });
  const [data] = await incoming;
  const request = JSON.parse(String(data));
  assert.equal(request.type, "get");
  await fetch(new URL("/fixture/close/release", base), { method: "POST" });
  current.send(
    JSON.stringify({
      type: "result",
      clientId: request.clientId,
      requestId: request.requestId,
      operation: {
        id: request.operationId,
        state: "unknown",
        stdout: "",
        stderr: "",
        exitCode: null,
      },
    }),
  );
  try {
    assert.equal((await result).type, "result");
    assert.equal(client.socket.readyState, WebSocket.OPEN);
  } finally {
    client.socket.terminate();
    current.terminate();
  }
});

test("duplicate pending request IDs require reconciliation instead of ambiguously rejecting the first run", async () => {
  const client = await connect();
  const replies: unknown[] = [];
  client.socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.requestId === "same-pending-id") replies.push(message);
  });
  const original = operation("duplicate-pending-original", process.execPath, [
    "-e",
    "const fs=require('node:fs');fs.appendFileSync('duplicate-original','x');setTimeout(()=>process.stdout.write('original-result'),600)",
  ]);
  const close = closedWithin(client.socket, 1500);
  client.socket.send(
    JSON.stringify({
      type: "run",
      requestId: "same-pending-id",
      operation: original,
    }),
  );
  const started = Date.now() + 1000;
  while (
    !existsSync(join(root, "agent/duplicate-original")) &&
    Date.now() < started
  )
    await delay(10);
  assert.equal(existsSync(join(root, "agent/duplicate-original")), true);
  client.socket.send(
    JSON.stringify({
      type: "run",
      requestId: "same-pending-id",
      operation: operation("duplicate-pending-other", "/bin/sh", [
        "-c",
        "printf bad > duplicate-other",
      ]),
    }),
  );
  try {
    assert.equal(await close, 4004);
    assert.deepEqual(replies, []);
    await delay(750);
    const recovered = await connect();
    const result = await recovered.request({
      type: "get",
      requestId: "query-original",
      operationId: original.id,
    });
    assert.equal(
      (result.operation as { stdout: string }).stdout,
      "original-result",
    );
    assert.equal(
      readFileSync(join(root, "agent/duplicate-original"), "utf8"),
      "x",
    );
    assert.equal(existsSync(join(root, "agent/duplicate-other")), false);
    recovered.socket.close();
  } finally {
    client.socket.terminate();
  }
});

test("real registration revocation closes execution channels and rejects the old machine identity", async () => {
  const client = await connect();
  const closed = once(client.socket, "close");
  assert.equal(
    (await fetch(new URL("/fixture/revoke", base), { method: "POST" })).status,
    204,
  );
  const [code] = await closed;
  assert.equal(code, 4001);
  const response = await mf.dispatchFetch(
    "https://eagle.test/api/v1/execution-agent",
    {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${tokens["exec-mac"]}`,
        "X-Eagle-Machine": "exec-mac",
      },
    },
  );
  assert.equal(response.status, 401);
});
