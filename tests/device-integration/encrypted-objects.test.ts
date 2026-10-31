import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import WebSocket from "ws";
import { canonicalDeviceJSON } from "../../packages/contracts/src/devices.ts";
import {
  localCall,
  processPort,
  until,
  workerFixture,
} from "./device-fixtures.ts";

type Page = { sharedBotId: string; source: unknown; events: unknown[] };
type History = { head: string; entries: { model?: { sections?: object }[] }[] };
type Access = { local: { deviceId: string }; peer: { deviceId: string } };
const storeFixture = resolve(
  "tests/device-integration/sync-objects-store.fixture.mjs",
);
function counts(directory: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of ["replica.sqlite", "session.sqlite"]) {
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      for (const row of db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()) {
        const table = String(row.name);
        assert.match(table, /^[A-Za-z0-9_]+$/);
        result[name + ":" + table] = db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .get()?.n;
      }
    } finally {
      db.close();
    }
  }
  return result;
}
function changeBinding(
  directory: string,
  field: string,
  value: string,
): () => void {
  const db = new DatabaseSync(join(directory, "replica.sqlite"));
  try {
    const original = String(
      db.prepare("SELECT value FROM binding WHERE id=1").get()?.value,
    );
    const body = JSON.parse(original);
    body[field] = value;
    db.prepare("UPDATE binding SET value=? WHERE id=1").run(
      JSON.stringify(body),
    );
    return () => {
      const reopened = new DatabaseSync(join(directory, "replica.sqlite"));
      try {
        reopened.prepare("UPDATE binding SET value=? WHERE id=1").run(original);
      } finally {
        reopened.close();
      }
    };
  } finally {
    db.close();
  }
}
function storeCommand<T>(input: unknown): T {
  const result = spawnSync(process.execPath, [storeFixture], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
}
type RecordJSON = Record<string, unknown>;

const SWIFT_INPUTS = [
  "swiftc",
  "-parse-as-library",
  "-swift-version",
  "6",
  "apps/macos/Sources/EagleDevices/DeviceJSON.swift",
  "apps/macos/Sources/EagleDevices/DeviceHostConfiguration.swift",
  "apps/macos/Sources/EagleDevices/DeviceFileVault.swift",
  "apps/macos/Sources/EagleDevices/DeviceIdentity.swift",
  "apps/macos/Sources/EagleDevices/DeviceWrappingKey.swift",
  "apps/macos/Sources/EagleDevices/DevicePageKeys.swift",
  "apps/macos/Sources/EagleDevices/DeviceSyncProof.swift",
  "apps/macos/Sources/EagleDevices/DeviceLocalPort.swift",
  "apps/macos/Sources/EagleDevices/DeviceServiceHost.swift",
  "tests/device-integration/sync-objects-helper.fixture.swift",
];
type JSONRecord = Record<string, unknown>;
type ModelStep = { name: string; args: JSONRecord } | { text: string };
async function modelFixture(key: string) {
  const steps: ModelStep[] = [];
  const failures: string[] = [];
  const inputs: JSONRecord[] = [];
  let requests = 0;
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
      inputs.push(JSON.parse(body) as JSONRecord);
      const step = steps.shift();
      assert(step, "unexpected model request");
      requests++;
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
    script(name: string, args: JSONRecord, extraReplies = 0) {
      steps.push({ name, args }, { text: "done" });
      for (let i = 0; i < extraReplies; i++) steps.push({ text: "done" });
    },
    verify() {
      assert.deepEqual(failures, []);
      assert.equal(steps.length, 0);
      return requests;
    },
  };
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
  const snapshot = await frame("snapshot");
  const request = async (input: JSONRecord) => {
    messages.length = 0;
    socket.send(
      JSON.stringify({
        type: "send",
        whenBusy: "followUp",
        trace: `tr_retry_${randomUUID()}`,
        ...input,
      }),
    );
    return until(
      async () =>
        messages.find(
          (message) =>
            message.requestId === input.requestId &&
            (message.type === "error" ||
              (message.type === "submission" &&
                ["done", "unanswered"].includes(String(message.status)))),
        ),
      "actual SDK request outcome",
    );
  };
  return {
    socket,
    snapshot,
    messages,
    request,
    async run(
      name: string,
      model: Awaited<ReturnType<typeof modelFixture>>,
      args: JSONRecord = {},
      options: { resourceHead?: string; extraReplies?: number } = {},
    ) {
      messages.length = 0;
      model.script(name, args, options.extraReplies);
      const requestId = `r_${randomUUID()}`;
      socket.send(
        JSON.stringify({
          type: "send",
          requestId,
          text: `Integration: ${name}`,
          whenBusy: "followUp",
          trace: `tr_run_${randomUUID()}`,
          ...(options.resourceHead === undefined
            ? {}
            : { resourceHead: options.resourceHead }),
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
        requestId,
        text: result.text,
        isError: result.isError,
      };
    },
  };
}

async function helper(
  root: string,
  origin: string,
  waitCloud = true,
  cli?: string,
) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const executable = join(root, "../object-helper");
  if (!existsSync(executable)) {
    const built = spawnSync("xcrun", [...SWIFT_INPUTS, "-o", executable], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      },
      timeout: 60000,
    });
    assert.equal(
      built.status,
      0,
      `real Swift helper compilation: ${built.stderr}`,
    );
  }
  const script = join(root, "helper.mjs");
  writeFileSync(
    script,
    `import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(executable)},[],{stdio:'inherit'});
child.on('exit',code=>{process.exitCode=code??1;});`,
  );
  const service = processPort(script, root);
  const node = join(root, "owned-node");
  writeFileSync(
    node,
    `#!/bin/sh\nPATH='${cli ?? "/usr/bin"}:/usr/bin:/bin:/usr/sbin:/sbin' exec '${process.execPath}' '${resolve("tests/device-integration/sync-objects-node.fixture.mjs")}' '${root}' "$@"\n`,
  );
  chmodSync(node, 0o700);
  service.send({
    root,
    origin,
    waitCloud,
    node,
    entry: resolve("packages/agent/device-service.ts"),
  });
  try {
    const ready = await service.message((m) => m.type === "ready");
    return {
      ...service,
      deviceId: String(ready.deviceId),
      publicKey: String(ready.publicKey),
      socketPath: String(ready.socketPath),
      async manage(method: string, params: unknown) {
        const requestId = randomUUID();
        service.send({ method, params, requestId });
        const reply = await service.message(
          (m) => m.type === "managed" && m.requestId === requestId,
        );
        assert.equal(
          reply.error,
          undefined,
          "actual trusted Host management call",
        );
        return reply.result as RecordJSON;
      },
    };
  } catch (error) {
    await service.stop();
    throw error;
  }
}
async function daemon(
  root: string,
  socketPath: string,
  baseUrl: string,
  key: string,
  owned: { listener?: boolean; peerPort?: number; listenerPort?: number } = {},
) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const script = join(root, "daemon.mjs");
  writeFileSync(
    script,
    `import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const reader=createInterface({input:process.stdin});const lines=reader[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value);
Object.assign(process.env,{BOTS_BASE_URL:config.baseUrl,BOTS_API_KEY:config.key,BOTS_PROVIDER:'device-local',BOTS_MODEL:'scripted-local',BOTS_THINKING_LEVEL:'off',BOTS_TOOL_GROUPS:'core',BOTS_COMPACTION:'off'});
const fs=await import('node:fs/promises');
const {syncBuiltinESMExports}=await import('node:module');
let holdStage=false,releaseStage;
const originalFileOpen=fs.default.open;
fs.default.open=async function(path,...args){
 const file=await originalFileOpen(path,...args);
 if(String(path).includes('/.stage-')){
  const originalSync=file.sync.bind(file);
  file.sync=async()=>{await originalSync();if(holdStage && (holdStage!=='slot'||String(path).includes('.recipients/'))){holdStage=false;process.stdout.write(JSON.stringify({type:'stageHeld'})+'\\n');await new Promise(resolve=>{releaseStage=resolve;});}};
 }
 return file;
};syncBuiltinESMExports();
const originalNow=Date.now;
const {readConfig}=await import(pathToFileURL(config.source+'/src/config.ts').href);
const {startDaemon}=await import(pathToFileURL(config.source+'/src/main.ts').href);
const {SocketDeviceSyncPort}=await import(pathToFileURL(config.source+'/src/device-sync.ts').href);
let holdKey=false,releaseKey;
const originalOpen=SocketDeviceSyncPort.prototype.openKey;
SocketDeviceSyncPort.prototype.openKey=async function(...args){
 const result=await originalOpen.apply(this,args);
 if(holdKey){holdKey=false;process.stdout.write(JSON.stringify({type:'keyHeld'})+'\\n');await new Promise(resolve=>{releaseKey=resolve;});}
 return result;
};
let dispatcher;
if(config.owned.peerPort){
 const {Agent,buildConnector,setGlobalDispatcher}=await import(pathToFileURL(config.repository+'/node_modules/undici/index.js').href);
 const connector=buildConnector({});dispatcher=new Agent({connect(options,callback){connector(options.hostname==='100.64.1.2'&&Number(options.port)===config.owned.peerPort?{...options,hostname:'127.0.0.1',host:'127.0.0.1'}:options,callback);}});setGlobalDispatcher(dispatcher);
}
const daemon=await startDaemon(readConfig({argv:['--root',config.root,'--port','0'],env:{BOTS_DEVICE_SOCKET:config.socketPath}}));
let server;
if(config.owned.listener){
 const {createServer}=await import('node:http');server=createServer(daemon.sync.handler);
 await new Promise(resolve=>server.listen(config.owned.listenerPort??0,'127.0.0.1',resolve));
}
process.stdout.write(JSON.stringify({type:'ready',port:daemon.port,peerPort:server?.address().port})+'\\n');
for await(const line of lines){
 const input=JSON.parse(line);let result={};
 if(input.command==='holdKey')holdKey=true;
 if(input.command==='holdStage')holdStage=true;
 if(input.command==='holdSlot')holdStage='slot';
 if(input.command==='releaseStage'){releaseStage?.();releaseStage=undefined;}
 if(input.command==='advance')Date.now=()=>originalNow()+60001;
 if(input.command==='resetClock')Date.now=originalNow;
 if(input.command==='shutdownRegistry')await daemon.registry.shutdown();
 if(input.command==='releaseKey'){releaseKey?.();releaseKey=undefined;}
 if(input.command==='clearReady')daemon.sync.setReady(undefined);
 if(input.command==='closeSync')daemon.sync.close();
 if(input.command==='applyProbe'){
  try{await daemon.sync.applyObject(input.botId,input.objectId,input.trace);result={unexpected:true};}
  catch(error){result={kind:error.failure?.kind,causeCode:error.cause?.code,failure:error.failure?.id};}
 }
 process.stdout.write(JSON.stringify({type:'controlled',requestId:input.requestId,...result})+'\\n');
};
if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
await daemon.close();await dispatcher?.close();reader.close();`,
  );
  const service = processPort(script, root);
  service.send({
    root,
    socketPath,
    baseUrl,
    key,
    source: resolve("apps/bots"),
    repository: resolve("."),
    owned,
  });
  try {
    const ready = await service.message((m) => m.type === "ready");
    const token = readFileSync(join(root, "token"), "utf8").trim();
    return {
      ...service,
      origin: `http://127.0.0.1:${ready.port}`,
      token,
      peerPort: Number(ready.peerPort),
      async control(command: string, params: RecordJSON = {}) {
        const requestId = randomUUID();
        service.send({ command, requestId, ...params });
        return service.message(
          (m) => m.type === "controlled" && m.requestId === requestId,
        );
      },
      async post<T = RecordJSON>(path: string, body: unknown, method = "POST") {
        const response = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as T;
        assert(
          response.ok,
          `actual Bot route ${path}: ${response.status} ${JSON.stringify(result)}`,
        );
        return result;
      },
    };
  } catch (error) {
    await service.stop();
    throw error;
  }
}

