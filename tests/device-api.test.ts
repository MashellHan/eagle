import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import NativeWebSocket from "ws";
import type { OperationRequest } from "../packages/contracts/src/devices.ts";

type ApiBody = {
  challengeId: string;
  payload: string;
  sessionToken: string;
  code: string;
  groupId: string | null;
  revision: number;
  devices: { deviceId: string; online: boolean | null; policy: unknown }[];
  directory: { devices: { deviceId: string }[] };
};
let mf: Miniflare;
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(resolve(".local/device-api-"));
const base = "https://devices.test/api/devices/v1";
before(async () => {
  writeFileSync(join(root, "index.html"), "devices test");
  const entry = join(root, "entry.ts");
  writeFileSync(
    entry,
    `import worker,{DeviceRegistry as Registry,DeviceExecution as Execution,MachineState,MachineDirectory} from "../../apps/web/src/worker/index.ts";
export {MachineState,MachineDirectory};
export class DeviceExecution extends Execution {
 observation(){const observation=super.observation();
  if(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_observation_delay'").toArray().length){this.ctx.storage.sql.exec("UPDATE test_observation_delay SET started=1");return new Promise(resolve=>setTimeout(()=>resolve(observation),500));}
  return observation;
 }
}
export class DeviceRegistry extends Registry {
 async check(token,targetId){const result=await super.check(token,targetId);
  if(result.ok&&targetId&&result.source.deviceId!==targetId&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_revoke_after_check'").toArray().length){
   const row=this.ctx.storage.sql.exec("SELECT deviceId FROM test_revoke_after_check WHERE deviceId=?",result.source.deviceId).toArray()[0];
   if(row)this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("DELETE FROM test_revoke_after_check WHERE deviceId=?",row.deviceId);this.ctx.storage.sql.exec("UPDATE devices SET groupId=NULL,membershipEpoch=membershipEpoch+1,credentialVersion=credentialVersion+1 WHERE deviceId=?",row.deviceId);});
  }
  if(result.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_check_delay'").toArray().length){
   const delayed=this.ctx.storage.sql.exec("SELECT deviceId FROM test_check_delay WHERE deviceId=?",result.source.deviceId).toArray()[0];
   if(delayed){this.ctx.storage.sql.exec("UPDATE test_check_delay SET started=1 WHERE deviceId=?",delayed.deviceId);await new Promise(resolve=>setTimeout(resolve,500));}
  }return result;
 }
}
export default worker;
`,
  );
  execFileSync(
    "node_modules/.bin/wrangler",
    [
      "deploy",
      entry,
      "--dry-run",
      "--config",
      "apps/web/wrangler.jsonc",
      "--outdir",
      join(root, "worker"),
      "--assets",
      root,
    ],
    { stdio: "pipe" },
  );
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle",
          modules: true,
          scriptPath: join(root, "worker/entry.js"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            DEVICE_REGISTRY: { className: "DeviceRegistry", useSQLite: true },
            DEVICE_EXECUTION: { className: "DeviceExecution", useSQLite: true },
            MACHINES: { className: "MachineState", useSQLite: true },
            DIRECTORY: { className: "MachineDirectory", useSQLite: true },
          },
          bindings: { LOCAL_DEV: "false" },
        },
      ],
    }),
    unsafeInspectDurableObjects: true,
  });
  await mf.ready;
});
after(async () => {
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
});
async function call(path: string, token?: string, value?: unknown) {
  const response = await mf.dispatchFetch(`${base}${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as ApiBody,
  };
}
async function identity(name: string) {
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const challenge = await call("/register/challenge", undefined, {
    deviceId,
    publicKey,
    name,
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  const proof = {
    challengeId: challenge.body.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.body.payload),
      keys.privateKey,
    ).toString("base64url"),
  };
  const response = await call("/register/complete", undefined, proof);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return {
    deviceId,
    publicKey,
    token: response.body.sessionToken as string,
    keys,
    proof,
  };
}
async function code(token: string, ttlSeconds = 3600) {
  const response = await call("/pairings", token, { ttlSeconds });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(Buffer.from(response.body.code, "base64url").length, 32);
  return response.body.code as string;
}
async function pair(
  token: string,
  invitation: string,
  requestId = randomUUID(),
) {
  return call("/pairings/redeem", token, { requestId, code: invitation });
}

test("registration proves the key, consumes challenges and rejects identity replacement", async () => {
  const a = await identity("identity");
  assert.equal(
    (await call("/register/complete", undefined, a.proof)).status,
    401,
  );
  const other = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url");
  assert.equal(
    (
      await call("/register/challenge", undefined, {
        deviceId: a.deviceId,
        publicKey: other,
        name: "replacement",
        platform: "darwin",
        arch: "arm64",
      })
    ).status,
    409,
  );
  assert.equal((await call("/directory", "forged")).status, 401);
  assert.equal((await call("/directory", a.token)).body.devices.length, 1);
});

test("four members join in either direction and conflicting groups do not consume invitations", async () => {
  const [a, b, c, d, e, f] = await Promise.all(
    ["a", "b", "c", "d", "e", "f"].map(identity),
  );
  const first = await pair(a.token, await code(c.token));
  assert.equal(first.status, 200);
  assert.equal((await pair(a.token, await code(b.token))).status, 200);
  assert.equal((await pair(d.token, await code(b.token))).status, 200);
  for (const member of [a, b, c, d]) {
    const directory = (await call("/directory", member.token)).body;
    assert.equal(directory.groupId, first.body.groupId);
    assert.deepEqual(
      directory.devices.map((x: { deviceId: string }) => x.deviceId).sort(),
      [a, b, c, d].map((x) => x.deviceId).sort(),
    );
  }
  assert.equal((await pair(e.token, await code(f.token))).status, 200);
  const conflict = await code(e.token);
  assert.equal((await pair(a.token, conflict)).status, 409);
  assert.equal((await pair(f.token, conflict)).status, 200);
});

test("lost pairing response recovers by original request and code without reviving removed membership", async () => {
  const [a, b, c] = await Promise.all(
    ["recover-a", "recover-b", "recover-c"].map(identity),
  );
  const invitation = await code(b.token);
  const requestId = randomUUID();
  const first = await pair(a.token, invitation, requestId);
  assert.equal(first.status, 200);
  assert.equal(
    (await pair(a.token, invitation, requestId)).body.groupId,
    first.body.groupId,
  );
  assert.equal(
    (await pair(a.token, invitation)).body.groupId,
    first.body.groupId,
  );
  assert.equal((await pair(c.token, invitation)).status, 409);
  assert.equal(
    (await pair(a.token, await code(c.token), requestId)).status,
    409,
  );
  assert.equal(
    (await call(`/pairings/results/${requestId}`, a.token)).body.groupId,
    first.body.groupId,
  );
  assert.equal(
    (await call("/members/remove", a.token, { deviceId: b.deviceId })).status,
    200,
  );
  assert.equal((await call("/directory", b.token)).status, 401);
  const restored = await call(`/pairings/results/${requestId}`, a.token);
  assert.equal(restored.body.directory.devices.length, 1);
});

test("revoked invitations, stale issuance epochs and invalid TTL fail closed", async () => {
  const [a, b, c] = await Promise.all(
    ["invite-a", "invite-b", "invite-c"].map(identity),
  );
  const old = await code(a.token);
  assert.equal(
    (await call("/pairings/revoke", a.token, { code: old })).status,
    200,
  );
  assert.equal((await pair(b.token, old)).status, 410);
  const stale = await code(a.token);
  assert.equal((await pair(a.token, await code(c.token))).status, 200);
  assert.equal((await pair(b.token, stale)).status, 410);
  assert.equal(
    (await call("/pairings", a.token, { ttlSeconds: 86401 })).status,
    400,
  );
  const expired = await code(a.token, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await pair(b.token, expired)).status, 410);
});

test("registration challenge binds configured service and directory preserves unknown observations", async () => {
  const a = await identity("bound-service");
  const challenge = await call("/register/challenge", undefined, {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "bound-service",
    platform: "darwin",
    arch: "arm64",
  });
  const lines = challenge.body.payload.split("\n");
  assert.equal(lines.length, 7);
  assert.equal(lines[0], "eagle-device-register-v1");
  assert.equal(lines[1], "https://devices.test");
  assert.equal(lines[2], a.deviceId);
  const directory = await call("/directory", a.token);
  assert.equal(directory.body.devices[0].online, null);
  assert.equal(directory.body.devices[0].policy, null);
});

test("real outbound WebSockets execute bidirectionally with original-ID dedup and live revocation", async () => {
  const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
  const { DeviceRuntime } = await import("../packages/agent/device-runtime.ts");
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([identity("ws-a"), identity("ws-b")]);
  await pair(a.token, await code(b.token));
  const stateA = join(root, "agent-a");
  const stateB = join(root, "agent-b");
  mkdirSync(stateA, { mode: 0o700 });
  mkdirSync(stateB, { mode: 0o700 });
  const deviceA = {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "ws-a",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const deviceB = {
    ...deviceA,
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "ws-b",
  };
  const runtimeA = new DeviceRuntime(deviceA, join(stateA, "journal.sqlite"));
  const runtimeB = new DeviceRuntime(deviceB, join(stateB, "journal.sqlite"));
  const localBase = (await mf.ready).origin;
  const cloudA = new DeviceCloud(
    localBase,
    deviceA,
    runtimeA,
    async (payload) =>
      sign(null, Buffer.from(payload), a.keys.privateKey).toString("base64url"),
  );
  const cloudB = new DeviceCloud(
    localBase,
    deviceB,
    runtimeB,
    async (payload) =>
      sign(null, Buffer.from(payload), b.keys.privateKey).toString("base64url"),
  );
  try {
    await Promise.all([cloudA.start(), cloudB.start()]);
    const directory = await cloudA.directory();
    assert.equal(
      directory.devices.find((d) => d.deviceId === b.deviceId)?.online,
      true,
    );
    assert(
      directory.devices
        .find((d) => d.deviceId === b.deviceId)
        ?.capabilities?.includes("command"),
    );
    const operation = { kind: "command" as const, command: "printf from-b" };
    const input = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
      sourceBotId: "bot-one",
    };
    assert.equal((await cloudA.execute(input)).output, "from-b");
    assert.equal(
      (
        await cloudA.execute({
          ...input,
          requestId: randomUUID(),
          action: "get",
        })
      ).output,
      "from-b",
    );
    const back = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: a.deviceId,
    };
    assert.equal((await cloudB.execute(back)).output, "from-b");
    assert.equal(
      (await cloudA.execute({ ...input, requestId: randomUUID() })).output,
      "from-b",
    );
    const beforePolicy = await cloudA.directory();
    runtimeB.setPolicy("always-ask");
    cloudB.publishPolicy();
    let changed = await cloudA.directory();
    const observationDeadline = Date.now() + 1000;
    while (
      changed.devices.find((d) => d.deviceId === b.deviceId)?.policy
        ?.version !== runtimeB.policy.version &&
      Date.now() < observationDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      changed = await cloudA.directory();
    }
    assert.equal(changed.revision, beforePolicy.revision);
    assert.notEqual(
      changed.observationRevision,
      beforePolicy.observationRevision,
    );
    const asking = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    };
    assert.equal((await cloudA.execute(asking)).status, "denied");
    const { approvalPayload } = await import(
      "../packages/contracts/src/devices.ts"
    );
    const envelope = {
      operationId: asking.operationId,
      sourceDeviceId: a.deviceId,
      targetDeviceId: b.deviceId,
      digest: asking.digest,
      policyVersion: runtimeB.policy.version,
      expiresAt: Date.now() + 60000,
    };
    const approved = {
      ...asking,
      approval: {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          a.keys.privateKey,
        ).toString("base64url"),
      },
    };
    assert.equal((await cloudA.execute(approved)).output, "from-b");
    runtimeB.setPolicy("all-approve");
    cloudB.publishPolicy();
    const registry = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await registry.exec(
      "UPDATE sessions SET expires=0 WHERE deviceId=?",
      b.deviceId,
    );
    await assert.rejects(cloudB.directory());
    await registry.exec(
      `CREATE TRIGGER transient_registration_failure BEFORE INSERT ON challenges WHEN json_extract(NEW.registration,'$.deviceId')='${b.deviceId}' BEGIN SELECT RAISE(ABORT,'transient fixture failure'); END`,
    );
    try {
      cloudB.publishPolicy();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(cloudB.status, "offline");
    } finally {
      await registry.exec("DROP TRIGGER transient_registration_failure");
    }
    const reconnectDeadline = Date.now() + 5000;
    while (String(cloudB.status) !== "online" && Date.now() < reconnectDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      cloudB.status,
      "online",
      "agent must continue retrying after refresh temporarily fails",
    );
    assert.equal(
      (
        await cloudA.execute({
          ...input,
          requestId: randomUUID(),
          action: "get",
        })
      ).output,
      "from-b",
    );
    const removal = await cloudA.manage("/members/remove", {
      deviceId: b.deviceId,
    });
    assert(removal);
    assert.equal(
      (
        await cloudA.execute({
          ...input,
          requestId: randomUUID(),
          action: "get",
        })
      ).status,
      "denied",
    );
  } finally {
    await Promise.all([cloudA.close(), cloudB.close()]);
    await Promise.all([runtimeA.close(), runtimeB.close()]);
  }
});

test("slow management body cannot outlive session revocation or expiry", async () => {
  for (const expire of [false, true]) {
    const [a, b] = await Promise.all([
      identity(`slow-a-${expire}`),
      identity(`slow-b-${expire}`),
    ]);
    await pair(a.token, await code(b.token));
    const storage = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const before = await storage.exec("SELECT count(*) n FROM pairings");
    const response = new Promise<{ status: number; body: string }>(
      (resolveResponse, reject) => {
        const req = httpRequest(
          new URL("/api/devices/v1/pairings", awaitOrigin),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${a.token}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            let body = "";
            res.on("data", (data) => (body += data.toString()));
            res.on("end", () =>
              resolveResponse({ status: res.statusCode ?? 0, body }),
            );
          },
        );
        req.on("error", reject);
        req.write('{"ttlSeconds":');
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 70));
          if (expire)
            await storage.exec(
              "UPDATE sessions SET expires=0 WHERE deviceId=?",
              a.deviceId,
            );
          else
            assert.equal(
              (await call("/members/remove", b.token, { deviceId: a.deviceId }))
                .status,
              200,
            );
          req.end("3600}");
        })().catch(reject);
      },
    );
    const result = await response;
    assert.equal(result.status, 401, result.body);
    const after = await storage.exec("SELECT count(*) n FROM pairings");
    assert.equal(after[0].n, before[0].n);
  }
});
let awaitOrigin: string;
before(async () => {
  awaitOrigin = (await mf.ready).origin;
});

test("registration metadata changes advance grouped and ungrouped directory revision", async () => {
  const [a, b] = await Promise.all([
    identity("metadata-a"),
    identity("metadata-b"),
  ]);
  async function rename(name: string) {
    const challenge = await call("/register/challenge", undefined, {
      deviceId: a.deviceId,
      publicKey: a.publicKey,
      name,
      platform: "darwin",
      arch: "arm64",
    });
    return call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        a.keys.privateKey,
      ).toString("base64url"),
    });
  }
  const ungrouped = (await call("/directory", a.token)).body.revision;
  assert.equal((await rename("renamed-alone")).status, 200);
  assert((await call("/directory", a.token)).body.revision > ungrouped);
  await pair(a.token, await code(b.token));
  const grouped = (await call("/directory", b.token)).body.revision;
  assert.equal((await rename("renamed-grouped")).status, 200);
  assert((await call("/directory", b.token)).body.revision > grouped);
});

test("registration complete rechecks deployment quota after a challenge was issued", async () => {
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const challenge = await call("/register/challenge", undefined, {
    deviceId,
    publicKey,
    name: "quota-new",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(challenge.status, 200);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10000-(SELECT count(*) FROM devices)) INSERT INTO devices(deviceId,publicKey,name,platform,arch) SELECT 'quota-fixture-'||n,'unused','quota-fixture','test','test' FROM seq",
  );
  try {
    const response = await call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(response.status, 429);
    assert.equal(
      (
        await storage.exec(
          "SELECT count(*) n FROM devices WHERE deviceId=?",
          deviceId,
        )
      )[0].n,
      0,
    );
  } finally {
    await storage.exec("DELETE FROM devices WHERE name='quota-fixture'");
  }
});

test("pairing aliases retain original commit deadline and expired unused invitations are swept", async () => {
  const [a, b] = await Promise.all([
    identity("retention-a"),
    identity("retention-b"),
  ]);
  const invitation = await code(b.token);
  const firstId = randomUUID();
  assert.equal((await pair(a.token, invitation, firstId)).status, 200);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const old = Date.now() - 604800001;
  const columns = await storage.exec("PRAGMA table_info(pairings)");
  assert(
    columns.some((column) => column.name === "committed"),
    "consumed invitations need original commit timestamp",
  );
  await storage.exec(
    "UPDATE pairings SET committed=? WHERE redeemer=?",
    old,
    a.deviceId,
  );
  await storage.exec(
    "UPDATE pairing_results SET created=? WHERE deviceId=?",
    old,
    a.deviceId,
  );
  assert.equal((await pair(a.token, invitation)).status, 410);
  assert.equal(
    (await call(`/pairings/results/${firstId}`, a.token)).status,
    404,
  );
  const expired = await code(a.token);
  const { deviceDigest } = await import("../packages/contracts/src/devices.ts");
  const hash = await deviceDigest(expired);
  await storage.exec("UPDATE pairings SET expires=0 WHERE hash=?", hash);
  await code(a.token);
  assert.equal(
    (
      await storage.exec("SELECT count(*) n FROM pairings WHERE hash=?", hash)
    )[0].n,
    0,
  );
});

test("pairing transaction rollback preserves invitation and every membership/result", async () => {
  const [a, b] = await Promise.all([
    identity("rollback-a"),
    identity("rollback-b"),
  ]);
  const invitation = await code(b.token);
  const requestId = randomUUID();
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec(
    `CREATE TRIGGER pairing_commit_failure BEFORE INSERT ON pairing_results WHEN NEW.deviceId='${a.deviceId}' BEGIN SELECT RAISE(ABORT,'transaction fixture failure'); END`,
  );
  try {
    assert.equal((await pair(a.token, invitation, requestId)).status, 500);
    assert.equal((await call("/directory", a.token)).body.groupId, null);
    assert.equal((await call("/directory", b.token)).body.groupId, null);
    assert.equal(
      (await call(`/pairings/results/${requestId}`, a.token)).status,
      404,
    );
  } finally {
    await storage.exec("DROP TRIGGER pairing_commit_failure");
  }
  assert.equal((await pair(a.token, invitation, requestId)).status, 200);
});

test("different invitation groups racing one device commit exactly one membership", async () => {
  const [a, b, c, d, e] = await Promise.all(
    ["race-a", "race-b", "race-c", "race-d", "race-e"].map(identity),
  );
  await pair(b.token, await code(c.token));
  await pair(d.token, await code(e.token));
  const first = await code(b.token);
  const second = await code(d.token);
  const results = await Promise.all([
    pair(a.token, first),
    pair(a.token, second),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  const directory = (await call("/directory", a.token)).body;
  assert.equal(directory.devices.length, 3);
  const lost =
    results[0].status === 409
      ? { token: c.token, code: first }
      : { token: e.token, code: second };
  assert.equal((await pair(lost.token, lost.code)).status, 200);
});

test("a removed original redeemer can recover history after key proof without rejoining", async () => {
  const [a, b] = await Promise.all([
    identity("removed-a"),
    identity("removed-b"),
  ]);
  const invitation = await code(b.token);
  const requestId = randomUUID();
  const original = await pair(a.token, invitation, requestId);
  assert.equal(original.status, 200);
  assert.equal(
    (await call("/members/remove", b.token, { deviceId: a.deviceId })).status,
    200,
  );
  assert.equal(
    (await call(`/pairings/results/${requestId}`, a.token)).status,
    401,
  );
  const challenge = await call("/register/challenge", undefined, {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "removed-a",
    platform: "darwin",
    arch: "arm64",
  });
  const refreshed = await call("/register/complete", undefined, {
    challengeId: challenge.body.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.body.payload),
      a.keys.privateKey,
    ).toString("base64url"),
  });
  assert.equal(refreshed.status, 200);
  const recovered = await pair(
    refreshed.body.sessionToken,
    invitation,
    requestId,
  );
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.groupId, original.body.groupId);
  assert.equal(recovered.body.directory.devices.length, 1);
  assert.equal(
    (await call("/directory", refreshed.body.sessionToken)).body.groupId,
    null,
  );
  assert.equal(
    (await call(`/pairings/results/${requestId}`, b.token)).status,
    404,
  );
});

test("relay rechecks Registry at forwarding after a membership change during authorization", async () => {
  const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
  const { DeviceRuntime } = await import("../packages/agent/device-runtime.ts");
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([
    identity("relay-race-a"),
    identity("relay-race-b"),
  ]);
  await pair(a.token, await code(b.token));
  const state = join(root, "relay-race");
  mkdirSync(state, { mode: 0o700 });
  const da = {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "relay-race-a",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const db = {
    ...da,
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "relay-race-b",
  };
  const ra = new DeviceRuntime(da, join(state, "a.sqlite"));
  const rb = new DeviceRuntime(db, join(state, "b.sqlite"));
  const ca = new DeviceCloud((await mf.ready).origin, da, ra, async (payload) =>
    sign(null, Buffer.from(payload), a.keys.privateKey).toString("base64url"),
  );
  const cb = new DeviceCloud((await mf.ready).origin, db, rb, async (payload) =>
    sign(null, Buffer.from(payload), b.keys.privateKey).toString("base64url"),
  );
  try {
    await Promise.all([ca.start(), cb.start()]);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await storage.exec(
      "CREATE TABLE test_revoke_after_check(deviceId TEXT PRIMARY KEY)",
    );
    await storage.exec(
      "INSERT INTO test_revoke_after_check VALUES(?)",
      a.deviceId,
    );
    const path = join(state, "forbidden.txt");
    const operation = {
      kind: "file.write" as const,
      path,
      content: "unauthorized side effect",
    };
    const input = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    assert.equal((await ca.execute(input)).status, "denied");
    assert.equal(
      existsSync(path),
      false,
      "revocation before forwarding must prevent target side effects",
    );
    await storage.exec("DROP TABLE test_revoke_after_check");
  } finally {
    await Promise.all([ca.close(), cb.close()]);
    await Promise.all([ra.close(), rb.close()]);
  }
});

test("failed redemption attempts persist their rate budget without changing membership or invitations", async () => {
  const a = await identity("failed-redemption-rate");
  const invitation = await code(a.token);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const { deviceDigest } = await import("../packages/contracts/src/devices.ts");
  const hash = await deviceDigest(invitation);
  const before = (
    await storage.exec("SELECT * FROM pairings WHERE hash=?", hash)
  )[0];
  const directory = (await call("/directory", a.token)).body;
  for (let attempt = 0; attempt < 30; attempt++)
    assert.equal((await pair(a.token, "z".repeat(43))).status, 410);
  assert.equal((await pair(a.token, "z".repeat(43))).status, 429);
  assert.deepEqual(
    (await storage.exec("SELECT * FROM pairings WHERE hash=?", hash))[0],
    before,
  );
  assert.deepEqual((await call("/directory", a.token)).body, directory);
  assert.equal(
    (
      await storage.exec(
        "SELECT count(*) n FROM pairing_results WHERE deviceId=?",
        a.deviceId,
      )
    )[0].n,
    0,
  );
});

test("accepted uppercase UUIDs use canonical identity and the execution route", async () => {
  const { DeviceId } = await import("../packages/contracts/src/devices.ts");
  const a = await identity("case-device");
  assert.equal(DeviceId.parse(a.deviceId.toUpperCase()), a.deviceId);
  const response = await mf.dispatchFetch(
    `${base}/execution/${a.deviceId.toUpperCase()}/agent`,
  );
  assert.equal(response.status, 426);
});

async function rawSocket(
  deviceId: string,
  role: "agent" | "request",
): Promise<NativeWebSocket> {
  const url = new URL(
    `${DEVICE_PREFIX}/execution/${deviceId}/${role}`,
    (await mf.ready).origin,
  );
  url.protocol = "ws:";
  const socket = new NativeWebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", reject);
  });
  return socket;
}
const DEVICE_PREFIX = "/api/devices/v1";
function frame<T>(socket: NativeWebSocket): Promise<T> {
  return new Promise((resolveFrame, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", received);
      reject(new Error("test frame timeout"));
    }, 2000);
    const received = (data: NativeWebSocket.RawData) => {
      clearTimeout(timeout);
      resolveFrame(JSON.parse(data.toString()) as T);
    };
    socket.once("message", received);
  });
}
const authentication = (token: string) => ({
  type: "authenticate",
  sessionToken: token,
  capabilities: ["command"],
  policy: { mode: "all-approve", version: 1 },
});

test("relay correlation is generated per forwarding and cannot leak an old result to reused caller IDs", async () => {
  const [a, b, c] = await Promise.all(
    ["correlation-a", "correlation-b", "correlation-c"].map(identity),
  );
  await pair(a.token, await code(b.token));
  await pair(c.token, await code(b.token));
  const agent = await rawSocket(b.deviceId, "agent");
  const ready = frame<{ type: string }>(agent);
  agent.send(JSON.stringify(authentication(b.token)));
  assert.equal((await ready).type, "ready");
  let callerA: NativeWebSocket | undefined;
  let callerC: NativeWebSocket | undefined;
  try {
    const requestId = randomUUID();
    const operationId = randomUUID();
    const { deviceDigest, canonicalDeviceJSON } = await import(
      "../packages/contracts/src/devices.ts"
    );
    const operation = {
      kind: "command" as const,
      command: "printf source-a-private-result",
    };
    const request = {
      requestId,
      operationId,
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    callerA = await rawSocket(b.deviceId, "request");
    const firstFrame = frame<{ request: OperationRequest }>(agent);
    callerA.send(
      JSON.stringify({ type: "request", sessionToken: a.token, request }),
    );
    const first = await firstFrame;
    const closed = new Promise<void>((resolveClosed) =>
      callerA?.once("close", () => resolveClosed()),
    );
    callerA.close();
    await closed;
    callerC = await rawSocket(b.deviceId, "request");
    const response = frame<{
      requestId: string;
      result: { status: string; output?: string };
    }>(callerC);
    const secondFrame = frame<{ request: OperationRequest }>(agent);
    callerC.send(
      JSON.stringify({
        type: "request",
        sessionToken: c.token,
        request: { ...request, action: "get" },
      }),
    );
    const second = await secondFrame;
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: first.request.requestId,
        operationId,
        targetDeviceId: b.deviceId,
        result: { status: "completed", output: "source-a-private-result" },
      }),
    );
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: second.request.requestId,
        operationId,
        targetDeviceId: b.deviceId,
        result: { status: "denied", error: "operation_source_mismatch" },
      }),
    );
    const answer = await response;
    assert.equal(answer.result.status, "denied");
    assert.equal(answer.requestId, requestId);
    assert.notEqual(first.request.requestId, second.request.requestId);
    assert.notEqual(first.request.requestId, requestId);
  } finally {
    callerA?.terminate();
    callerC?.terminate();
    agent.terminate();
  }
});

test("closed sockets cannot revive after Registry RPC and Agent queue admission is bounded", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec(
    "CREATE TABLE test_check_delay(deviceId TEXT PRIMARY KEY,started INTEGER NOT NULL DEFAULT 0)",
  );
  try {
    for (const flood of ["none", "frames", "bytes"]) {
      const a = await identity(`closed-auth-${flood}`);
      await storage.exec(
        "INSERT INTO test_check_delay(deviceId) VALUES(?)",
        a.deviceId,
      );
      const socket = await rawSocket(a.deviceId, "agent");
      let remoteClosed = false;
      socket.once("close", () => {
        remoteClosed = true;
      });
      socket.send(JSON.stringify(authentication(a.token)));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const started = await storage.exec(
          "SELECT started FROM test_check_delay WHERE deviceId=?",
          a.deviceId,
        );
        if (started[0].started === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (flood !== "none") {
        for (let i = 0; i < (flood === "frames" ? 32 : 3); i++)
          socket.send(
            JSON.stringify({
              type: "heartbeat",
              ...(flood === "bytes" ? { padding: "x".repeat(500000) } : {}),
              capabilities: ["command"],
              policy: { mode: "all-approve", version: 1 },
            }),
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          remoteClosed,
          true,
          "queued frame count must be bounded before Registry RPC resolves",
        );
      } else {
        socket.close();
        await new Promise<void>((resolveClosed) =>
          socket.once("close", () => resolveClosed()),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.notEqual(
        (await call("/directory", a.token)).body.devices[0].online,
        true,
        "closed authentication must never create a live agent",
      );
      socket.terminate();
      await storage.exec(
        "DELETE FROM test_check_delay WHERE deviceId=?",
        a.deviceId,
      );
    }
  } finally {
    await storage.exec("DROP TABLE test_check_delay");
  }
});

test("directory revalidates the original session after awaited device observations", async () => {
  const [a, b] = await Promise.all([
    identity("directory-race-a"),
    identity("directory-race-b"),
  ]);
  await pair(a.token, await code(b.token));
  const execution = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceExecution",
    { name: a.deviceId },
  );
  await execution.exec("CREATE TABLE test_observation_delay(started INTEGER)");
  await execution.exec("INSERT INTO test_observation_delay VALUES(0)");
  try {
    const reading = call("/directory", a.token);
    const deadline = Date.now() + 1000;
    let started = false;
    while (Date.now() < deadline) {
      if (
        (await execution.exec("SELECT started FROM test_observation_delay"))[0]
          .started === 1
      ) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true);
    assert.equal(
      (await call("/members/remove", b.token, { deviceId: a.deviceId })).status,
      200,
    );
    assert.equal(
      (await reading).status,
      401,
      "a revoked caller must not receive the old group after observation awaits",
    );
  } finally {
    await execution.exec("DROP TABLE test_observation_delay");
  }
});
