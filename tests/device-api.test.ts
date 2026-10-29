import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

type ApiBody = {
  challengeId: string;
  payload: string;
  sessionToken: string;
  code: string;
  groupId: string | null;
  devices: { deviceId: string; online: boolean | null; policy: unknown }[];
  directory: { devices: { deviceId: string }[] };
};
let mf: Miniflare;
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(resolve(".local/device-api-"));
const base = "https://devices.test/api/devices/v1";
before(async () => {
  writeFileSync(join(root, "index.html"), "devices test");
  execFileSync(
    "node_modules/.bin/wrangler",
    [
      "deploy",
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
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle",
          modules: true,
          scriptPath: join(root, "worker/index.js"),
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
  );
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
