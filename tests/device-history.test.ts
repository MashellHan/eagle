import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type ListenOptions, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DeviceHistoryCipher } from "../packages/agent/device-history.ts";
import { DeviceHistoryTransport } from "../packages/agent/device-history-transport.ts";
import { readTailscaleAddress } from "../packages/agent/device-tailscale.ts";
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
  await assert.rejects(b.cipher.open(a, { ...packet, purpose: "endpoint" }));
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

test("installed Tailscale uses the macOS App CLI when PATH is absent and accepts only Running numeric tailnet addresses", async () => {
  const calls: string[] = [];
  const address = await readTailscaleAddress(async (file, args) => {
    calls.push(file);
    assert.deepEqual(args, ["status", "--json"]);
    if (file === "tailscale")
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return JSON.stringify({
      BackendState: "Running",
      Self: { TailscaleIPs: ["100.66.87.127"] },
    });
  });
  assert.equal(address, "100.66.87.127");
  assert.deepEqual(calls, [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ]);
  for (const [BackendState, ip] of [
    ["NeedsLogin", "100.66.87.127"],
    ["Running", "127.0.0.1"],
    ["Running", "paired-host.example"],
  ]) {
    assert.equal(
      await readTailscaleAddress(async () =>
        JSON.stringify({ BackendState, Self: { TailscaleIPs: [ip] } }),
      ),
      undefined,
    );
  }
});

test("Tailscale history uses real encrypted listeners, retains packet identity on fallback and refuses stale authorization", async (t) => {
  const a = await peer();
  const b = await peer();
  const roots = [
    mkdtempSync(join(tmpdir(), "history-direct-a-")),
    mkdtempSync(join(tmpdir(), "history-direct-b-")),
  ] as const;
  const servers: Server[] = [];
  const listen = Server.prototype.listen;
  // Only test routing maps advertised tailnet IPs to isolated real loopback listeners.
  t.mock.method(
    Server.prototype,
    "listen",
    function (this: Server, ...args: unknown[]) {
      const options = args[0] as ListenOptions;
      if (typeof options === "object" && options.host?.startsWith("100.64.")) {
        args[0] = { ...options, host: "127.0.0.1" };
        servers.push(this);
      }
      return Reflect.apply(listen, this, args);
    },
  );
  const request = globalThis.fetch;
  let mode = "normal";
  let attempts = 0;
  let directId: string | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.hostname.startsWith("100.64.")) return request(input, init);
      attempts++;
      directId = (
        JSON.parse(String(init?.body)) as { packet: { requestId: string } }
      ).packet.requestId;
      if (mode === "unreachable") throw new TypeError("connection refused");
      url.hostname = "127.0.0.1";
      const response = await request(url, init);
      if (mode === "bad_ack") {
        const ack = (await response.json()) as { packet: { body: string } };
        ack.packet.body = `${ack.packet.body[0] === "A" ? "B" : "A"}${ack.packet.body.slice(1)}`;
        return new Response(JSON.stringify(ack));
      }
      if (mode === "lost_ack")
        throw new TypeError("connection lost after receiver accepted");
      return response;
    },
  );
  let current = true;
  let denyAtA = false;
  let controls = 0;
  let busyEndpoint = true;
  const relays: string[] = [];
  const proofs = new Map<
    string,
    { device: typeof a.device; proof: typeof a.proof }
  >();
  const listeners = new Map<string, (event: unknown) => void>();
  const cloudFor = (self: typeof a) => ({
    status: "online",
    origin,
    device: self.device,
    observeHistory(listener: (event: unknown) => void) {
      listeners.set(self.device.deviceId, listener);
      return () => listeners.delete(self.device.deviceId);
    },
    async directory() {
      return { devices: [a.device, b.device] };
    },
    async historyRequest(frame: {
      type: string;
      proof?: typeof a.proof;
      targetDeviceId?: string;
      packet?: { purpose?: string; requestId: string };
    }) {
      if (frame.type === "history.configure" && frame.proof)
        proofs.set(self.device.deviceId, {
          device: self.device,
          proof: frame.proof,
        });
      if (frame.type === "history.peers")
        return {
          type: "history.peers",
          peers: [...proofs.values()].filter(
            (p) =>
              p.device.deviceId !== self.device.deviceId &&
              (self !== b || current) &&
              (self !== a || !denyAtA),
          ),
        };
      if (frame.type === "history.send") {
        if (frame.packet?.purpose === "endpoint") {
          if (busyEndpoint) {
            busyEndpoint = false;
            throw new Error("history_busy");
          }
          controls++;
        } else relays.push(frame.packet?.requestId ?? "");
        listeners.get(frame.targetDeviceId ?? "")?.({
          type: "history.packet",
          source: proofs.get(self.device.deviceId),
          packet: frame.packet,
        });
      }
      return { type: "history.sent" };
    },
  });
  const left = new DeviceHistoryTransport(
    cloudFor(
      a,
    ) as unknown as import("../packages/agent/device-cloud.ts").DeviceCloud,
    roots[0],
    a.signer,
    async () => "100.64.0.1",
  );
  const right = new DeviceHistoryTransport(
    cloudFor(
      b,
    ) as unknown as import("../packages/agent/device-cloud.ts").DeviceCloud,
    roots[1],
    b.signer,
    async () => "100.64.0.2",
  );
  const received: unknown[] = [];
  right.observe((event) => {
    if (event.type === "history.packet") received.push(event.payload);
  });
  try {
    await left.setEnabled(true);
    await untilHistory(
      () => servers.length === 1 && servers[0]?.listening === true,
    );
    await right.setEnabled(true);
    await untilHistory(() => controls >= 3 && servers.length === 2);
    assert.deepEqual(
      await left.send(b.device.deviceId, {
        address: "100.64.0.99",
        port: 1,
        text: "x".repeat(80 * 1024),
      }),
      { sent: true, route: "tailscale" },
    );
    assert.equal(
      received.length,
      1,
      "ordinary Bots data cannot become endpoint control",
    );
    assert.deepEqual(
      await right.send(a.device.deviceId, { marker: "unchanged endpoint" }),
      { sent: true, route: "tailscale" },
    );
    assert.equal(relays.length, 0);
    mode = "bad_ack";
    await assert.rejects(
      right.send(a.device.deviceId, { marker: "tampered ack" }),
    );
    assert.equal(
      relays.length,
      0,
      "ciphertext authentication failure never falls back",
    );
    mode = "normal";
    denyAtA = true;
    await assert.rejects(
      right.send(a.device.deviceId, {
        marker: "receiver rechecks current peers",
      }),
      /history_direct_unauthorized/,
    );
    assert.equal(
      relays.length,
      0,
      "receiver authorization failure never falls back",
    );
    denyAtA = false;
    mode = "unreachable";
    assert.deepEqual(
      await right.send(a.device.deviceId, { marker: "unreachable route" }),
      { sent: true, route: "do" },
    );
    assert.equal(
      relays.length,
      1,
      "unreachable direct route quickly uses authorized DO",
    );
    mode = "lost_ack";
    assert.deepEqual(
      await left.send(b.device.deviceId, {
        marker: "idempotent passive packet",
      }),
      { sent: true, route: "do" },
    );
    await untilHistory(() => received.length >= 2);
    assert.equal(
      relays.at(-1),
      directId,
      "uncertain direct delivery falls back with the original packet ID",
    );
    assert.equal(
      received.length,
      2,
      "fallback cannot publish the already accepted packet twice",
    );
    const before = attempts;
    await left.send(b.device.deviceId, { marker: "next page during cooldown" });
    assert.equal(
      attempts,
      before,
      "backfill pages do not repeat the same failed direct probe",
    );
    mode = "normal";
    current = false;
    const relayed = relays.length;
    await assert.rejects(
      right.send(a.device.deviceId, { marker: "revoked" }),
      /history_peer_unavailable/,
    );
    assert.equal(
      relays.length,
      relayed,
      "current peer rejection must never fall back",
    );
    await right.setEnabled(false);
    assert.equal(servers[1]?.listening, false);
    current = true;
    const announced = controls;
    await right.setEnabled(true);
    await untilHistory(() => servers.length === 3 && controls >= announced + 3);
    assert.deepEqual(
      await right.send(a.device.deviceId, { marker: "enabled again" }),
      { sent: true, route: "tailscale" },
    );
  } finally {
    left.close();
    right.close();
    assert.equal(
      servers.every((server) => !server.listening),
      true,
    );
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

async function untilHistory(ready: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "history route progress");
    await new Promise<void>((done) => setImmediate(done));
  }
}

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
    async () => undefined,
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await transport.setEnabled(true);
    assert.equal(transport.status().ready, true);
    const failed = nextReady(transport, false);
    t.mock.timers.tick(60_000);
    await failed;
    assert.equal(configurations, 2);
    assert.equal(transport.status().ready, false);
    const recovered = nextReady(transport, true);
    t.mock.timers.tick(2000);
    await recovered;
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

