import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { DeviceHistoryCipher } from "../packages/agent/device-history.ts";
import {
  HISTORY_FRAME_BYTES,
  HISTORY_PLAINTEXT_BYTES,
  historyKeyPayload,
} from "../packages/contracts/src/device-history.ts";
import type { Device } from "../packages/contracts/src/devices.ts";

const origin = "https://devices.test";
const groupId = randomUUID();
const peer = async (group: string | null = groupId, epoch = 1) => {
  const keys = generateKeyPairSync("ed25519");
  const device: Device = {
    deviceId: randomUUID(),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    groupId: group,
    membershipEpoch: epoch,
    credentialVersion: 1,
    name: "history-test",
    platform: "darwin",
    arch: "arm64",
  };
  const cipher = await DeviceHistoryCipher.create(
    origin,
    device,
    async (proof) =>
      sign(
        null,
        Buffer.from(historyKeyPayload(proof)),
        keys.privateKey,
      ).toString("base64url"),
  );
  return { device: cipher.device, proof: cipher.proof, cipher };
};

test("history ciphertext binds authenticated devices, group, membership, key and correlation without plaintext", async () => {
  const a = await peer();
  const b = await peer();
  const id = randomUUID();
  const input = {
    method: "catalog.export",
    payload: { title: "private empty bot" },
  };
  const packet = await a.cipher.seal(b, id, input);
  assert.doesNotMatch(
    JSON.stringify(packet),
    /private empty bot|catalog.export/,
  );
  assert.deepEqual(await b.cipher.open(a, packet), input);
  const damaged = structuredClone(packet);
  damaged.body = `${damaged.body[0] === "A" ? "B" : "A"}${damaged.body.slice(1)}`;
  await assert.rejects(b.cipher.open(a, damaged));
  await assert.rejects(
    b.cipher.open(a, { ...packet, requestId: randomUUID() }),
  );
  await assert.rejects(
    b.cipher.open(
      { ...a, device: { ...a.device, membershipEpoch: 2 } },
      packet,
    ),
  );
  await assert.rejects(
    b.cipher.open(
      { ...a, device: { ...a.device, groupId: randomUUID() } },
      packet,
    ),
  );
  await assert.rejects(
    b.cipher.open(
      { ...a, proof: { ...a.proof, expiresAt: Date.now() - 1 } },
      packet,
    ),
  );
  const stranger = await peer(randomUUID());
  await assert.rejects(a.cipher.seal(stranger, id, input));
  const old = await peer();
  await assert.rejects(old.cipher.open(a, packet));
  await assert.rejects(
    a.cipher.seal(b, id, { text: "x".repeat(HISTORY_PLAINTEXT_BYTES) }),
  );
  const reply = { type: "reply", id, failed: false, result: "" };
  reply.result = "x".repeat(
    HISTORY_PLAINTEXT_BYTES - Buffer.byteLength(JSON.stringify(reply)),
  );
  const full = await a.cipher.seal(b, id, reply);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ type: "history.packet", packet: full }),
    ) < HISTORY_FRAME_BYTES,
  );
  assert.deepEqual(await b.cipher.open(a, full), reply);
});

test("unresolved initial membership cannot mint a history identity proof", async () => {
  await assert.rejects(peer(null, 0), /membership/);
});

test("online history retries a transient renewal without waiting for another cloud event", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DeviceHistoryTransport } = await import(
    "../packages/agent/device-history-transport.ts"
  );
  const keys = generateKeyPairSync("ed25519");
  const self = await peer();
  self.device.publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const directory = mkdtempSync(join(tmpdir(), "history-renewal-"));
  let configurations = 0;
  let notices = 0;
  let failNotice = false;
  const cloud = {
    status: "online",
    origin,
    device: self.device,
    observeHistory: () => () => {},
    directory: async () => ({ devices: [self.device] }),
    historyRequest: async (frame: { type: string }) => {
      if (frame.type === "history.changed") {
        notices++;
        if (failNotice) {
          failNotice = false;
          throw new Error("history_busy");
        }
      }
      if (frame.type === "history.configure" && ++configurations === 2)
        throw new Error("history_busy");
      return frame.type === "history.peers"
        ? { type: "history.peers", peers: [] }
        : { type: "history.sent" };
    },
  };
  const transport = new DeviceHistoryTransport(
    cloud as unknown as import("../packages/agent/device-cloud.ts").DeviceCloud,
    directory,
    async (proof) =>
      sign(
        null,
        Buffer.from(historyKeyPayload(proof)),
        keys.privateKey,
      ).toString("base64url"),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await transport.setEnabled(true);
    assert.equal(transport.status().ready, true);
    t.mock.timers.tick(60_000);
    for (let turn = 0; turn < 30; turn++)
      await new Promise<void>((done) => setImmediate(done));
    assert.equal(configurations, 2);
    assert.equal(transport.status().ready, false);
    t.mock.timers.tick(2000);
    for (let turn = 0; turn < 30; turn++)
      await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      configurations,
      3,
      "transient renewal must schedule its own bounded retry",
    );
    assert.equal(transport.status().ready, true);
    const before = notices;
    failNotice = true;
    await assert.rejects(transport.notify(), /history_busy/);
    t.mock.timers.tick(1000);
    for (let turn = 0; turn < 30; turn++)
      await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      notices,
      before + 2,
      "the last dropped notice retries without another durable commit",
    );
  } finally {
    transport.close();
    t.mock.timers.reset();
    rmSync(directory, { recursive: true, force: true });
  }
});
