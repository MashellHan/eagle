import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acceptedPin,
  bytesDigest,
  decodePage,
  metadataDigest,
  objectCanonical,
  preparePage,
  type StoredObject,
  SyncObjectStorageError,
  SyncObjectStore,
  verifyCarrier,
  verifyEnvelope,
} from "../src/sync-objects.ts";

function fixture() {
  const signing = generateKeyPairSync("ed25519");
  const publicKey = signing.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const publisher = {
    deviceId: randomUUID(),
    publicKey,
    groupId: randomUUID(),
    membershipEpoch: 1,
    credentialVersion: 1,
  };
  const origin = "http://127.0.0.1:17053";
  const signed = <T>(domain: string, value: T) => ({
    ...value,
    signature: sign(
      null,
      Buffer.from(domain + "\n" + objectCanonical(value)),
      signing.privateKey,
    ).toString("base64url"),
  });
  const wrappingPublicKey = randomBytes(32).toString("base64url");
  const descriptor = signed("eagle-bots-wrap-descriptor-v1", {
    version: 1 as const,
    purpose: "replica.wrap" as const,
    registryOrigin: origin,
    deviceId: publisher.deviceId,
    publicKey,
    credentialVersion: 1,
    keyId: bytesDigest(Buffer.from(wrappingPublicKey, "base64url")),
    wrappingPublicKey,
  });
  const page = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/bots-sync/resource-page.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const prepared = preparePage(page, publisher, origin).encrypt();
  const manifest = signed("eagle-bots-page-manifest-v1", prepared.manifest);
  const envelope = signed("eagle-bots-key-envelope-signature-v1", {
    version: 1 as const,
    purpose: "replica.key" as const,
    registryOrigin: origin,
    publisher,
    issuer: publisher,
    recipient: publisher,
    issuerDescriptor: descriptor,
    recipientDescriptor: descriptor,
    sharedBotId: manifest.sharedBotId,
    keyEpoch: 1 as const,
    keyId: manifest.keyId,
    objectId: manifest.objectId,
    manifestDigest: metadataDigest(manifest),
    ephemeral: randomBytes(32).toString("base64url"),
    nonce: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(32).toString("base64url"),
    tag: randomBytes(16).toString("base64url"),
  });
  const carrier = verifyCarrier({
    version: 1,
    manifest,
    descriptor,
    envelope,
    ciphertext: prepared.ciphertext,
  });
  const botId = "b_" + randomUUID();
  const record: StoredObject = {
    version: 1,
    kind: "publisher",
    botId,
    binding: {
      localBotId: botId,
      sharedBotId: manifest.sharedBotId,
      replicaId: randomUUID(),
      epoch: randomUUID(),
    },
    carrier,
    pin: acceptedPin(carrier),
  };
  return { page, prepared, record, publisher, descriptor, manifest, envelope };
}

test("immutable object storage selects a verified first winner and stable recipient slot", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bots-object-store-")));
  try {
    const { record, publisher, descriptor, manifest, envelope } = fixture();
    const store = new SyncObjectStore(root),
      objectId = manifest.objectId;
    assert.equal(store.read(objectId), undefined);
    const staged = await store.stage(record);
    assert.equal(staged.publish(), undefined);
    assert.equal(staged.published, true);
    assert.deepEqual(staged.complete(), record);
    const existing = await store.stage(record);
    existing.publish();
    assert.equal(existing.published, false);
    assert.deepEqual(existing.complete(), record);
    const slot = store.recipient(record, publisher, publisher, descriptor, descriptor);
    assert.equal(slot.read(), undefined);
    const issued = await slot.stage(envelope);
    issued.publish();
    assert.deepEqual(issued.complete(), envelope);
    assert.deepEqual(slot.read(), envelope);
    const repeated = await slot.stage(envelope);
    repeated.publish();
    assert.deepEqual(repeated.complete(), envelope);
    assert.deepEqual(new SyncObjectStore(root).read(objectId), record);
    const abandoned = await store.stage(record);
    abandoned.discard();
    assert.deepEqual(store.read(objectId), record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned crash-stage hardlink is recoverable while unknown links and corruption fail closed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bots-object-crash-")));
  try {
    const { record } = fixture(),
      store = new SyncObjectStore(root),
      id = record.carrier.manifest.objectId;
    const first = await store.stage(record);
    first.publish();
    first.complete();
    const file = join(root, "sync-objects/v1", id + ".json");
    const stage = join(root, "sync-objects/v1/.stage-" + randomUUID());
    linkSync(file, stage);
    assert.deepEqual(store.read(id), record);
    const unknown = join(root, "unrecognized-link");
    linkSync(file, unknown);
    assert.throws(() => store.read(id), SyncObjectStorageError);
    rmSync(unknown);
    chmodSync(file, 0o000);
    assert.throws(
      () => store.read(id),
      (error: unknown) =>
        error instanceof SyncObjectStorageError &&
        (error.cause as NodeJS.ErrnoException).code === "EACCES",
    );
    chmodSync(file, 0o600);
    writeFileSync(file, "{corrupt");
    assert.throws(() => store.read(id));
    const retry = await store.stage(record);
    retry.publish();
    assert.throws(() => retry.complete());
    assert.equal(readFileSync(file, "utf8"), "{corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("original Page JSON bytes survive AEAD and every object binding is authenticated", () => {
  const { record, prepared, page, envelope, manifest } = fixture();
  assert.deepEqual(
    decodePage(record.carrier, prepared.key).bytes,
    Buffer.from(JSON.stringify(page)),
  );
  assert.equal(
    preparePage(page, record.pin.publisher, manifest.registryOrigin).objectId,
    manifest.objectId,
  );
  assert.throws(() => decodePage(record.carrier, randomBytes(32)));
  assert.throws(() =>
    verifyCarrier({ ...record.carrier, ciphertext: "A" + record.carrier.ciphertext.slice(1) }),
  );
  assert.throws(() =>
    verifyCarrier({
      ...record.carrier,
      descriptor: { ...record.carrier.descriptor, signature: "A".repeat(86) },
    }),
  );
  for (const change of [
    { objectId: "0".repeat(64) },
    { sharedBotId: randomUUID() },
    { recipient: { ...envelope.recipient, credentialVersion: 2 } },
  ])
    assert.throws(() => verifyEnvelope({ ...envelope, ...change }, manifest));
  prepared.key.fill(0);
});
