import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DeviceHistoryCipher } from "../packages/agent/device-history.ts";
import { DeviceHistoryTransport } from "../packages/agent/device-history-transport.ts";
import {
  HISTORY_FRAME_BYTES,
  HISTORY_PLAINTEXT_BYTES,
  type HistoryKeyIdentity,
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
  const signer = async (proof: HistoryKeyIdentity) =>
    sign(null, Buffer.from(historyKeyPayload(proof)), keys.privateKey).toString(
      "base64url",
    );
  const cipher = await DeviceHistoryCipher.create(origin, device, signer);
  return { device: cipher.device, proof: cipher.proof, cipher, signer };
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

const flush = async () => {
  for (let turn = 0; turn < 30; turn++)
    await new Promise<void>((done) => setImmediate(done));
};

async function recoveryFixture(t: TestContext) {
  const self = await peer();
  const directory = mkdtempSync(join(tmpdir(), "history-recovery-"));
  const errors = { directory: [] as Error[], configure: [] as Error[] };
  const hooks = { changed: async () => ({ type: "history.sent" }) };
  let observed = (_event: { type: "history.online" | "history.offline" }) => {};
  let directories = 0;
  let notices = 0;
  const cloud = {
    status: "online" as "online" | "offline",
    origin,
    device: self.device,
    observeHistory(listener: typeof observed) {
      observed = listener;
      return () => {};
    },
    async directory() {
      directories++;
      const error = errors.directory.shift();
      if (error) throw error;
      return { devices: [self.device] };
    },
    async historyRequest(frame: { type: string; proof?: unknown }) {
      if (frame.type === "history.configure" && frame.proof !== null) {
        const error = errors.configure.shift();
        if (error) throw error;
      }
      if (frame.type === "history.changed") {
        notices++;
        return hooks.changed();
      }
      return frame.type === "history.peers"
        ? { type: "history.peers", peers: [] }
        : { type: "history.sent" };
    },
  };
  const transport = new DeviceHistoryTransport(
    cloud as unknown as import("../packages/agent/device-cloud.ts").DeviceCloud,
    directory,
    self.signer,
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return {
    transport,
    cloud,
    hooks,
    errors,
    get directories() {
      return directories;
    },
    get notices() {
      return notices;
    },
    event(online: boolean) {
      cloud.status = online ? "online" : "offline";
      observed({ type: online ? "history.online" : "history.offline" });
    },
    close() {
      transport.close();
      t.mock.timers.reset();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const error of [
  new DOMException("directory timed out", "TimeoutError"),
  new Error("internal_error"),
  new Error("revoked_session"),
]) {
  test(`online directory renewal handles ${error.name}/${error.message} without another WSS event`, async (t) => {
    const f = await recoveryFixture(t);
    try {
      await f.transport.setEnabled(true);
      f.errors.directory.push(error);
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(f.transport.status().ready, false);
      const failedAt = f.directories;
      t.mock.timers.tick(1000);
      await flush();
      assert.equal(
        f.directories,
        failedAt + (error.message === "revoked_session" ? 0 : 1),
      );
      assert.equal(
        f.transport.status().ready,
        error.message !== "revoked_session",
      );
    } finally {
      f.close();
    }
  });
}

for (const boundary of ["disable", "offline"]) {
  test(`a canceled recovery handle cannot prevent retry after ${boundary}`, async (t) => {
    const f = await recoveryFixture(t);
    try {
      await f.transport.setEnabled(true);
      f.errors.configure.push(new Error("history_busy"));
      t.mock.timers.tick(60_000);
      await flush();
      if (boundary === "disable") await f.transport.setEnabled(false);
      else f.event(false);
      t.mock.timers.tick(2000);
      await flush();
      f.errors.configure.push(new Error("history_busy"));
      if (boundary === "disable")
        await assert.rejects(f.transport.setEnabled(true), /history_busy/);
      else {
        f.event(true);
        await flush();
      }
      assert.equal(f.transport.status().ready, false);
      t.mock.timers.tick(1000);
      await flush();
      assert.equal(
        f.transport.status().ready,
        true,
        "new online recovery must replace the canceled timer",
      );
    } finally {
      f.close();
    }
  });
}

test("an older delayed notice success cannot cancel the latest busy retry", async (t) => {
  const f = await recoveryFixture(t);
  try {
    await f.transport.setEnabled(true);
    let release = () => {};
    f.hooks.changed = () =>
      new Promise((done) => {
        release = () => done({ type: "history.sent" });
      });
    const older = f.transport.notify();
    await flush();
    f.hooks.changed = async () => {
      throw new Error("history_busy");
    };
    await assert.rejects(f.transport.notify(), /history_busy/);
    release();
    await older;
    const before = f.notices;
    f.hooks.changed = async () => ({ type: "history.sent" });
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(
      f.notices,
      before + 1,
      "the latest failed change still needs delivery",
    );
  } finally {
    f.close();
  }
});