const nextReady = (transport: DeviceHistoryTransport, ready: boolean) =>
  new Promise<void>((resolve) => {
    const detach = transport.observe((event) => {
      if (event.type !== "history.ready" || event.ready !== ready) return;
      detach();
      resolve();
    });
  });

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
    async () => undefined,
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
      const failed = nextReady(f.transport, false);
      t.mock.timers.tick(60_000);
      await failed;
      assert.equal(f.transport.status().ready, false);
      const failedAt = f.directories;
      const recovered =
        error.message === "revoked_session"
          ? undefined
          : nextReady(f.transport, true);
      t.mock.timers.tick(1000);
      if (recovered) await recovered;
      else await flush();
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
    let enter = () => {};
    let resume = () => {};
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const held = new Promise<void>((done) => {
      resume = done;
    });
    const create = DeviceHistoryCipher.create;
    let holdCrypto = false;
    t.mock.method(
      DeviceHistoryCipher,
      "create",
      async (...args: Parameters<typeof create>) => {
        if (holdCrypto) {
          holdCrypto = false;
          enter();
          await held;
        }
        return create(...args);
      },
    );
    try {
      await f.transport.setEnabled(true);
      f.errors.configure.push(new Error("history_busy"));
      const failed = nextReady(f.transport, false);
      t.mock.timers.tick(60_000);
      await failed;
      if (boundary === "disable") await f.transport.setEnabled(false);
      else f.event(false);
      t.mock.timers.tick(2000);
      await flush();
      f.errors.configure.push(new Error("history_busy"));
      if (boundary === "disable")
        await assert.rejects(f.transport.setEnabled(true), /history_busy/);
      else {
        const failedOnline = nextReady(f.transport, false);
        holdCrypto = true;
        f.event(true);
        await entered;
        // Even many event-loop turns do not complete a held real WebCrypto operation.
        await flush();
        assert.equal(f.transport.status().ready, false);
        resume();
        await failedOnline;
      }
      assert.equal(f.transport.status().ready, false);
      const recovered = nextReady(f.transport, true);
      t.mock.timers.tick(1000);
      await recovered;
      assert.equal(
        f.transport.status().ready,
        true,
        "new online recovery must replace the canceled timer",
      );
    } finally {
      resume();
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
