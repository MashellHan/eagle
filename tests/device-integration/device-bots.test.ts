import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import WebSocket from "ws";

type JSONRecord = Record<string, unknown>;
type Directory = {
  localDeviceId: string;
  groupId: string | null;
  devices: {
    deviceId: string;
    online: boolean | null;
    policy: { mode: string } | null;
  }[];
};
type Receipt = {
  operationId: string;
  targetDeviceId: string;
  status: string;
  output?: string;
  error?: string;
};

// Deliberately outside tests/*.test.ts: candidate acceptance installs the two
// products independently before invoking this suite. No Bots imports in root.
// A source override lets an isolated test worktree exercise an integrated Bot
// commit read-only; the ordinary command always uses this checkout's product.
const botsSource = resolve(
  process.env.EAGLE_BOTS_INTEGRATION_SOURCE ?? "apps/bots",
);
const childEnv = (home: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: home,
    NODE_OPTIONS: "",
    NODE_PATH: "",
  };
  for (const name of Object.keys(environment))
    if (!["HOME", "PATH", "TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(name))
      delete environment[name];
  return environment;
};

async function until<T>(
  probe: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 12000;
  do {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`timeout waiting for ${label}`);
}

function processPort(file: string, root: string) {
  const child = spawn(process.execPath, [file], {
    cwd: resolve("."),
    env: childEnv(root),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const messages: JSONRecord[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr = (stderr + text).slice(-12000);
  });
  let onMessage: ((message: JSONRecord) => void) | undefined;
  reader.on("line", (line) => {
    const message = JSON.parse(line) as JSONRecord;
    messages.push(message);
    onMessage?.(message);
  });
  return {
    child,
    diagnostics() {
      return stderr;
    },
    historyTrace(botId?: string) {
      return messages
        .filter(
          (message) =>
            message.type === "history-page" &&
            (botId === undefined || message.botId === botId),
        )
        .slice(-80);
    },
    send(value: unknown) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    handle(handler: (message: JSONRecord) => void) {
      onMessage = handler;
    },
    async message(predicate: (message: JSONRecord) => boolean) {
      return until(async () => {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        assert.equal(
          child.exitCode,
          null,
          `child exited before response: ${stderr}`,
        );
        return undefined;
      }, "child response");
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) =>
          child.once("exit", () => done()),
        );
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      reader.close();
      assert.equal(
        child.exitCode,
        0,
        `child did not shut down normally: ${stderr}`,
      );
    },
  };
}

