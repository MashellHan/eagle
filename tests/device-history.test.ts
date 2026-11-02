import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { DeviceHistoryCipher } from "../packages/agent/device-history.ts";
import {
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
});

test("unresolved initial membership cannot mint a history identity proof", async () => {
  await assert.rejects(peer(null, 0), /membership/);
});
