import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("independent Bots helper binds a private Keychain item across real processes without exposing credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "eagle-bots-helper-"));
  let binary = "";
  const binding = {
    namespace: createHash("sha256").update(directory).digest("hex"),
    botId: `b_${randomUUID()}`,
    credentialRef: randomUUID(),
    origin: "https://fixture.example.test",
  };
  const secrets = {
    ownerToken: `isolated-owner-${randomUUID()}`,
    accessClientID: "isolated-access-client",
    accessClientSecret: `isolated-access-${randomUUID()}`,
  };
  function invoke(
    action: string,
    replacement: object = binding,
    values: object = {},
  ) {
    return spawnSync(binary, [], {
      input: JSON.stringify({ action, binding: replacement, ...values }),
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 65_536,
    });
  }
  try {
    const built = spawnSync(
      resolve("scripts/swift-gate.sh"),
      [
        "build",
        "--package-path",
        "apps/bots-macos",
        "--scratch-path",
        directory,
        "--product",
        "BotsCredentialHelper",
      ],
      { encoding: "utf8", timeout: 90_000 },
    );
    assert.equal(built.status, 0, built.stderr);
    const path = spawnSync(
      resolve("scripts/swift-gate.sh"),
      [
        "build",
        "--package-path",
        "apps/bots-macos",
        "--scratch-path",
        directory,
        "--show-bin-path",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(path.status, 0, path.stderr);
    binary = join(path.stdout.trim(), "BotsCredentialHelper");
    assert.equal(invoke("read").status, 1);
    const stored = invoke("put", binding, secrets);
    assert.equal(
      stored.status,
      0,
      "new isolated Keychain binding should be saved",
    );
    assert.equal(stored.stdout.includes(secrets.ownerToken), false);
    assert.deepEqual(JSON.parse(stored.stdout), { available: true });
    assert.deepEqual(JSON.parse(invoke("status").stdout), { available: true });
    const read = invoke("read");
    assert.equal(read.status, 0);
    const payload = JSON.parse(read.stdout);
    assert.deepEqual(payload.binding, binding);
    assert.equal(payload.ownerToken === secrets.ownerToken, true);
    assert.equal(
      payload.accessClientSecret === secrets.accessClientSecret,
      true,
    );
    assert.equal(read.stderr, "");
    for (const action of ["put", "read", "remove"]) {
      const rejected = invoke(
        action,
        { ...binding, origin: "https://foreign.example.test" },
        action === "put" ? secrets : {},
      );
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, "");
      assert.equal(rejected.stderr, "needs_local\n");
    }
    assert.equal(
      invoke("put", binding, { ...secrets, accessClientSecret: undefined })
        .status,
      1,
    );
    assert.equal(
      invoke("put", binding, { ...secrets, unknown: "rejected" }).status,
      1,
    );
    assert.equal(
      invoke("put", { ...binding, origin: "http://foreign.test" }, secrets)
        .status,
      1,
    );
    const changed = { ownerToken: `isolated-rotated-${randomUUID()}` };
    assert.equal(invoke("put", binding, changed).status, 0);
    const rotated = JSON.parse(invoke("read").stdout);
    assert.equal(rotated.ownerToken === changed.ownerToken, true);
    assert.equal(rotated.accessClientID, undefined);
    const oversized = spawnSync(binary, [], {
      input: "x".repeat(65_537),
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stdout, "");
    assert.equal(invoke("remove").status, 0);
    assert.deepEqual(JSON.parse(invoke("status").stdout), { available: false });
    assert.equal(invoke("read").status, 1);
  } finally {
    try {
      if (binary) {
        assert.equal(
          invoke("remove").status,
          0,
          "remove the exact fixture binding",
        );
        assert.equal(
          invoke("read").status,
          1,
          "fixture binding must be absent",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Keychain mutations preserve a replacement origin after a real cross-process race", () => {
  const result = spawnSync(
    "python3",
    [
      "tests/fixtures/keychain-binding-race.py",
      "apps/bots-macos/Sources/BotsCredentialHelper/Entry.swift",
      "native-gate",
    ],
    {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"failingAssertions": 0/);
  assert.match(result.stdout, /"allRandomFixtureBindingsAbsent": true/);
});