function deviceProcess(root: string, baseUrl: string) {
  mkdirSync(root, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const socketPath = join(root, "access.sock");
  const process = processPort(
    resolve("packages/agent/device-service.ts"),
    root,
  );
  process.handle((message) => {
    if (message.type === "history-sign") {
      const proof = message.proof as JSONRecord;
      assert.equal(proof.serviceOrigin, baseUrl);
      assert.equal(proof.deviceId, deviceId);
      assert.equal(proof.purpose, "eagle-history-key-v1");
      const payload = [
        proof.purpose,
        proof.serviceOrigin,
        proof.deviceId,
        proof.groupId,
        proof.membershipEpoch,
        proof.ephemeralKey,
        proof.expiresAt,
      ].join("\n");
      process.send({
        type: "history-signature",
        requestId: message.requestId,
        signature: sign(null, Buffer.from(payload), keys.privateKey).toString(
          "base64url",
        ),
      });
      return;
    }
    if (message.type !== "sign") return;
    const payload = String(message.payload);
    const fields = payload.split("\n");
    assert.deepEqual(fields.slice(0, 4), [
      "eagle-device-register-v1",
      baseUrl,
      deviceId,
      publicKey,
    ]);
    assert.equal(fields.length, 7);
    process.send({
      type: "signature",
      requestId: message.requestId,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString(
        "base64url",
      ),
    });
  });
  process.send({
    type: "configure",
    version: 1,
    baseUrl,
    deviceId,
    publicKey,
    name: `Device ${deviceId.slice(0, 4)}`,
    platform: "darwin",
    arch: "arm64",
    stateDirectory: root,
    socketPath,
  });
  return {
    ...process,
    root,
    deviceId,
    socketPath,
    async ready() {
      await process.message((message) => message.type === "ready");
      await process.message(
        (message) => message.type === "cloud" && message.status === "online",
      );
    },
    async manage(method: string, params?: unknown) {
      const requestId = randomUUID();
      process.send({ type: "manage", requestId, method, params });
      const reply = await process.message(
        (message) =>
          message.type === "managed" && message.requestId === requestId,
      );
      assert.equal(reply.error, undefined, "trusted management request failed");
      return reply.result as JSONRecord;
    },
  };
}

async function localCall(path: string, method: string): Promise<unknown> {
  const socket = connect(path);
  const reader = createInterface({ input: socket });
  try {
    return await new Promise((done, reject) => {
      socket.once("error", reject);
      socket.setTimeout(5000, () => reject(new Error("local port timeout")));
      reader.once("line", (line) => {
        const reply = JSON.parse(line) as JSONRecord;
        if (reply.error) reject(new Error("local port rejected request"));
        else done(reply.result);
      });
      socket.write(`${JSON.stringify({ requestId: randomUUID(), method })}\n`);
    });
  } finally {
    reader.close();
    socket.destroy();
  }
}

async function workerFixture(directory: string) {
  // Only a test transport fault: the real target finishes and the real relay
  // authorizes its result, then the caller loses that one response. No executor,
  // registry, SDK or device-port implementation is replaced.
  writeFileSync(
    join(directory, "entry.ts"),
    `
import worker,{DeviceRegistry,DeviceExecution as Execution} from "../../apps/web/src/worker/device-service.ts";
export {DeviceRegistry};
export class DeviceExecution extends Execution {
 respond(socket,request,result,unauthorized=false) {
  if(request.action==='run'&&request.operation?.command?.includes('device-integration-drop-response')&&result.status==='completed') {
   socket.close(1011,'test_response_lost');return;
  }
  return super.respond(socket,request,result,unauthorized);
 }
}
export default worker;
`,
  );
  execFileSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "deploy",
      join(directory, "entry.ts"),
      "--dry-run",
      "--config",
      "apps/web/wrangler.devices.example.jsonc",
      "--outdir",
      join(directory, "worker"),
    ],
    { stdio: "pipe" },
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle",
          modules: true,
          scriptPath: join(directory, "worker/entry.js"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            DEVICE_REGISTRY: { className: "DeviceRegistry", useSQLite: true },
            DEVICE_EXECUTION: { className: "DeviceExecution", useSQLite: true },
          },
          bindings: { BUILD_REVISION: "local-device-integration" },
        },
      ],
    }),
  );
  try {
    return { mf, origin: (await mf.ready).origin };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

type ModelStep =
  | { name: string; args: JSONRecord }
  | { text: string; wait?: Promise<void> };
async function modelFixture(key: string) {
  const steps: ModelStep[] = [];
  const failures: string[] = [];
  let requests = 0;
  const inputs: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(
        request.headers.authorization === `Bearer ${key}`,
        true,
        "local model authentication",
      );
      assert.equal(request.url, "/v1/responses");
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as { tools: { name: string }[] };
      const step = steps.shift();
      assert(step, "unexpected model request");
      requests++;
      inputs.push(input);
      if ("wait" in step) await step.wait;
      const id = `resp_${requests}`;
      const event = (type: string, fields: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
      const item =
        "name" in step
          ? {
              type: "function_call",
              id: `fc_${requests}`,
              call_id: `call_${requests}`,
              name: step.name,
              arguments: JSON.stringify(step.args),
              status: "completed",
            }
          : {
              type: "message",
              id: `msg_${requests}`,
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: step.text, annotations: [] },
              ],
            };
      if ("name" in step)
        assert(
          input.tools.some((tool) => tool.name === step.name),
          `SDK did not offer ${step.name}`,
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        event("response.created", { response: { id, status: "in_progress" } }),
      );
      response.write(
        event("response.output_item.added", {
          output_index: 0,
          item:
            "name" in step
              ? { ...item, arguments: "", status: "in_progress" }
              : { ...item, content: [] },
        }),
      );
      if ("name" in step)
        response.write(
          event("response.function_call_arguments.delta", {
            output_index: 0,
            delta: JSON.stringify(step.args),
          }),
        );
      else
        response.write(
          event("response.output_text.delta", {
            output_index: 0,
            content_index: 0,
            delta: step.text,
          }),
        );
      response.write(
        event("response.output_item.done", { output_index: 0, item }),
      );
      response.end(
        event("response.completed", {
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      );
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "model fixture failure",
      );
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    failures,
    inputs,
    hold(text: string) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      steps.push({ text, wait });
      return release;
    },
    answer(text: string) {
      steps.push({ text });
    },
    script(name: string, args: JSONRecord) {
      steps.push({ name, args }, { text: "done" });
    },
    verify() {
      assert.deepEqual(failures, []);
      assert.equal(steps.length, 0);
      return requests;
    },
  };
}