test("real main peer/PR history object cold-starts offline with exact bytes/head/sections and passive zero execution", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-encrypted-entry-"));
  const workerRoot = mkdtempSync(resolve(".local/encrypted-entry-worker-"));
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key),
    server = model.server,
    modelOrigin = model.baseUrl;
  let baseline = 0;
  const clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  const services: { stop(): Promise<void> }[] = [];
  const bots: { stop(): Promise<void> }[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot);
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const cli = join(root, "cli");
    mkdirSync(cli);
    writeFileSync(
      join(cli, "tailscale"),
      `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2"]}}'\n`,
    );
    chmodSync(join(cli, "tailscale"), 0o700);
    const b = await helper(join(root, "b"), worker.origin, true, cli);
    services.push(b);
    assert.notEqual(a.deviceId, b.deviceId);
    assert.notEqual(a.publicKey, b.publicKey);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    let bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      modelOrigin,
      key,
      { listener: true },
    );
    bots.push(bd);
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      modelOrigin,
      key,
      { peerPort: bd.peerPort },
    );
    bots.push(ad);
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", { title: "Reader" })
    ).bot.id;
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", { title: "Publisher" })
    ).bot.id;
    const sharedBotId = randomUUID();
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    const carrier = await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    assert.equal(carrier.kind, "resources");
    const initial = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    assert.equal(initial.events.length, resources.length + 1);
    let sourceClient = await botConnection(bd.origin, bd.token, bb);
    clients.push(sourceClient);
    const native = await sourceClient.run(
      "bash",
      model,
      {
        command: "printf source-history",
      },
      { resourceHead: String(carrier.head) },
    );
    assert.equal(native.isError, false);
    const target = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Local peer",
      })
    ).bot.id;
    const targetResources = await bd.post(`/v1/bots/${target}/replica/export`, {
      kind: "resources",
      resources,
    });
    const targetClient = await botConnection(bd.origin, bd.token, target);
    clients.push(targetClient);
    assert.equal(
      (
        await targetClient.run(
          "bash",
          model,
          { command: "printf target-selected" },
          { resourceHead: String(targetResources.head) },
        )
      ).isError,
      false,
    );
    await bd.post(
      "/v1/settings",
      { toolGroups: ["core", "coding", "peers"] },
      "PUT",
    );
    assert.deepEqual(
      await bd.post(`/v1/bots/${bb}/replica/export`, {
        kind: "resources",
        head: carrier.head,
      }),
      carrier,
    );
    const pull = {
      url: "https://github.com/nocoo/eagle/pull/109",
      title: "combined journal fixture",
      status: "merged",
    };
    const reported = await sourceClient.run("pr_register", model, pull, {
      resourceHead: String(carrier.head),
    });
    assert.equal(reported.isError, false);
    const pullEvent = sourceClient.messages.find(
      (message) => message.type === "pulls",
    );
    assert(
      pullEvent,
      "production main connects the pull publisher to the subscribed client",
    );
    const reportedPulls = pullEvent.pulls;
    assert.match(JSON.stringify(reportedPulls), /combined journal fixture/);
    const peerStart = model.inputs.length;
    const sent = await sourceClient.run(
      "peer_send",
      model,
      { botId: target, message: "combined-local-peer" },
      { resourceHead: String(carrier.head), extraReplies: 1 },
    );
    assert.equal(sent.isError, false);
    const exchanges = (await (
      await fetch(`${bd.origin}/v1/bots/${bb}/exchanges`, {
        headers: { authorization: `Bearer ${bd.token}` },
      })
    ).json()) as { exchanges: { id: string }[] };
    assert.equal(exchanges.exchanges.length, 1);
    const [summary] = exchanges.exchanges;
    assert(summary);
    const exchangeId = summary.id;
    const exchange = await until(async () => {
      const result = (await (
        await fetch(`${bd.origin}/v1/bots/${bb}/exchanges/${exchangeId}`, {
          headers: { authorization: `Bearer ${bd.token}` },
        })
      ).json()) as {
        exchange: {
          turns: { requestId: string; text: string; answer?: string }[];
        };
      };
      return result.exchange.turns[0]?.answer === "done"
        ? result.exchange
        : undefined;
    }, "real peer answer through main HTTP API");
    const [peerTurn] = exchange.turns;
    assert(peerTurn);
    const peerRequestId = peerTurn.requestId;
    const peerInputs = model.inputs
      .slice(peerStart)
      .filter(
        (input) =>
          JSON.stringify(input).includes("combined-local-peer") &&
          !JSON.stringify(input).includes("Integration: peer_send"),
      );
    assert.equal(peerInputs.length, 1);
    const instructions = Buffer.from(resources[0].base64, "base64")
      .toString("utf8")
      .trim();
    assert.equal(
      JSON.stringify(peerInputs[0]).includes(instructions),
      false,
      "new peer invocation never inherits sender or target active resources",
    );
    const sourceInputs = model.inputs
      .slice(peerStart)
      .filter((input) =>
        JSON.stringify(input).includes("Integration: peer_send"),
      );
    assert(
      sourceInputs.some((input) =>
        JSON.stringify(input).includes(instructions),
      ),
      "tool refresh retains the bots-resources extension",
    );
    const targetDb = new DatabaseSync(
      join(root, "b-bots/bots", target, "replica.sqlite"),
      { readOnly: true },
    );
    try {
      const row = targetDb
        .prepare("SELECT value FROM local_runs WHERE request_id=?")
        .get(peerRequestId);
      assert(row);
      const intent = JSON.parse(String(row.value)).intent;
      assert.equal(intent.resourceHead, undefined);
      assert.equal(intent.resourceVersion, undefined);
    } finally {
      targetDb.close();
    }
    const providerBeforeRetry = model.verify();
    const peerRetry = await targetClient.request({
      requestId: peerRequestId,
      text: "combined-local-peer",
    });
    assert.equal(peerRetry.type, "submission");
    assert.equal(peerRetry.status, "done");
    const conflict = await targetClient.request({
      requestId: peerRequestId,
      text: "combined-local-peer",
      resourceHead: targetResources.head,
    });
    assert.equal(conflict.type, "error");
    assert.equal(conflict.disposition, "not_admitted");
    assert.equal(model.verify(), providerBeforeRetry);
    console.log(
      JSON.stringify({
        combinedMain: {
          peerAnswer: peerTurn.answer,
          peerLegacyEmpty: true,
          retryNoNewExecution: true,
          conflictingResourcesRejected: true,
          pullEvent: true,
          refreshedResourcesIntact: true,
        },
      }),
    );
    const journalFile = join(root, "b-bots/bots", bb, "pulls.journal.jsonl");
    const journal = readFileSync(journalFile);
    for (const client of [sourceClient, targetClient])
      await new Promise<void>((done) => {
        client.socket.once("close", () => done());
        client.socket.close();
      });
    const listenerPort = bd.peerPort;
    await bd.stop();
    bd = await daemon(join(root, "b-bots"), b.socketPath, modelOrigin, key, {
      listener: true,
      listenerPort,
    });
    bots.push(bd);
    sourceClient = await botConnection(bd.origin, bd.token, bb);
    clients.push(sourceClient);
    assert.deepEqual(
      (sourceClient.snapshot.value as JSONRecord).pulls,
      reportedPulls,
    );
    assert.deepEqual(readFileSync(journalFile), journal);
    baseline = model.verify();
    assert.equal(baseline, 9);
    const history = await bd.post<History>(`/v1/bots/${bb}/replica/export`, {});
    assert(history.entries.length > 0);
    assert.match(JSON.stringify(history.entries), /pr_register/);
    assert.match(JSON.stringify(history.entries), /peer_send/);
    assert.match(JSON.stringify(history.entries), /combined journal fixture/);
    const sectionOrders = (bundle: History) =>
      bundle.entries.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.sections ? [Object.keys(message.sections)] : [],
        ),
      );
    const originalSections = sectionOrders(history);
    assert(originalSections.some((keys: string[]) => keys.length > 1));
    const page = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    assert.equal(page.sharedBotId, sharedBotId);
    assert(page.events.length > initial.events.length);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const access = (await localCall(a.socketPath, "sync.access", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    })) as Access;
    assert.equal(access.local.deviceId, a.deviceId);
    assert.equal(access.peer.deviceId, b.deviceId);
    const authorized = (await localCall(b.socketPath, "sync.peer.authorize", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      purpose: "replica.read",
    })) as Access;
    assert.equal(authorized.local.deviceId, b.deviceId);
    await assert.rejects(
      localCall(a.socketPath, "sync.peer.authorize", {
        sharedBotId,
        peerDeviceId: b.deviceId,
        purpose: "replica.read",
      }),
      /sync_not_shared/,
    );
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const grants = await storage.exec(
      "SELECT grantingDeviceId,peerDeviceId FROM sync_grants WHERE sharedBotId=?",
      sharedBotId,
    );
    assert.deepEqual(
      grants.map((row) => [row.grantingDeviceId, row.peerDeviceId]),
      [[b.deviceId, a.deviceId]],
    );
    assert.equal(model.verify(), baseline);
    console.log(
      JSON.stringify({
        prerequisite:
          "real Swift DeviceFileVault+DeviceIdentity+DeviceServiceHost / owned Node / Registry SQLite / paired independent identities / B->A only / actual Bot bindings and resources page",
        providerDelta: model.verify() - baseline,
        pageEvents: page.events.length,
      }),
    );
    await b.manage("sync.endpoints.publish", { syncPort: bd.peerPort });
    const [pulled, concurrent] = await Promise.all(
      [1, 2].map(() =>
        ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
          peerDeviceId: b.deviceId,
          after: 0,
        }),
      ),
    );
    assert.equal(pulled.objectId, concurrent.objectId);
    assert.equal(pulled.cipherDigest, concurrent.cipherDigest);
    assert.equal(pulled.stored, true);
    assert.equal(pulled.applied, false);
    const objectId = pulled.objectId;
    const aFile = join(root, "a-bots/sync-objects/v1", objectId + ".json");
    const bFile = join(root, "b-bots/sync-objects/v1", objectId + ".json");
    const originalA = readFileSync(aFile),
      originalB = readFileSync(bFile);
    const alternative = await ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
      peerDeviceId: b.deviceId,
      after: 0,
      limit: 1,
    });
    assert.notEqual(alternative.objectId, objectId);
    const alternativeBytes = readFileSync(
      join(root, "a-bots/sync-objects/v1", alternative.objectId + ".json"),
    );
    const wrongWinnerRoot = join(root, "wrong-object-winner");
    mkdirSync(wrongWinnerRoot, { mode: 0o700 });
    const wrongWinners = storeCommand<{ mode: string; accepted: boolean }[]>({
      mode: "wrong-object-winner",
      root: wrongWinnerRoot,
      record: JSON.parse(originalA.toString()),
      other: JSON.parse(alternativeBytes.toString()),
    });
    const beforeWrongWinner = counts(join(root, "a-bots/bots", ab));
    unlinkSync(aFile);
    assert.equal(existsSync(aFile), false);
    await ad.control("holdStage");
    const substitutedPull = fetch(
      ad.origin + `/v1/bots/${ab}/sync/objects/pull`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ peerDeviceId: b.deviceId, objectId }),
      },
    );
    await ad.message((m) => m.type === "stageHeld");
    writeFileSync(aFile, alternativeBytes, { flag: "wx", mode: 0o600 });
    await ad.control("releaseStage");
    const substitutedResponse = await substitutedPull;
    const substitutedResult = (await substitutedResponse.json()) as RecordJSON;
    assert.deepEqual(readFileSync(aFile), alternativeBytes);
    unlinkSync(aFile);
    writeFileSync(aFile, originalA, { flag: "wx", mode: 0o600 });
    assert.deepEqual(counts(join(root, "a-bots/bots", ab)), beforeWrongWinner);
    assert.equal(model.verify(), baseline);
    console.log(
      JSON.stringify({
        wrongObjectWinner: {
          requested: objectId,
          substituted: alternative.objectId,
          sameBotBindingPublisher: true,
          legalSignedRecord: true,
          store: wrongWinners,
          routeStatus: substitutedResponse.status,
          routeResult: substitutedResult,
          executionDelta: 0,
        },
      }),
    );
    assert.equal(
      substitutedResponse.status,
      403,
      "no stored ACK for a valid different-objectId winner",
    );
    assert.notEqual(substitutedResult.stored, true);
    for (const result of wrongWinners)
      assert.equal(
        result.accepted,
        false,
        result.mode + " must bind the target objectId",
      );
    const publisherRecord = JSON.parse(originalB.toString());
    const prepared = storeCommand<{
      key: string;
      manifest: unknown;
      ciphertext: string;
    }>({
      mode: "prepare",
      page,
      publisher: publisherRecord.pin.publisher,
      origin: worker.origin,
    });
    const sealed = (await localCall(b.socketPath, "sync.key.seal", {
      version: 1,
      identity: publisherRecord.pin.publisher,
      manifest: prepared.manifest,
      dek: prepared.key,
    })) as RecordJSON;
    const other = storeCommand({
      mode: "record",
      record: publisherRecord,
      carrier: { version: 1, ...sealed, ciphertext: prepared.ciphertext },
    });
    const storeRoot = join(root, "store-invariants");
    mkdirSync(storeRoot, { mode: 0o700 });
    const invariants = storeCommand({
      mode: "invariants",
      root: storeRoot,
      record: publisherRecord,
      other,
    });
    console.log(JSON.stringify({ storeInvariants: invariants }));
    const slotDirectory = join(
      root,
      "b-bots/sync-objects/v1",
      objectId + ".recipients",
    );
    assert.equal(readdirSync(slotDirectory).length, 1);
    const slotPath = join(slotDirectory, readdirSync(slotDirectory)[0]);
    const originalSlot = readFileSync(slotPath);
    const issuedRecord = JSON.parse(originalA.toString());
    const issueRequest = {
      version: 1,
      identity: publisherRecord.pin.publisher,
      manifest: publisherRecord.carrier.manifest,
      envelope: publisherRecord.carrier.envelope,
      recipient: issuedRecord.pin.recipient,
      recipientDescriptor: issuedRecord.carrier.envelope.recipientDescriptor,
    };
    const hold = join(root, "b/hold-helper"),
      held = join(root, "b/helper-held");
    writeFileSync(hold, "sync_key_envelope_result");
    const issuing = localCall(b.socketPath, "sync.key.envelope", issueRequest);
    void issuing.catch(() => {});
    await until(
      async () => (existsSync(held) ? true : undefined),
      "actual helper envelope response held before Node authorization recheck",
    );
    await storage.exec(
      "DELETE FROM sync_grants WHERE grantingDeviceId=? AND sharedBotId=? AND peerDeviceId=?",
      b.deviceId,
      sharedBotId,
      a.deviceId,
    );
    unlinkSync(hold);
    await assert.rejects(issuing, /sync_not_shared/);
    unlinkSync(held);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    assert.equal(model.verify(), baseline);
    const readerRecord = JSON.parse(originalA.toString());
    const descriptors = [];
    for (let i = 0; i < 2; i++)
      descriptors.push({
        issuer: await localCall(b.socketPath, "sync.key.descriptor", {}),
        recipient: await localCall(a.socketPath, "sync.key.descriptor", {}),
      });
    console.log(
      JSON.stringify({
        descriptorSlots: storeCommand({
          mode: "slots",
          root: join(root, "b-bots"),
          record: publisherRecord,
          issuer: publisherRecord.pin.publisher,
          recipient: readerRecord.pin.recipient,
          descriptors,
        }),
      }),
    );
    assert.equal(readdirSync(slotDirectory).length, 1);
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    const ioBefore = counts(join(root, "a-bots/bots", ab));
    chmodSync(aFile, 0o000);
    const probe = await ad.control("applyProbe", {
      botId: ab,
      objectId,
      trace: "tr_object_storage_owned",
    });
    const denied = await fetch(
      ad.origin + `/v1/bots/${ab}/sync/objects/apply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectId }),
      },
    );
    chmodSync(aFile, 0o600);
    assert.equal(denied.status, 503);
    assert.equal(probe.kind, "storage_failed");
    assert.equal(probe.causeCode, "EACCES");
    const logs = readdirSync(join(root, "a-bots/logs")).flatMap((file) =>
      readFileSync(join(root, "a-bots/logs", file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const attributed = logs.filter((log) => log.err?.failure === probe.failure);
    assert.equal(
      attributed.filter(
        (log) => log.level === "error" && log.err.origin === true,
      ).length,
      1,
    );
    assert(
      attributed.every(
        (log) => log.trace === "tr_object_storage_owned" && log.botId === ab,
      ),
    );
    const badCipher = JSON.parse(originalA.toString());
    badCipher.carrier.ciphertext = "A" + badCipher.carrier.ciphertext.slice(1);
    writeFileSync(aFile, JSON.stringify(badCipher));
    const cryptoDenied = await fetch(
      ad.origin + `/v1/bots/${ab}/sync/objects/apply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectId }),
      },
    );
    writeFileSync(aFile, originalA);
    assert.equal(cryptoDenied.status, 403);
    assert.deepEqual(counts(join(root, "a-bots/bots", ab)), ioBefore);
    assert.equal(model.verify(), baseline);
    const retry = await ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
      peerDeviceId: b.deviceId,
      objectId,
    });
    assert.equal(retry.objectId, objectId);
    assert.deepEqual(readFileSync(aFile), originalA);
    assert.deepEqual(readFileSync(bFile), originalB);
    assert.equal(readdirSync(slotDirectory).length, 1);
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    await b.stop();
    const reopenedB = await helper(join(root, "b"), worker.origin, true, cli);
    services.push(reopenedB);
    assert.equal(reopenedB.deviceId, b.deviceId);
    await ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
      peerDeviceId: b.deviceId,
      objectId,
    });
    assert.deepEqual(readFileSync(bFile), originalB);
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    for (const boundary of [
      "publisher-epoch",
      "publisher-generation",
      "publisher-expiry",
      "slot-epoch",
      "slot-generation",
      "slot-expiry",
    ]) {
      const targetA = (
        await ad.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Server fence reader " + boundary,
        })
      ).bot.id;
      const targetB = (
        await bd.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Server fence source " + boundary,
        })
      ).bot.id;
      const shared = randomUUID();
      await ad.post(`/v1/bots/${targetA}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/export`, {
        kind: "resources",
        resources,
      });
      await reopenedB.manage("sync.share", {
        sharedBotId: shared,
        peerDeviceId: a.deviceId,
        enabled: true,
      });
      const aDirectory = join(root, "a-bots/bots", targetA),
        bDirectory = join(root, "b-bots/bots", targetB);
      const beforeA = counts(aDirectory),
        beforeB = counts(bDirectory);
      const objectDirectory = join(root, "b-bots/sync-objects/v1");
      const beforeFiles = readdirSync(objectDirectory).filter((name) =>
        name.endsWith(".json"),
      );
      await bd.control(boundary.startsWith("slot") ? "holdSlot" : "holdStage");
      const pending = ad.post(`/v1/bots/${targetA}/sync/objects/pull`, {
        peerDeviceId: b.deviceId,
        after: 0,
      });
      void pending.catch(() => {});
      await bd.message((m) => m.type === "stageHeld");
      const restore = boundary.endsWith("epoch")
        ? changeBinding(bDirectory, "epoch", randomUUID())
        : () => {};
      if (boundary.endsWith("generation")) await bd.control("clearReady");
      if (boundary.endsWith("expiry")) await bd.control("advance");
      await bd.control("releaseStage");
      try {
        await assert.rejects(pending, /400|403/);
      } finally {
        restore();
        if (boundary.endsWith("expiry")) await bd.control("resetClock");
      }
      assert.deepEqual(counts(aDirectory), beforeA);
      assert.deepEqual(counts(bDirectory), beforeB);
      const afterFiles = readdirSync(objectDirectory).filter((name) =>
        name.endsWith(".json"),
      );
      assert.equal(
        afterFiles.length - beforeFiles.length,
        boundary.startsWith("slot") ? 1 : 0,
      );
      for (const name of readdirSync(objectDirectory).filter((name) =>
        name.endsWith(".recipients"),
      )) {
        if (!beforeFiles.includes(name.replace(".recipients", ".json")))
          assert.equal(readdirSync(join(objectDirectory, name)).length, 0);
      }
      assert.equal(model.verify(), baseline);
      console.log(
        JSON.stringify({
          actualServerStagedBoundary: boundary,
          readerStored: false,
          executionDelta: 0,
        }),
      );
    }
    for (const boundary of [
      "epoch",
      "replicaId",
      "sharedBotId",
      "localBotId",
      "generation",
      "expiry",
      "grant",
      "delete",
      "close",
    ]) {
      const targetA = (
        await ad.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Fence reader " + boundary,
        })
      ).bot.id;
      const targetB = (
        await bd.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Fence source " + boundary,
        })
      ).bot.id;
      const shared = randomUUID();
      await ad.post(`/v1/bots/${targetA}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/export`, {
        kind: "resources",
        resources,
      });
      await reopenedB.manage("sync.share", {
        sharedBotId: shared,
        peerDeviceId: a.deviceId,
        enabled: true,
      });
      const directory = join(root, "a-bots/bots", targetA),
        before = counts(directory);
      const existingFiles = readdirSync(
        join(root, "a-bots/sync-objects/v1"),
      ).filter((name) => name.endsWith(".json"));
      await ad.control("holdStage");
      const pending = ad.post(`/v1/bots/${targetA}/sync/objects/pull`, {
        peerDeviceId: b.deviceId,
        after: 0,
      });
      void pending.catch(() => {});
      await ad.message((m) => m.type === "stageHeld");
      let restore = () => {};
      if (
        ["epoch", "replicaId", "sharedBotId", "localBotId"].includes(boundary)
      )
        restore = changeBinding(directory, boundary, randomUUID());
      if (boundary === "generation") await ad.control("clearReady");
      if (boundary === "expiry") await ad.control("advance");
      if (boundary === "grant")
        await reopenedB.manage("sync.share", {
          sharedBotId: shared,
          peerDeviceId: a.deviceId,
          enabled: false,
        });
      if (boundary === "close") await ad.control("shutdownRegistry");
      if (boundary === "delete") {
        const deleted = await fetch(ad.origin + `/v1/bots/${targetA}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${ad.token}` },
        });
        assert.equal(deleted.ok, true);
      }
      await ad.control("releaseStage");
      try {
        await assert.rejects(
          pending,
          boundary === "localBotId" ? /503/ : /400|403|404/,
        );
      } finally {
        restore();
        if (boundary === "expiry") await ad.control("resetClock");
      }
      assert.deepEqual(
        readdirSync(join(root, "a-bots/sync-objects/v1")).filter((name) =>
          name.endsWith(".json"),
        ),
        existingFiles,
        "no rejected pin publication",
      );
      if (boundary !== "delete")
        assert.deepEqual(
          counts(directory),
          before,
          "no SDK or replica admission",
        );
      assert.equal(model.verify(), baseline);
      console.log(
        JSON.stringify({
          actualStagedBoundary: boundary,
          published: false,
          executionDelta: 0,
        }),
      );
    }
    await reopenedB.manage("member.remove", { deviceId: a.deviceId });
    const revokedRows = await storage.exec(
      "SELECT groupId,membershipEpoch,credentialVersion FROM devices WHERE deviceId=?",
      a.deviceId,
    );
    assert.equal(revokedRows[0]?.groupId, null);
    assert(Number(revokedRows[0]?.credentialVersion) > 1);
    await assert.rejects(
      localCall(reopenedB.socketPath, "sync.key.envelope", {
        version: 1,
        identity: publisherRecord.pin.publisher,
        manifest: publisherRecord.carrier.manifest,
        envelope: publisherRecord.carrier.envelope,
        recipient: readerRecord.pin.recipient,
        recipientDescriptor: readerRecord.carrier.envelope.recipientDescriptor,
      }),
    );
    const record = JSON.parse(originalA.toString());
    assert.equal(record.pin.publisher.deviceId, b.deviceId);
    assert.equal(record.pin.recipient.deviceId, a.deviceId);
    const origin = worker.origin;
    await new Promise<void>((done) => {
      sourceClient.socket.once("close", () => done());
      sourceClient.socket.close();
    });
    await bd.stop();
    await reopenedB.stop();
    await ad.stop();
    await a.stop();
    await worker.mf.dispose();
    worker = undefined;
    // Cold start begins only after both publisher and Registry are gone; localReady alone.
    const offlineA = await helper(join(root, "a"), origin, false);
    services.push(offlineA);
    const bindingFile = join(root, "a-bots/bots", ab, "replica.sqlite");
    chmodSync(bindingFile, 0o000);
    const offlineDaemon = await daemon(
      join(root, "a-bots"),
      offlineA.socketPath,
      modelOrigin,
      key,
    );
    bots.push(offlineDaemon);
    chmodSync(bindingFile, 0o600);
    const opens = () =>
      readdirSync(join(root, "a-bots/logs"))
        .flatMap((file) =>
          readFileSync(join(root, "a-bots/logs", file), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
        .filter((log) => log.evt === "runtime.open.start").length;
    const beforeSync = opens();
    const peerDirectory = join(root, "a-bots/peers");
    const peersBefore = readdirSync(peerDirectory).map((file) => [
      file,
      readFileSync(join(peerDirectory, file)).toString("base64"),
    ]);
    await assert.rejects(
      offlineDaemon.post(`/v1/bots/${ab}/sync/objects/apply`, { objectId }),
      /400|403/,
    );
    assert.equal(
      opens(),
      beforeSync,
      "only-sync cannot reopen the repaired unavailable local Bot",
    );
    assert.equal(model.verify(), baseline);
    const openedClient = await botConnection(
      offlineDaemon.origin,
      offlineDaemon.token,
      ab,
    );
    clients.push(openedClient);
    assert.equal(model.verify(), baseline);
    const executionCounts = () =>
      Object.fromEntries(
        Object.entries(counts(join(root, "a-bots/bots", ab))).filter(([name]) =>
          /submission|task|local_runs/.test(name),
        ),
      );
    const executionBeforePassive = executionCounts();
    assert("replica.sqlite:local_runs" in executionBeforePassive);
    await offlineDaemon.control("holdKey");
    const passive = offlineDaemon.post(`/v1/bots/${ab}/sync/objects/apply`, {
      objectId,
    });
    void passive.catch(() => {});
    await offlineDaemon.message((m) => m.type === "keyHeld");
    await offlineDaemon.control("clearReady");
    await offlineDaemon.control("releaseKey");
    await passive;
    const reapplied = await offlineDaemon.post(`/v1/bots/${ab}/replica/pull`, {
      source: page.source,
      after: 0,
    });
    assert.equal(JSON.stringify(reapplied), JSON.stringify(page));
    const restored = await offlineDaemon.post<History>(
      `/v1/bots/${ab}/replica/export`,
      { head: history.head },
    );
    assert.equal(restored.head, history.head);
    assert.equal(
      JSON.stringify(restored.entries),
      JSON.stringify(history.entries),
    );
    assert.deepEqual(sectionOrders(restored), originalSections);
    assert.deepEqual(
      executionCounts(),
      executionBeforePassive,
      "passive import admits no local submission, invocation or tool task",
    );
    assert.deepEqual(
      readdirSync(peerDirectory).map((file) => [
        file,
        readFileSync(join(peerDirectory, file)).toString("base64"),
      ]),
      peersBefore,
      "passive history import does not create local peer exchanges",
    );
    assert.equal(
      existsSync(join(root, "a-bots/bots", ab, "pulls.journal.jsonl")),
      false,
      "historical PR tool records do not replay the report tool",
    );
    const { manifest, envelope } = record.carrier,
      { pin } = record;
    const keyResult = (await localCall(offlineA.socketPath, "sync.key.open", {
      version: 1,
      manifest,
      envelope,
      publisherPin: pin.publisher,
      issuerPin: pin.issuer,
      recipientPin: pin.recipient,
    })) as RecordJSON;
    const {
      signature: _signature,
      cipherDigest: _cipherDigest,
      ...header
    } = manifest;
    const encrypted = Buffer.from(record.carrier.ciphertext, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(String(keyResult.dek), "base64url"),
      Buffer.from(manifest.nonce, "base64url"),
    );
    decipher.setAAD(
      Buffer.from("eagle-bots-page-object-v1\n" + canonicalDeviceJSON(header)),
    );
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(0, -16)),
      decipher.final(),
    ]);
    assert.deepEqual(plaintext, Buffer.from(JSON.stringify(page)));
    assert.equal(
      manifest.pageDigest,
      createHash("sha256").update(JSON.stringify(page)).digest("hex"),
    );
    assert.deepEqual(readFileSync(aFile), originalA);
    assert.equal(model.verify(), baseline);
    for (const boundary of ["epoch", "close"]) {
      const directory = join(root, "a-bots/bots", ab),
        before = counts(directory);
      await offlineDaemon.control("holdKey");
      const pending = offlineDaemon.post(`/v1/bots/${ab}/sync/objects/apply`, {
        objectId,
      });
      void pending.catch(() => {});
      await offlineDaemon.message((m) => m.type === "keyHeld");
      const restore =
        boundary === "epoch"
          ? changeBinding(directory, "epoch", randomUUID())
          : () => {};
      if (boundary === "close") await offlineDaemon.control("closeSync");
      await offlineDaemon.control("releaseKey");
      try {
        await assert.rejects(pending, boundary === "epoch" ? /400/ : /403/);
      } finally {
        restore();
      }
      assert.deepEqual(counts(directory), before);
      assert.equal(model.verify(), baseline);
    }
    const proof = await openedClient.run("bash", model, {
      command: "printf offline-native",
    });
    assert.equal(proof.isError, false);
    assert.equal(model.verify(), baseline + 2);
    await offlineA.stop();
    const wrappingPath = join(
      root,
      "a/vault",
      createHash("sha256")
        .update("eagle-bots-wrap-v1:encrypted-object-fixture")
        .digest("hex") + ".json",
    );
    assert(existsSync(wrappingPath));
    unlinkSync(wrappingPath);
    const missingA = await helper(join(root, "a"), origin, false);
    services.push(missingA);
    assert.equal(missingA.deviceId, a.deviceId);
    await assert.rejects(
      localCall(missingA.socketPath, "sync.key.open", {
        version: 1,
        manifest,
        envelope,
        publisherPin: pin.publisher,
        issuerPin: pin.issuer,
        recipientPin: pin.recipient,
      }),
    );
    assert.equal(
      existsSync(wrappingPath),
      false,
      "opening an old object must not silently create a replacement wrapping identity",
    );
    console.log(
      JSON.stringify({
        coldOffline: true,
        historyEntries: history.entries.length,
        sectionOrders: originalSections,
        originalPlaintextBytes: plaintext.length,
        passiveProviderDelta: 0,
        explicitSetupProvider: baseline,
        explicitNativeProviderDelta: 2,
      }),
    );
  } catch (error) {
    for (const dir of ["a-bots", "b-bots"]) {
      try {
        console.log(
          JSON.stringify({
            daemon: dir,
            failures: readdirSync(join(root, dir, "logs"))
              .flatMap((file) =>
                readFileSync(join(root, dir, "logs", file), "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line)),
              )
              .filter((log) => ["warn", "error"].includes(log.level)),
          }),
        );
      } catch {}
    }
    throw error;
  } finally {
    for (const client of clients) {
      if (client.socket.readyState === WebSocket.OPEN)
        await new Promise<void>((done) => {
          client.socket.once("close", () => done());
          client.socket.close();
        });
    }
    for (const service of bots.reverse()) await service.stop();
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  }
});
