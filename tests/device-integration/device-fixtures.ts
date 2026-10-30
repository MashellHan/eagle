import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  SyncProofRequest,
  syncProofPayload,
} from "../../packages/contracts/src/device-sync.ts";

type JSONRecord = Record<string, unknown>;

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

export async function until<T>(
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

export function processPort(
  file: string,
  root: string,
  extra: Readonly<Record<string, string | undefined>> = {},
) {
  const child = spawn(process.execPath, [file], {
    cwd: resolve("."),
    env: { ...childEnv(root), ...extra },
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

export function deviceProcess(
  root: string,
  baseUrl: string,
  cliDirectory?: string,
) {
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
    cliDirectory === undefined
      ? {}
      : { PATH: cliDirectory + ":/usr/bin:/bin:/usr/sbin:/sbin" },
  );
  let pauseProof = false;
  let proofRequests = 0;
  const heldProofs: (() => void)[] = [];
  process.handle((message) => {
    if (message.type === "sync_proof") {
      proofRequests++;
      const request = SyncProofRequest.parse(message.request);
      assert.equal(request.registryOrigin, baseUrl);
      assert.equal(request[request.role].deviceId, deviceId);
      assert.equal(request[request.role].publicKey, publicKey);
      const respond = () =>
        process.send({
          type: "sync_signature",
          requestId: message.requestId,
          signature: sign(
            null,
            Buffer.from(syncProofPayload(request)),
            keys.privateKey,
          ).toString("base64url"),
        });
      if (pauseProof) heldProofs.push(respond);
      else respond();
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
    publicKey,
    socketPath,
    proofRequests() {
      return proofRequests;
    },
    heldProofs() {
      return heldProofs.length;
    },
    holdProof() {
      pauseProof = true;
    },
    releaseProof() {
      pauseProof = false;
      for (const respond of heldProofs.splice(0)) respond();
    },
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

export async function localCall(
  path: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const socket = connect(path);
  const reader = createInterface({ input: socket });
  try {
    return await new Promise((done, reject) => {
      socket.once("error", reject);
      socket.setTimeout(5000, () => reject(new Error("local port timeout")));
      reader.once("line", (line) => {
        const reply = JSON.parse(line) as JSONRecord;
        if (reply.error) reject(new Error(String(reply.error)));
        else done(reply.result);
      });
      socket.write(
        `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
      );
    });
  } finally {
    reader.close();
    socket.destroy();
  }
}

export async function workerFixture(directory: string) {
  // Only a test transport fault: the real target finishes and the real relay
  // authorizes its result, then the caller loses that one response. No executor,
  // registry, SDK or device-port implementation is replaced.
  writeFileSync(
    join(directory, "entry.ts"),
    `
import worker,{DeviceRegistry as Registry,DeviceExecution as Execution} from "../../apps/web/src/worker/device-service.ts";
export class DeviceRegistry extends Registry {
 async fetch(request) {
  if(request.url.endsWith('/sync/endpoints')&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_endpoint_gate'").toArray().length&&(await request.clone().json()).candidates.length) {
   this.ctx.storage.sql.exec("UPDATE test_endpoint_gate SET started=1");
   const deadline=Date.now()+5000;
   while(!this.ctx.storage.sql.exec("SELECT released FROM test_endpoint_gate").toArray()[0].released) {
    if(Date.now()>deadline)throw new Error('test endpoint write gate timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
   }
  }
  const response=await super.fetch(request);
  if(response.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_sync_expiry_gate'").toArray().length) {
   const gate=this.ctx.storage.sql.exec("SELECT * FROM test_sync_expiry_gate").toArray()[0];
   if(request.url.endsWith(gate.route)) {
    this.ctx.storage.sql.exec("UPDATE test_sync_expiry_gate SET seen=seen+1");
    if(gate.seen+1===gate.target) {
     this.ctx.storage.sql.exec("UPDATE test_sync_expiry_gate SET started=1");
     const deadline=Date.now()+5000;
     while(!this.ctx.storage.sql.exec("SELECT released FROM test_sync_expiry_gate").toArray()[0].released) {
      if(Date.now()>deadline)throw new Error('test expiry reply gate timeout');
      await new Promise(resolve=>setTimeout(resolve,10));
     }
    }
   }
  }
  if(request.url.endsWith('/sync/access')&&response.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_sync_reply'").toArray().length) {
   this.ctx.storage.sql.exec("UPDATE test_sync_reply SET started=1");
   const deadline=Date.now()+5000;
   while(!this.ctx.storage.sql.exec("SELECT released FROM test_sync_reply").toArray()[0].released) {
    if(Date.now()>deadline)throw new Error('test sync reply gate timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
   }
  }
  return response;
 }
}
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
      "apps/web/wrangler.devices.jsonc",
      "--outdir",
      join(directory, "worker"),
    ],
    { stdio: "pipe" },
  );
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
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
    unsafeInspectDurableObjects: true,
  });
  try {
    return { mf, origin: (await mf.ready).origin };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