async function daemonProcess(
  root: string,
  socketPath: string,
  baseUrl: string,
  key: string,
  failOneBackfill = false,
) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const script = join(root, "daemon.mjs");
  writeFileSync(
    script,
    `
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const input=createInterface({input:process.stdin});
const lines=input[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value);
Object.assign(process.env,{BOTS_BASE_URL:config.baseUrl,BOTS_API_KEY:config.key,BOTS_PROVIDER:'device-local',BOTS_MODEL:'scripted-local',BOTS_THINKING_LEVEL:'off',BOTS_TOOL_GROUPS:'core',BOTS_COMPACTION:'off'});
const {readConfig}=await import(pathToFileURL(config.source+'/src/config.ts').href);
const {startDaemon}=await import(pathToFileURL(config.source+'/src/main.ts').href);
let holdBot,releasePage,heldPage;
const {DeviceChannel}=await import(pathToFileURL(config.source+'/src/tools/devices/socket.ts').href);
const call=DeviceChannel.prototype.call;
DeviceChannel.prototype.call=async function(method,...args){
  const result=await call.call(this,method,...args);
  if(method==='history.send'&&args[0]?.payload?.type==='changed')for(const botId of args[0].payload.botIds)process.stdout.write(JSON.stringify({type:'notice-sent',botId})+'\\n');
  return result;
};
{
  const {BotRegistry}=await import(pathToFileURL(config.source+'/src/core/BotRegistry.ts').href);
  const touch=BotRegistry.prototype.touch;
  BotRegistry.prototype.touch=function(id){
    if(this.summaries().some(bot=>bot.id===id&&bot.title==='Blocked history Bot'))return false;
    return touch.call(this,id);
  };
  const {PiDurableRuntime}=await import(pathToFileURL(config.source+'/src/runtime/pi/PiDurableRuntime.ts').href);
  const open=PiDurableRuntime.prototype.open;
  let fail=config.failOneBackfill;
  PiDurableRuntime.prototype.open=async function(...args){
    const handle=await open.apply(this,args);
    const read=handle.exportHistoryPage.bind(handle);
    handle.exportHistoryPage=async function(input){
      if(holdBot===args[0].id){holdBot=undefined;process.stdout.write(JSON.stringify({type:'page-held',botId:args[0].id})+'\\n');await heldPage;}
      if(fail&&input?.before){fail=false;process.stdout.write(JSON.stringify({type:'backfill-rejected'})+'\\n');throw new Error('history_busy');}
      const page=await read(input);
      process.stdout.write(JSON.stringify({type:'history-page',botId:args[0].id,direction:input?.before?'backfill':input?.after?'tail':'latest',count:page.records.length,first:page.records[0]?.entry.id,previous:page.records[0]?.previous,last:page.records.at(-1)?.entry.id,head:page.head,hasMore:page.hasMore})+'\\n');
      return page;
    };
    const receive=handle.importHistoryPage.bind(handle);
    handle.importHistoryPage=async function(page){
      const receipt=await receive(page);
      process.stdout.write(JSON.stringify({type:'history-page',botId:args[0].id,direction:'receive',count:page.records.length,first:page.records[0]?.entry.id,last:page.records.at(-1)?.entry.id,head:page.head,pending:receipt.pending})+'\\n');
      return receipt;
    };
    return handle;
  };
}
const daemon=await startDaemon(readConfig({argv:['--root',config.root,'--port','0'],env:{BOTS_DEVICE_SOCKET:config.socketPath}}));
process.stdout.write(JSON.stringify({type:'ready',port:daemon.port})+'\\n');
for await(const line of lines){
  const control=JSON.parse(line);
  if(control.type==='hold-page'){
    holdBot=control.botId;heldPage=new Promise(done=>{releasePage=done;});
    process.stdout.write(JSON.stringify({type:'page-gate-ready'})+'\\n');
  }else if(control.type==='release-page')releasePage?.();
}
releasePage?.();
await daemon.close();
input.close();
`,
  );
  const daemon = processPort(script, root);
  // Private test configuration arrives on stdin, never argv or the inherited environment.
  try {
    daemon.send({
      source: botsSource,
      root,
      socketPath,
      baseUrl,
      key,
      failOneBackfill,
    });
    const ready = await daemon.message((message) => message.type === "ready");
    const token = readFileSync(join(root, "token"), "utf8").trim();
    const origin = `http://127.0.0.1:${ready.port}`;
    return {
      ...daemon,
      origin,
      token,
      async createBot(title: string) {
        const response = await fetch(`${origin}/v1/bots`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title }),
        });
        assert.equal(response.status, 201);
        return ((await response.json()) as { bot: { id: string } }).bot.id;
      },
    };
  } catch (error) {
    try {
      await daemon.stop();
    } catch (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "daemon startup and cleanup failed",
      );
    }
    throw error;
  }
}

