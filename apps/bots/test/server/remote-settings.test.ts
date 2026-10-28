import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { RemoteSettingsError, RemoteSettingsStore } from "../../src/server/remote-settings.ts";

test("remote grants are per Bot, revision checked, private and atomic across reopen and rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-grants-"));
  const namespace = createHash("sha256").update(root).digest("hex");
  const store = new RemoteSettingsStore(root, namespace);
  const target = {
    alias: "build-mac",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read", "herdr.setup"],
  };
  try {
    const initial = store.read("bot-a");
    const first = await store.save(
      "bot-a",
      { revision: initial.revision, targets: [target] },
      async () => true,
    );
    assert.notEqual(first.revision, initial.revision);
    assert.deepEqual(first.targets, [target]);
    assert.deepEqual(store.read("bot-b").targets, []);
    assert.deepEqual(new RemoteSettingsStore(root, namespace).read("bot-a"), first);
    const file = join(root, "remote-tools", "bot-a.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const before = readFileSync(file);
    await assert.rejects(
      store.save("bot-a", { revision: initial.revision, targets: [] }, async () => true),
      (error: unknown) => error instanceof RemoteSettingsError && error.code === "conflict",
    );
    for (const changes of [
      { origin: "http://remote.invalid" },
      { ownerToken: "not-accepted" },
      { alias: "../wrong" },
      { operations: ["arbitrary.shell"] },
      { machineId: "../b" },
    ]) {
      await assert.rejects(
        store.save(
          "bot-a",
          { revision: first.revision, targets: [{ ...target, ...changes }] },
          async () => true,
        ),
      );
    }
    await assert.rejects(
      store.save(
        "bot-a",
        { revision: first.revision, targets: [{ ...target, credentialRef: randomUUID() }] },
        async () => false,
      ),
    );
    assert.deepEqual(
      readFileSync(file),
      before,
      "rejected grants leave the prior revision untouched",
    );
    const outcomes = await Promise.allSettled([
      store.save(
        "bot-a",
        { revision: first.revision, targets: [{ ...target, enabled: false }] },
        async () => true,
      ),
      store.save("bot-a", { revision: first.revision, targets: [] }, async () => true),
    ]);
    assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal(
      store.read("bot-a").targets.some((value) => value.enabled),
      false,
    );
    chmodSync(file, 0o644);
    assert.throws(() => store.read("bot-a"));
    chmodSync(file, 0o600);
    writeFileSync(file, "broken JSON");
    assert.throws(() => store.read("bot-a"));
    assert.throws(() => store.read("../foreign"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("denial persists with retryable credential cleanup and cannot be revived by an old verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-cleanup-"));
  const store = new RemoteSettingsStore(root, "f".repeat(64));
  const target = {
    alias: "a",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read"],
  };
  let release: (value: boolean) => void = () => {};
  let stale: Promise<unknown> | undefined;
  try {
    const saved = await store.save(
      "bot-a",
      { revision: "unconfigured", targets: [target] },
      async () => true,
    );
    stale = store.save(
      "bot-a",
      {
        revision: saved.revision,
        targets: [{ ...target, operations: ["file.read", "file.list"] }],
      },
      async () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const rejected = assert.rejects(
      stale,
      (error: unknown) => error instanceof RemoteSettingsError && error.code === "conflict",
    );
    const denied = await store.save(
      "bot-a",
      { revision: saved.revision, targets: [] },
      async () => false,
    );
    release(true);
    await rejected;
    assert.deepEqual(denied.pendingRemovals, [
      { credentialRef: target.credentialRef, origin: target.origin },
    ]);
    const reopened = new RemoteSettingsStore(root, "f".repeat(64));
    assert.deepEqual(reopened.read("bot-a").pendingRemovals, denied.pendingRemovals);
    await assert.rejects(
      reopened.save("bot-a", { revision: denied.revision, targets: [target] }, async () => true),
    );
    const removal = denied.pendingRemovals[0];
    assert.ok(removal);
    reopened.completeRemoval("bot-a", removal);
    assert.deepEqual(reopened.read("bot-a").pendingRemovals, []);
  } finally {
    release(false);
    await stale?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("another Bot can revoke while an unrelated grant verification is stalled", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-independent-"));
  const store = new RemoteSettingsStore(root, "e".repeat(64));
  const target = {
    alias: "a",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read"],
  };
  let release: (value: boolean) => void = () => {};
  let pending: Promise<unknown> | undefined;
  try {
    const saved = await store.save(
      "bot-b",
      { revision: "unconfigured", targets: [target] },
      async () => true,
    );
    pending = store.save(
      "bot-a",
      { revision: "unconfigured", targets: [target] },
      async () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const revoked = await Promise.race([
      store.save("bot-b", { revision: saved.revision, targets: [] }, async () => true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("another Bot blocks revocation")), 300),
      ),
    ]);
    assert.deepEqual(revoked.targets, []);
  } finally {
    release(true);
    await pending?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("revocation does not wait for unrelated credentials or another Bot's asynchronous grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-revoke-"));
  const store = new RemoteSettingsStore(root, "b".repeat(64));
  const target = {
    alias: "a",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read"],
  };
  let release: (value: boolean) => void = () => {};
  let pending: Promise<unknown> | undefined;
  try {
    const other = { ...target, alias: "b", credentialRef: randomUUID() };
    const saved = await store.save(
      "bot-b",
      { revision: "unconfigured", targets: [target, other] },
      async () => true,
    );
    let checked = false;
    const reduced = await store.save(
      "bot-b",
      { revision: saved.revision, targets: [{ ...target, enabled: false }, other] },
      async () => {
        checked = true;
        return false;
      },
    );
    assert.equal(checked, false, "unchanged unrelated credentials cannot block revocation");
    assert.equal(reduced.targets[0]?.enabled, false);
    let entered = false;
    pending = store.save("bot-a", { revision: "unconfigured", targets: [target] }, async () => {
      entered = true;
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entered, true);
    const removed = await Promise.race([
      store.save("bot-b", { revision: reduced.revision, targets: [] }, async () => false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("unrelated grant blocked revocation")), 300),
      ),
    ]);
    assert.deepEqual(removed.targets, []);
    release(true);
    await pending;
  } finally {
    release(false);
    await pending?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("grant verification has one 15 second budget and never prevents a later revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-budget-"));
  const store = new RemoteSettingsStore(root, "c".repeat(64));
  let signal: AbortSignal | undefined;
  const target = {
    alias: "a",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read"],
  };
  try {
    const started = performance.now();
    await assert.rejects(
      Promise.race([
        store.save(
          "bot-a",
          { revision: "unconfigured", targets: [target] },
          async (_target, nextSignal) => {
            signal = nextSignal;
            return new Promise<boolean>(() => {});
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("unbounded verification")), 17_000),
        ),
      ]),
      (error: unknown) => error instanceof RemoteSettingsError && error.code === "unavailable",
    );
    assert.ok(performance.now() - started < 17_000);
    assert.equal(signal?.aborted, true);
    const saved = await store.save(
      "bot-a",
      { revision: "unconfigured", targets: [] },
      async () => true,
    );
    assert.deepEqual(saved.targets, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote authority rejects trailing newlines and caps actual reads after a concurrent file growth", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-read-"));
  const namespace = "d".repeat(64);
  const store = new RemoteSettingsStore(root, namespace);
  const target = {
    alias: "a",
    enabled: true,
    origin: "https://fixture.example.test",
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read"],
  };
  try {
    for (const newline of ["\n", "\r\n"]) {
      assert.throws(() => new RemoteSettingsStore(root, namespace + newline));
      assert.throws(() => store.read(`bot-a${newline}`));
      for (const field of ["alias", "machineId", "credentialRef"]) {
        const value = { ...target, [field]: target[field as keyof typeof target] + newline };
        await assert.rejects(
          store.save("bot-a", { revision: "unconfigured", targets: [value] }, async () => true),
        );
      }
      await assert.rejects(
        store.save("bot-a", { revision: `unconfigured${newline}`, targets: [] }, async () => true),
        (error: unknown) => error instanceof RemoteSettingsError && error.code === "invalid",
      );
    }
    await store.save("bot-a", { revision: "unconfigured", targets: [target] }, async () => true);
    const file = join(root, "remote-tools", "bot-a.json");
    const prior = readFileSync(file);
    const original = fs.fstatSync;
    mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
      const result = original(...args);
      writeFileSync(file, Buffer.concat([prior, Buffer.alloc(2 * 1024 * 1024, 32)]));
      return result;
    });
    syncBuiltinESMExports();
    assert.throws(
      () => store.read("bot-a"),
      "size checked before growth must not permit an unbounded read",
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("new grants reserve pending slots so a failed cleanup backlog cannot block disabling every target", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-capacity-"));
  const store = new RemoteSettingsStore(root, "a".repeat(64));
  const targets = (round: number) =>
    Array.from({ length: 8 }, (_, index) => ({
      alias: `mac-${index}`,
      enabled: true,
      origin: "https://fixture.example.test",
      machineId: `machine-${index}`,
      credentialRef: `fixture-${round}-${index}`,
      operations: ["file.read"],
    }));
  try {
    let saved = await store.save(
      "bot-a",
      { revision: "unconfigured", targets: targets(0) },
      async () => true,
    );
    for (let round = 1; round < 16; round++)
      saved = await store.save(
        "bot-a",
        {
          revision: saved.revision,
          targets: targets(round),
        },
        async () => true,
      );
    assert.equal(saved.pendingRemovals.length, 120);
    await assert.rejects(
      store.save("bot-a", { revision: saved.revision, targets: targets(16) }, async () => true),
      (error: unknown) => error instanceof RemoteSettingsError && error.code === "unavailable",
    );
    const disabled = await store.save(
      "bot-a",
      {
        revision: saved.revision,
        targets: saved.targets.map((target) => ({ ...target, enabled: false })),
      },
      async () => false,
    );
    assert.equal(disabled.pendingRemovals.length, 128);
    assert.equal(
      new RemoteSettingsStore(root, store.namespace)
        .read("bot-a")
        .targets.some((target) => target.enabled),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new grants also reserve serialized bytes for disabling before the pending count limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-byte-reserve-"));
  const store = new RemoteSettingsStore(root, "b".repeat(64));
  const origin = `https://${Array.from({ length: 28 }, () => "a".repeat(60)).join(".")}.test`;
  const target = {
    alias: "mac",
    enabled: true,
    origin,
    machineId: "machine-b",
    credentialRef: randomUUID(),
    operations: ["file.read"],
  };
  try {
    let saved = await store.save(
      "bot-a",
      { revision: "unconfigured", targets: [target] },
      async () => true,
    );
    let limited = false;
    for (let round = 0; round < 50; round++) {
      try {
        saved = await store.save(
          "bot-a",
          { revision: saved.revision, targets: [{ ...target, credentialRef: randomUUID() }] },
          async () => true,
        );
      } catch (error) {
        assert.ok(error instanceof RemoteSettingsError && error.code === "unavailable");
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
    assert.ok(
      saved.pendingRemovals.length < 128,
      "this fixture exercises bytes, not the item count",
    );
    const disabled = await store.save(
      "bot-a",
      {
        revision: saved.revision,
        targets: saved.targets.map((value) => ({ ...value, enabled: false })),
      },
      async () => false,
    );
    assert.equal(
      disabled.targets.some((value) => value.enabled),
      false,
    );
    assert.ok(statSync(join(root, "remote-tools", "bot-a.json")).size <= 65_536);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy full backlog fails closed and stays denied while cleanup makes room for explicit recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-legacy-full-"));
  const store = new RemoteSettingsStore(root, "c".repeat(64));
  try {
    store.read("bot-a");
    const pendingRemovals = Array.from({ length: 128 }, (_, index) => ({
      origin: "https://fixture.example.test",
      credentialRef: `fixture-old-${index}`,
    }));
    const target = {
      alias: "mac",
      enabled: true,
      origin: "https://fixture.example.test",
      machineId: "machine-b",
      credentialRef: "fixture-current",
      operations: ["file.read"],
    };
    writeFileSync(
      join(root, "remote-tools", "bot-a.json"),
      JSON.stringify({
        namespace: store.namespace,
        revision: "legacy-full",
        targets: [target],
        pendingRemovals,
      }),
      { mode: 0o600 },
    );
    assert.equal(
      store.read("bot-a").targets.some((value) => value.enabled),
      false,
    );
    for (const binding of pendingRemovals) {
      store.completeRemoval("bot-a", binding);
      assert.equal(
        new RemoteSettingsStore(root, store.namespace)
          .read("bot-a")
          .targets.some((value) => value.enabled),
        false,
        "freeing one slot cannot silently revive the legacy authority",
      );
    }
    const recovered = await store.save(
      "bot-a",
      { revision: store.read("bot-a").revision, targets: [] },
      async () => false,
    );
    assert.deepEqual(recovered.targets, []);
    assert.deepEqual(recovered.pendingRemovals, [
      { origin: target.origin, credentialRef: target.credentialRef },
    ]);
    const currentRemoval = recovered.pendingRemovals[0];
    assert.ok(currentRemoval);
    store.completeRemoval("bot-a", currentRemoval);
    assert.deepEqual(store.read("bot-a").pendingRemovals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
