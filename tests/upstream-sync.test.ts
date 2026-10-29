import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("upstream synchronization preserves isolated Git work and real process ownership", () => {
  const result = spawnSync("python3", ["tests/test_upstream_sync.py"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
});