async function botConnection(origin: string, token: string, botId: string) {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/v1/socket`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const messages: JSONRecord[] = [];
  socket.on("message", (bytes) =>
    messages.push(JSON.parse(bytes.toString()) as JSONRecord),
  );
  const frame = (type: string) =>
    until(async () => {
      const index = messages.findIndex((message) => message.type === type);
      return index < 0 ? undefined : messages.splice(index, 1)[0];
    }, `Bots ${type}`);
  await new Promise<void>((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      client: "device-integration",
    }),
  );
  await frame("welcome");
  socket.send(
    JSON.stringify({
      type: "subscribe",
      botId,
      trace: `tr_sub_${randomUUID()}`,
    }),
  );
  await frame("snapshot");
  return {
    socket,
    async run(
      name: string,
      model: Awaited<ReturnType<typeof modelFixture>>,
      args: JSONRecord = {},
    ) {
      messages.length = 0;
      model.script(name, args);
      const requestId = `r_${randomUUID()}`;
      socket.send(
        JSON.stringify({
          type: "send",
          requestId,
          text: `Integration: ${name}`,
          whenBusy: "followUp",
          trace: `tr_run_${randomUUID()}`,
        }),
      );
      await until(
        async () =>
          messages.some(
            (message) =>
              message.type === "submission" &&
              message.requestId === requestId &&
              ["done", "unanswered"].includes(String(message.status)),
          )
            ? true
            : undefined,
        `Bot ${name} settlement`,
      );
      assert.deepEqual(model.failures, []);
      const settled = messages.find(
        (message) =>
          message.type === "submission" &&
          message.requestId === requestId &&
          message.status === "done",
      );
      assert(settled, `SDK submission failed for ${name}`);
      const rows = messages
        .filter((message) => message.type === "append")
        .flatMap(
          (message) =>
            (
              message.message as {
                role: string;
                blocks: {
                  type: string;
                  name: string;
                  text: string;
                  isError: boolean;
                }[];
              }
            ).blocks,
        );
      const result = rows.find(
        (block) => block.type === "toolResult" && block.name === name,
      );
      assert(result, `missing actual SDK tool result for ${name}`);
      return {
        value: JSON.parse(result.text) as JSONRecord,
        isError: result.isError,
      };
    },
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

test("existing and new Bots share real paired devices, native tools and original remote operation IDs", {
  timeout: 90000,
}, async () => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/device-bots-worker-"));
  const root = mkdtempSync("/tmp/eagle-device-bots-");
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  let a: ReturnType<typeof deviceProcess> | undefined;
  let b: ReturnType<typeof deviceProcess> | undefined;
  let daemon: Awaited<ReturnType<typeof daemonProcess>> | undefined;
  const clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  let stopped = false;
  try {
    worker = await workerFixture(workerRoot);
    a = deviceProcess(join(root, "a"), worker.origin);
    b = deviceProcess(join(root, "b"), worker.origin);
    await Promise.all([a.ready(), b.ready()]);
    for (const device of [a, b]) {
      assert.equal((await device.manage("policy.get")).mode, "always-ask");
      assert.equal(
        (await device.manage("policy.set", { mode: "all-approve" })).mode,
        "all-approve",
      );
    }
    daemon = await daemonProcess(
      join(root, "bots"),
      a.socketPath,
      model.baseUrl,
      key,
    );
    const health = (await fetch(`${daemon.origin}/v1/health`).then((response) =>
      response.json(),
    )) as { deviceAccess: { version: number } };
    assert.equal(health.deviceAccess.version, 1);
    const existingId = await daemon.createBot("Existing before pairing");
    const existing = await botConnection(
      daemon.origin,
      daemon.token,
      existingId,
    );
    clients.push(existing);
    const initial = await existing.run("remote_status", model);
    assert.equal(initial.isError, false);
    assert.deepEqual(
      (initial.value as unknown as Directory).devices.map(
        (device) => device.deviceId,
      ),
      [a.deviceId],
    );
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    await until(async () => {
      const directory = (await localCall(
        a?.socketPath ?? "",
        "directory",
      )) as Directory;
      return directory.devices.length === 2 &&
        directory.devices.every(
          (device) =>
            device.online === true && device.policy?.mode === "all-approve",
        )
        ? directory
        : undefined;
    }, "paired Agent observations");
    const newlyCreatedId = await daemon.createBot("New after pairing");
    const newlyCreated = await botConnection(
      daemon.origin,
      daemon.token,
      newlyCreatedId,
    );
    clients.push(newlyCreated);
    const oldDirectory = (await existing.run("remote_status", model))
      .value as unknown as Directory;
    const newDirectory = (await newlyCreated.run("remote_status", model))
      .value as unknown as Directory;
    assert.equal(oldDirectory.groupId, newDirectory.groupId);
    assert.deepEqual(
      oldDirectory.devices.map((device) => device.deviceId).sort(),
      [a.deviceId, b.deviceId].sort(),
    );
    assert.deepEqual(
      newDirectory.devices.map((device) => device.deviceId).sort(),
      [a.deviceId, b.deviceId].sort(),
    );
    const execute = async (client: typeof existing, suffix: string) => {
      const result = await client.run("remote_execute", model, {
        deviceId: b?.deviceId,
        operation: {
          kind: "command",
          command: `printf ${suffix} >> remote-count; printf remote-${suffix}`,
          cwd: b?.root,
        },
      });
      assert.equal(
        result.isError,
        false,
        "real SDK accepts the device receipt",
      );
      const receipt = result.value as unknown as Receipt;
      assert.equal(receipt.targetDeviceId, b?.deviceId);
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.output, `remote-${suffix}`);
      return receipt;
    };
    const first = await execute(existing, "a");
    const local = await existing.run("bash", model, {
      command: "printf native-ok",
    });
    assert.equal(
      local.isError,
      false,
      "normal native SDK tool passes through local.begin/complete",
    );
    const native = local.value as unknown as Receipt;
    assert.equal(native.targetDeviceId, a.deviceId);
    assert.equal(native.status, "completed");
    assert.match(native.output ?? "", /native-ok/);
    const second = await execute(newlyCreated, "b");
    assert.equal(readFileSync(join(b.root, "remote-count"), "utf8"), "ab");
    assert.equal(existsSync(join(a.root, "remote-count")), false);
    const uncertain = await existing.run("remote_execute", model, {
      deviceId: b.deviceId,
      operation: {
        kind: "command",
        command:
          "printf x >> uncertain-count; printf finished-on-target # device-integration-drop-response",
        cwd: b.root,
      },
    });
    const original = uncertain.value as unknown as Receipt;
    assert.equal(
      original.status,
      "unknown",
      "lost relay response remains uncertain",
    );
    assert.equal(original.targetDeviceId, b.deviceId);
    assert.equal(uncertain.isError, true);
    const recovered = await newlyCreated.run("remote_operation", model, {
      deviceId: b.deviceId,
      operationId: original.operationId,
      action: "get",
    });
    assert.equal(recovered.isError, false);
    const recoveredReceipt = recovered.value as unknown as Receipt;
    assert.equal(recoveredReceipt.operationId, original.operationId);
    assert.equal(recoveredReceipt.targetDeviceId, b.deviceId);
    assert.equal(recoveredReceipt.status, "completed");
    assert.equal(recoveredReceipt.output, "finished-on-target");
    assert.equal(readFileSync(join(b.root, "uncertain-count"), "utf8"), "x");
    await b.stop();
    await until(async () => {
      const directory = (await localCall(
        a?.socketPath ?? "",
        "directory",
      )) as Directory;
      return directory.devices.find((device) => device.deviceId === b?.deviceId)
        ?.online === false
        ? true
        : undefined;
    }, "real target disconnect");
    const forbiddenFile = join(root, "must-never-run-locally");
    const offline = await newlyCreated.run("remote_execute", model, {
      deviceId: b.deviceId,
      operation: {
        kind: "command",
        command: `printf unsafe > '${forbiddenFile}'`,
      },
    });
    const offlineReceipt = offline.value as unknown as Receipt;
    assert.equal(offline.isError, true);
    assert.equal(offlineReceipt.targetDeviceId, b.deviceId);
    assert.equal(offlineReceipt.status, "unknown");
    assert.equal(offlineReceipt.error, "target_offline_or_unknown");
    assert.equal(
      existsSync(forbiddenFile),
      false,
      "offline explicit target never executes locally",
    );
    assert.equal(
      model.verify(),
      18,
      "only the nine scripted tool rounds reached the local model",
    );
    for (const client of clients) client.socket.close();
    await daemon.stop();
    await a.stop();
    stopped = true;
    // Read the real journals after their exclusive process owners release them.
    const source = new DatabaseSync(join(a.root, "operations.sqlite"), {
      readOnly: true,
    });
    const target = new DatabaseSync(join(b.root, "operations.sqlite"), {
      readOnly: true,
    });
    try {
      const nativeRow = source
        .prepare("SELECT state,scope,native_blocked FROM operations WHERE id=?")
        .get(native.operationId) as {
        state: string;
        scope: string;
        native_blocked: number;
      };
      assert.equal(nativeRow.state, "succeeded");
      assert.equal(
        nativeRow.native_blocked,
        0,
        "normal native completion releases admission",
      );
      assert.equal(
        (JSON.parse(nativeRow.scope) as { sourceBotId: string }).sourceBotId,
        existingId,
      );
      for (const [receipt, botId] of [
        [first, existingId],
        [second, newlyCreatedId],
        [original, existingId],
      ] as const) {
        const row = target
          .prepare("SELECT state,scope FROM operations WHERE id=?")
          .get(receipt.operationId) as { state: string; scope: string };
        assert.equal(row.state, "succeeded");
        assert.deepEqual(JSON.parse(row.scope), {
          kind: "device",
          sourceDeviceId: a.deviceId,
          targetDeviceId: b.deviceId,
          sourceBotId: botId,
        });
        assert.equal(
          source
            .prepare("SELECT id FROM operations WHERE id=?")
            .get(receipt.operationId),
          undefined,
          "source never executed a remote operation",
        );
      }
    } finally {
      source.close();
      target.close();
    }
  } finally {
    for (const client of clients) client.socket.terminate();
    if (!stopped)
      await Promise.allSettled([daemon?.stop(), a?.stop(), b?.stop()]);
    await worker?.mf.dispose();
    await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional DO history automatically discovers an empty Bot and shows committed user before a slow provider", {
  timeout: 90000,
}, async (t) => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/history-bots-worker-"));
  const root = mkdtempSync("/tmp/eagle-history-bots-");
  const key = randomBytes(32).toString("base64url");
  const models = await Promise.all([modelFixture(key), modelFixture(key)]);
  const [modelA, modelB] = models;
  assert.ok(modelA && modelB);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  const devices: ReturnType<typeof deviceProcess>[] = [];
  const daemons: Awaited<ReturnType<typeof daemonProcess>>[] = [];
  let release = () => {};
  let handoffOwner: ReturnType<typeof connect> | undefined;
  try {
    worker = await workerFixture(workerRoot);
    const a = deviceProcess(join(root, "a"), worker.origin);
    const b = deviceProcess(join(root, "b"), worker.origin);
    devices.push(a, b);
    await Promise.all(devices.map((device) => device.ready()));
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    await a.manage("policy.set", { mode: "paused" });
    const policies = await Promise.all(
      devices.map((device) => device.manage("policy.get")),
    );
    for (const device of devices)
      await device.manage("history.set", { enabled: true });
    const left = await daemonProcess(
      join(root, "bots-a"),
      a.socketPath,
      modelA.baseUrl,
      key,
      true,
    );
    daemons.push(left);
    handoffOwner = connect(b.socketPath);
    const ownerLines = createInterface({ input: handoffOwner });
    const ownership = new Promise<JSONRecord>((done) =>
      ownerLines.once("line", (line) => done(JSON.parse(line))),
    );
    handoffOwner.write(
      `${JSON.stringify({ requestId: randomUUID(), method: "history.attach" })}\n`,
    );
    assert.equal((await ownership).error, undefined);
    let right = await daemonProcess(
      join(root, "bots-b"),
      b.socketPath,
      modelB.baseUrl,
      key,
    );
    daemons.push(right);
    const cli = async (daemon: typeof left, ...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        resolve("apps/macos/.build/debug/eagle-cli"),
        args,
        {
          env: {
            ...childEnv(root),
            EAGLE_PORT: new URL(daemon.origin).port,
            EAGLE_TOKEN: daemon.token,
            EAGLE_ROOT: root,
          },
          timeout: 15000,
        },
      );
      return JSON.parse(
        stdout.trim().split("\n").at(-1) ?? "null",
      ) as JSONRecord;
    };
    const created = await cli(
      left,
      "bots",
      "create",
      "--title",
      "Automatic empty history Bot",
      "--json",
    );
    const botId = (created.bot as { id: string }).id;
    assert.deepEqual(
      (await cli(right, "bots", "list", "--json")).bots,
      [],
      "optional coordinator cannot steal the incumbent consumer",
    );
    assert.equal(handoffOwner.destroyed, false);
    ownerLines.close();
    handoffOwner.destroy();
    handoffOwner = undefined;
    await until(async () => {
      const catalog = await cli(right, "bots", "list", "--json");
      return (catalog.bots as { id: string }[]).some((bot) => bot.id === botId)
        ? true
        : undefined;
    }, "automatic empty Bot discovery through real DO");
    const history = async (
      operation: string,
      body: unknown,
      selectedBot = botId,
      daemon = right,
    ) => {
      const response = await fetch(
        `${daemon.origin}/v1/bots/${selectedBot}/history/${operation}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 200);
      return (await response.json()) as JSONRecord;
    };
    release = modelA.hold("source complete answer");
    await cli(
      left,
      "chat",
      "send",
      botId,
      "--text",
      "source user while provider is blocked",
      "--json",
    );
    await until(
      async () => (modelA.inputs.length === 1 ? true : undefined),
      "source provider started",
    );
    const partial = await until(async () => {
      const branches = (await history("branches", {})).branches as {
        selection: string;
      }[];
      for (const branch of branches) {
        if (!/^[a-f0-9]{64}$/.test(branch.selection)) continue;
        const view = await history("view", { head: branch.selection });
        if (
          JSON.stringify(view.messages).includes(
            "source user while provider is blocked",
          )
        )
          return { head: branch.selection, view };
      }
      return undefined;
    }, "automatic durable user visibility while provider remains blocked");
    assert.equal(
      (await history("assess", { head: partial.head })).usable,
      false,
    );
    assert.equal(
      modelB.inputs.length,
      0,
      "passive receive never invokes B's provider",
    );
    release();
    const complete = await until(async () => {
      const branches = (await history("branches", {})).branches as {
        selection: string;
      }[];
      for (const branch of branches) {
        if (!/^[a-f0-9]{64}$/.test(branch.selection)) continue;
        const view = await history("view", { head: branch.selection });
        if (
          JSON.stringify(view.messages).includes("source complete answer") &&
          (await history("assess", { head: branch.selection })).usable
        )
          return branch.selection;
      }
      return undefined;
    }, "automatic complete source head");
    modelB.answer("local B continuation");
    const continuation = await cli(
      right,
      "history",
      "continue",
      botId,
      "--head",
      complete,
      "--request-id",
      "r_auto_local_continue",
      "--text",
      "B continues locally",
      "--json",
    );
    assert.equal((continuation.submission as JSONRecord).status, "done");
    assert.match(
      JSON.stringify(modelB.inputs[0]),
      /source user while provider is blocked/,
    );
    assert.match(JSON.stringify(modelB.inputs[0]), /source complete answer/);
    await right.stop();
    daemons.splice(daemons.indexOf(right), 1);
    const largeCreated = await cli(
      left,
      "bots",
      "create",
      "--title",
      "Bounded historical backfill",
      "--json",
    );
    const largeId = (largeCreated.bot as { id: string }).id;
    for (let turn = 0; turn < 80; turn++) {
      modelA.answer(
        turn === 79
          ? `large-record-marker-${"x".repeat(80 * 1024)}`
          : `old history answer ${turn}`,
      );
      await cli(
        left,
        "chat",
        "send",
        largeId,
        "--text",
        `old history user ${turn}`,
        "--wait",
        "--json",
      );
    }
    right = await daemonProcess(
      join(root, "bots-b"),
      b.socketPath,
      modelB.baseUrl,
      key,
    );
    daemons.push(right);
    release = modelA.hold("fresh answer after backfill");
    await cli(
      left,
      "chat",
      "send",
      botId,
      "--text",
      "fresh user during historical backfill",
      "--json",
    );
    await until(async () => {
      const list = (await history("branches", {})).branches as {
        selection: string;
      }[];
      for (const branch of list) {
        if (
          /^[a-f0-9]{64}$/.test(branch.selection) &&
          JSON.stringify(
            (await history("view", { head: branch.selection })).messages,
          ).includes("fresh user during historical backfill")
        )
          return true;
      }
      return undefined;
    }, "fresh committed tail while old backfill is queued");
    release();
    await left.message((message) => message.type === "backfill-rejected");
    const largeHead = await until(async () => {
      const catalog = await cli(right, "bots", "list", "--json");
      if (!(catalog.bots as { id: string }[]).some((bot) => bot.id === largeId))
        return undefined;
      const list = (await history("branches", {}, largeId)).branches as {
        selection: string;
      }[];
      for (const branch of list) {
        if (
          /^[a-f0-9]{64}$/.test(branch.selection) &&
          (await history("assess", { head: branch.selection }, largeId)).usable
        )
          return branch.selection;
      }
      return undefined;
    }, "last backfill page drains native pending to completion without another notice");
    const largePage = await history("page", { selection: largeHead }, largeId);
    assert.ok(
      (largePage.records as unknown[]).some(
        (record) => Buffer.byteLength(JSON.stringify(record)) > 60 * 1024,
      ),
      "a normal >60 KiB native record crosses the bounded channel",
    );
    modelB.answer("B continues complete large history");
    await cli(
      right,
      "history",
      "continue",
      largeId,
      "--head",
      largeHead,
      "--request-id",
      "r_auto_large_continue",
      "--text",
      "continue the backfill",
      "--json",
    );
    assert.match(JSON.stringify(modelB.inputs.at(-1)), /old history user 0/);
    assert.match(JSON.stringify(modelB.inputs.at(-1)), /large-record-marker/);
    await t.test(
      "an unchanged raw head recovers ancestors supplied by a later notice",
      async () => {
        const created = await cli(
          left,
          "bots",
          "create",
          "--title",
          "Raw gap Bot",
          "--json",
        );
        const rawId = (created.bot as { id: string }).id;
        const suffix: JSONRecord = {
          ...largePage,
          botId: rawId,
          records: (largePage.records as unknown[]).slice(-6),
          hasMore: false,
          cursor: null,
          snapshot: null,
        };
        await history("receive", suffix, rawId, left);
        await until(
          async () =>
            (
              (await cli(right, "bots", "list", "--json")).bots as {
                id: string;
              }[]
            ).some((bot) => bot.id === rawId)
              ? true
              : undefined,
          "raw-gap Bot catalog discovery",
        );
        await until(async () => {
          const list = (await history("branches", {}, rawId)).branches as {
            selection: string;
          }[];
          if (!list.some((branch) => branch.selection === suffix.head))
            return undefined;
          const view = await history("view", { head: suffix.head }, rawId);
          return JSON.stringify(view.messages).includes("large-record-marker")
            ? true
            : undefined;
        }, "raw suffix automatically forwarded before its ancestors exist");
        assert.equal(
          (await history("assess", { head: suffix.head }, rawId)).usable,
          false,
        );
        let donor = largePage;
        for (;;) {
          await history("receive", { ...donor, botId: rawId }, rawId, left);
          if (!donor.hasMore) break;
          donor = await history(
            "page",
            {
              selection: largeHead,
              before: donor.cursor,
              until: largePage.snapshot,
            },
            largeId,
          );
        }
        await until(
          async () =>
            (await history("assess", { head: suffix.head }, rawId)).usable
              ? true
              : undefined,
          "same head becomes usable after ancestors arrive without advancing its tail",
        ).catch((error) => {
          console.error(
            JSON.stringify({
              rawGap: {
                source: left.historyTrace(rawId),
                target: right.historyTrace(rawId),
              },
            }),
          );
          throw error;
        });
      },
    );
    await t.test(
      "an unavailable Bot cannot starve the next healthy Bot",
      async () => {
        await cli(
          left,
          "bots",
          "create",
          "--title",
          "Blocked history Bot",
          "--json",
        );
        const created = await cli(
          left,
          "bots",
          "create",
          "--title",
          "Healthy later Bot",
          "--json",
        );
        const healthyId = (created.bot as { id: string }).id;
        modelA.answer("healthy later answer");
        await cli(
          left,
          "chat",
          "send",
          healthyId,
          "--text",
          "healthy later user",
          "--wait",
          "--json",
        );
        await until(
          async () =>
            (
              (await cli(right, "bots", "list", "--json")).bots as {
                id: string;
              }[]
            ).some((bot) => bot.id === healthyId)
              ? true
              : undefined,
          "healthy Bot catalog discovery",
        );
        await until(async () => {
          const list = (await history("branches", {}, healthyId)).branches as {
            selection: string;
          }[];
          for (const branch of list) {
            if (
              /^[a-f0-9]{64}$/.test(branch.selection) &&
              JSON.stringify(
                (await history("view", { head: branch.selection }, healthyId))
                  .messages,
              ).includes("healthy later answer")
            )
              return true;
          }
          return undefined;
        }, "healthy committed history after a permanently unavailable Bot");
      },
    );
    assert.deepEqual(
      await Promise.all(devices.map((device) => device.manage("policy.get"))),
      policies,
    );
    for (const model of models) assert.ok(model.verify() >= 1);
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const device of devices) await device.stop();
    for (const device of devices.splice(0)) {
      const journal = new DatabaseSync(join(device.root, "operations.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          journal.prepare("SELECT count(*) n FROM operations").get()?.n,
          0,
        );
      } finally {
        journal.close();
      }
    }
  } catch (error) {
    for (const daemon of daemons) console.error(daemon.diagnostics());
    throw error;
  } finally {
    release();
    handoffOwner?.destroy();
    for (const daemon of daemons) await daemon.stop();
    for (const device of devices) await device.stop();
    await worker?.mf.dispose();
    for (const model of models) await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh native commit preempts an unrelated multi-branch scan across independent Device Services", {
  timeout: 90000,
}, async (t) => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/history-priority-worker-"));
  const root = mkdtempSync("/tmp/eagle-history-priority-");
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  const devices: ReturnType<typeof deviceProcess>[] = [];
  const daemons: Awaited<ReturnType<typeof daemonProcess>>[] = [];
  let release = () => {};
  try {
    worker = await workerFixture(workerRoot);
    const a = deviceProcess(join(root, "a"), worker.origin);
    const b = deviceProcess(join(root, "b"), worker.origin);
    devices.push(a, b);
    await Promise.all(devices.map((device) => device.ready()));
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const left = await daemonProcess(
      join(root, "bots-a"),
      a.socketPath,
      model.baseUrl,
      key,
    );
    daemons.push(left);
    const cli = async (daemon: typeof left, ...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        resolve("apps/macos/.build/debug/eagle-cli"),
        args,
        {
          env: {
            ...childEnv(root),
            EAGLE_PORT: new URL(daemon.origin).port,
            EAGLE_TOKEN: daemon.token,
            EAGLE_ROOT: root,
          },
          timeout: 15000,
        },
      );
      return JSON.parse(
        stdout.trim().split("\n").at(-1) ?? "null",
      ) as JSONRecord;
    };
    const history = async (
      daemon: typeof left,
      botId: string,
      operation: string,
      input: unknown,
    ) => {
      const response = await fetch(
        `${daemon.origin}/v1/bots/${botId}/history/${operation}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
      assert.equal(response.status, 200);
      return (await response.json()) as JSONRecord;
    };
    const oldBot = await left.createBot(
      "Many old branches before the fresh Bot",
    );
    model.answer("common completed ancestor");
    await cli(
      left,
      "chat",
      "send",
      oldBot,
      "--text",
      "common ancestor",
      "--wait",
      "--json",
    );
    const ancestor = await history(left, oldBot, "page", {});
    for (let branch = 0; branch < 8; branch++) {
      model.answer(`old branch answer ${branch}`);
      await cli(
        left,
        "history",
        "continue",
        oldBot,
        "--head",
        String(ancestor.head),
        "--request-id",
        `r_old_branch_${branch}`,
        "--text",
        `old branch ${branch}`,
        "--json",
      );
    }
    const oldList = await history(left, oldBot, "branches", {});
    const oldCount = (oldList.branches as unknown[]).length;
    assert.ok(
      oldCount >= 9,
      "actual native sibling branches supply the old workload",
    );
    left.send({ type: "hold-page", botId: oldBot });
    await left.message((message) => message.type === "page-gate-ready");
    const right = await daemonProcess(
      join(root, "bots-b"),
      b.socketPath,
      model.baseUrl,
      key,
    );
    daemons.push(right);
    for (const device of devices)
      await device.manage("history.set", { enabled: true });
    await left.message((message) => message.type === "page-held");
    const freshBot = await left.createBot(
      "Created after the peer catalog scan",
    );
    release = model.hold("fresh provider remains held until passive display");
    await cli(
      left,
      "chat",
      "send",
      freshBot,
      "--text",
      "fresh priority committed user",
      "--json",
    );
    await left.message(
      (message) => message.type === "notice-sent" && message.botId === freshBot,
    );
    left.send({ type: "release-page" });
    await until(async () => {
      const catalog = await cli(right, "bots", "list", "--json");
      if (
        !(catalog.bots as { id: string }[]).some((bot) => bot.id === freshBot)
      )
        return undefined;
      const list = (await history(right, freshBot, "branches", {}))
        .branches as { selection: string }[];
      for (const branch of list) {
        if (/^[a-f0-9]{64}$/.test(branch.selection)) {
          const view = await history(right, freshBot, "view", {
            head: branch.selection,
          });
          if (
            JSON.stringify(view.messages).includes(
              "fresh priority committed user",
            )
          ) {
            assert.equal(
              (
                await history(right, freshBot, "assess", {
                  head: branch.selection,
                })
              ).usable,
              false,
            );
            return true;
          }
        }
      }
      return undefined;
    }, "fresh committed user imports while its provider remains held");
    const reads = left
      .historyTrace()
      .filter((page) => page.direction !== "receive");
    const freshIndex = reads.findIndex(
      (page) => page.botId === freshBot && Number(page.count) > 0,
    );
    assert.ok(freshIndex >= 0);
    const oldBefore = reads
      .slice(0, freshIndex)
      .filter((page) => page.botId === oldBot).length;
    t.diagnostic(
      `fresh committed user arrived after ${oldBefore}/${oldCount} old branches; provider still held`,
    );
    assert.ok(
      oldBefore < oldCount,
      `fresh commit waited behind ${oldBefore}/${oldCount} old branches`,
    );
    await until(
      async () =>
        left.historyTrace(oldBot).filter((page) => page.direction !== "receive")
          .length >= oldCount
          ? true
          : undefined,
      "preempted old branches eventually finish",
    );
    assert.equal(
      model.inputs.length,
      10,
      "passive imports execute no provider",
    );
    release();
  } finally {
    release();
    for (const daemon of daemons) {
      daemon.send({ type: "release-page" });
      await daemon.stop();
    }
    for (const device of devices) await device.stop();
    await worker?.mf.dispose();
    await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
