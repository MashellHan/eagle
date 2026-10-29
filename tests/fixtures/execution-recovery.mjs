// Retained real integration evidence: production issueToken/DO/route, hibernation, SIGKILL, rotation.
// No full Worker entry, D1 registration or Access edge is substituted here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(repository, "package.json"));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const WebSocket = require("ws");
const owner = "parent-recovery-fixture-owner-at-least-32-characters";
let token;
const issuedTokens = [];
const signingKey = "parent-managed-signing-fixture-at-least-32-characters";
const root =
  process.argv[2] || mkdtempSync(join(tmpdir(), "eagle-retained-recovery-"));
const directory = join(root, "agent");
mkdirSync(directory, { mode: 0o700 });
let mf;
let base;
let log = "";
const children = new Set();
const sockets = new Set();

async function until(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Timed out: " + label);
}
async function status() {
  const response = await fetch(
    new URL("/api/v1/execution/status?machine=macb", base),
    { headers: { Authorization: `Bearer ${owner}` } },
  );
  assert.equal(response.status, 200);
  return response.json();
}
function start() {
  const child = spawn(
    process.execPath,
    [join(repository, "packages/agent/cli.ts"), "serve"],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        EAGLE_CONFIG: join(directory, "agent.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  child.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-16000);
  });
  child.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-16000);
  });
  return child;
}
async function viewer() {
  const url = new URL("/api/v1/execution?machine=macb", base);
  url.protocol = "ws:";
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${owner}` },
  });
  sockets.add(ws);
  ws.on("error", () => {});
  const messages = [];
  ws.on("message", (bytes) => messages.push(JSON.parse(String(bytes))));
  await once(ws, "open");
  return {
    ws,
    async request(value) {
      ws.send(JSON.stringify(value));
      await until(
        () => messages.some((x) => x.requestId === value.requestId),
        "operation reply " + value.requestId,
      );
      return messages.find((x) => x.requestId === value.requestId);
    },
  };
}
try {
  const worker = join(root, "worker.mjs");
  await build({
    stdin: {
      contents: `
    import { executionRoute } from ${JSON.stringify(join(repository, "apps/web/src/worker/execution-route.ts"))};
    import { MachineState as Base } from ${JSON.stringify(join(repository, "apps/web/src/worker/machine.ts"))};
    import { issueToken } from ${JSON.stringify(join(repository, "apps/web/src/worker/auth.ts"))};
    export class MachineState extends Base {
      generation = crypto.randomUUID();
      bootId() { return this.generation; }
    }
    export default { async fetch(request, env) {
      if (['/fixture/create', '/fixture/rotate'].includes(new URL(request.url).pathname)) {
        const action = new URL(request.url).pathname.endsWith('create') ? 'create' : 'rotate';
        const machine = await env.MACHINES.getByName('macb').configure('macb', action, 'Managed fixture');
        return Response.json({token:await issueToken(machine, env)});
      }
      if (new URL(request.url).pathname === '/fixture/boot') return Response.json({id:await env.MACHINES.getByName('macb').bootId()});
      return await executionRoute(request, env) ?? new Response(null, {status:404});
    }};`,
      resolveDir: repository,
      loader: "ts",
      sourcefile: "parent-recovery-fixture.ts",
    },
    outfile: worker,
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
          name: "parent-recovery",
          modules: true,
          script: readFileSync(worker, "utf8"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            MACHINES: { className: "MachineState", useSQLite: true },
          },
          bindings: {
            OWNER_TOKEN: owner,
            AGENT_SIGNING_KEY: signingKey,
            LOCAL_DEV: "false",
          },
        },
      ],
    }),
    resourcePersistencePath: join(root, "cloud"),
    isolatedResourcePersistencePath: join(root, "cloud"),
  });
  base = await mf.ready;
  token = (
    await (
      await fetch(new URL("/fixture/create", base), { method: "POST" })
    ).json()
  ).token;
  issuedTokens.push(token);
  writeFileSync(
    join(directory, "agent.json"),
    JSON.stringify({
      url: String(base),
      machineId: "macb",
      machineName: "Parent recovery fixture",
      token,
      execution: { commands: true, workingDirectory: directory },
    }),
    { mode: 0o600 },
  );
  let agent = start();
  await until(async () => (await status()).online, "initial Agent connection");
  const first = await viewer();
  const hibernationOperation = {
    id: "parent-hibernate",
    machineId: "macb",
    tool: "command.exec",
    program: process.execPath,
    args: [
      "-e",
      "const fs=require('node:fs');fs.appendFileSync('hibernate-marker','x');setTimeout(()=>process.stdout.write('hibernated-ok'),1200)",
    ],
  };
  const pending = first.request({
    type: "run",
    requestId: "before-hibernate",
    operation: hibernationOperation,
  });
  await until(
    () => existsSync(join(directory, "hibernate-marker")),
    "hibernation operation admitted",
  );
  const before = (await (await fetch(new URL("/fixture/boot", base))).json())
    .id;
  await mf.unsafeEvictDurableObject("parent-recovery", "MachineState", {
    name: "macb",
    webSockets: "hibernate",
  });
  const after = (await (await fetch(new URL("/fixture/boot", base))).json()).id;
  assert.notEqual(before, after, "DO constructor must actually run again");
  const result = await pending;
  assert.deepEqual(result.operation, {
    id: "parent-hibernate",
    state: "succeeded",
    stdout: "hibernated-ok",
    stderr: "",
    exitCode: 0,
  });
  assert.equal(
    first.ws.readyState,
    WebSocket.OPEN,
    "Viewer original socket must survive hibernation",
  );
  assert.equal(readFileSync(join(directory, "hibernate-marker"), "utf8"), "x");
  console.log(
    JSON.stringify({
      check: "real-do-hibernation-during-command",
      passed: true,
      recreated: true,
      originalSocketSurvived: true,
      fileEffects: 1,
    }),
  );
  first.ws.terminate();
  const second = await viewer();
  const restartedOperation = {
    id: "parent-restart",
    machineId: "macb",
    tool: "command.exec",
    program: process.execPath,
    args: [
      "-e",
      "const fs=require('node:fs');fs.appendFileSync('restart-marker','x');setTimeout(()=>process.exit(0),900)",
    ],
  };
  second.ws.send(
    JSON.stringify({
      type: "run",
      requestId: "before-restart",
      operation: restartedOperation,
    }),
  );
  await until(
    () => existsSync(join(directory, "restart-marker")),
    "restart operation admitted",
  );
  const exited = once(agent, "exit");
  agent.kill("SIGKILL");
  await exited;
  await until(async () => !(await status()).online, "old Agent disconnected");
  await delay(1100);
  agent = start();
  await until(
    async () => (await status()).online,
    "restarted Agent connection",
  );
  const recovered = await viewer();
  const queried = await recovered.request({
    type: "get",
    requestId: "after-restart",
    operationId: "parent-restart",
  });
  assert.deepEqual(queried.operation, {
    id: "parent-restart",
    state: "unknown",
    stdout: "",
    stderr: "",
    exitCode: null,
  });
  const retry = await recovered.request({
    type: "run",
    requestId: "retry-original",
    operation: restartedOperation,
  });
  assert.deepEqual(retry.operation, queried.operation);
  assert.equal(readFileSync(join(directory, "restart-marker"), "utf8"), "x");
  console.log(
    JSON.stringify({
      check: "real-agent-process-restart",
      passed: true,
      state: "unknown",
      retryState: retry.operation.state,
      fileEffects: 1,
    }),
  );
  const originalToken = token;
  const closedViewer = once(recovered.ws, "close");
  const revokedProcessExit = once(agent, "exit");
  token = (
    await (
      await fetch(new URL("/fixture/rotate", base), { method: "POST" })
    ).json()
  ).token;
  issuedTokens.push(token);
  assert.ok(
    token !== originalToken,
    "Rotation must issue a different managed JWT",
  );
  assert.equal((await closedViewer)[0], 4001);
  const exit = await revokedProcessExit;
  assert.equal(exit[0], 1, "Revoked identity must end the old service");
  const rejectedURL = new URL("/api/v1/execution-agent", base);
  rejectedURL.protocol = "ws:";
  const oldConnection = new WebSocket(rejectedURL, {
    headers: {
      Authorization: `Bearer ${originalToken}`,
      "X-Eagle-Machine": "macb",
    },
  });
  oldConnection.on("error", () => {});
  sockets.add(oldConnection);
  const rejection = await new Promise((resolve, reject) => {
    oldConnection.once("unexpected-response", (_req, res) => {
      res.resume();
      oldConnection.terminate();
      resolve(res.statusCode);
    });
    oldConnection.once("open", () =>
      reject(new Error("Old managed credential was admitted after rotation")),
    );
    oldConnection.once("error", (error) => {
      if (error.message.includes("ECONN")) reject(error);
    });
  });
  assert.equal(
    rejection,
    401,
    "Validly signed old jti must be rejected at registration authority",
  );
  writeFileSync(
    join(directory, "agent.json"),
    JSON.stringify({
      url: String(base),
      machineId: "macb",
      machineName: "Managed fixture",
      token,
      execution: { commands: true, workingDirectory: directory },
    }),
    { mode: 0o600 },
  );
  agent = start();
  await until(async () => (await status()).online, "rotated Agent connection");
  const afterRotation = await viewer();
  const persisted = await afterRotation.request({
    type: "get",
    requestId: "after-rotation",
    operationId: "parent-hibernate",
  });
  assert.equal(persisted.operation.state, "succeeded");
  assert.equal(persisted.operation.stdout, "hibernated-ok");
  assert.equal(readFileSync(join(directory, "hibernate-marker"), "utf8"), "x");
  console.log(
    JSON.stringify({
      check: "managed-jwt-rotation",
      passed: true,
      oldCredentialRejected: rejection,
      oldViewerCloseCode: 4001,
      newCredentialConnected: true,
      journalPreserved: true,
    }),
  );
  assert.equal(
    [owner, ...issuedTokens].some((secret) => log.includes(secret)),
    false,
    "Synthetic credentials must not appear in Agent output",
  );
} finally {
  for (const ws of sockets) ws.terminate();
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(kill);
    }
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
}
