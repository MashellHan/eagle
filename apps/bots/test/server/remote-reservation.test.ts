import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemoteSettingsError, RemoteSettingsStore } from "../../src/server/remote-settings.ts";

test("a disabled native reservation keeps credential cleanup reachable after interrupted setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-reservation-"));
  const store = new RemoteSettingsStore(root, "e".repeat(64));
  const target = {
    alias: "mac",
    enabled: false,
    origin: "https://fixture.example.test",
    machineId: "mac-b",
    credentialRef: "reserved-fixture-ref",
    operations: ["file.read"],
  };
  let verified = false;
  try {
    const reserved = await store.save(
      "bot-a",
      { revision: "unconfigured", targets: [target] },
      async () => {
        verified = true;
        return false;
      },
    );
    assert.equal(verified, false, "reserving metadata needs no credential");
    const removed = await store.save(
      "bot-a",
      { revision: reserved.revision, targets: [] },
      async () => false,
    );
    assert.deepEqual(
      removed.pendingRemovals,
      [{ origin: target.origin, credentialRef: target.credentialRef }],
      "a possible helper write remains addressable even though activation never happened",
    );
    assert.deepEqual(removed.targets, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled native reservations also preserve enough capacity for their eventual cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "bots-remote-reservation-slots-"));
  const store = new RemoteSettingsStore(root, "f".repeat(64));
  const target = (index: number) => ({
    alias: "mac",
    enabled: false,
    origin: "https://fixture.example.test",
    machineId: "mac-b",
    credentialRef: `reserved-fixture-ref-${index}`,
    operations: ["file.read"],
  });
  try {
    let saved = await store.save(
      "bot-a",
      { revision: "unconfigured", targets: [target(0)] },
      async () => false,
    );
    for (let index = 1; index < 128; index++)
      saved = await store.save(
        "bot-a",
        { revision: saved.revision, targets: [target(index)] },
        async () => false,
      );
    assert.equal(saved.pendingRemovals.length, 127);
    await assert.rejects(
      store.save("bot-a", { revision: saved.revision, targets: [target(128)] }, async () => false),
      (error: unknown) => error instanceof RemoteSettingsError && error.code === "unavailable",
    );
    const removed = await store.save(
      "bot-a",
      { revision: saved.revision, targets: [] },
      async () => false,
    );
    assert.equal(removed.pendingRemovals.length, 128);
    assert.deepEqual(removed.targets, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
