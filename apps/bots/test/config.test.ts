// The daemon configuration is the only place the environment is read, so its defaults and
// its argument handling are pinned here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_PORT,
  DEFAULT_QUARANTINE_RETRY_MS,
  readConfig,
} from "../src/config.ts";

test("defaults, arguments and environment agree", () => {
  const defaults = readConfig({ argv: [], env: {}, home: "/home/tester" });
  assert.equal(defaults.root, "/home/tester/.local/share/eagle-bots");
  assert.equal(defaults.port, DEFAULT_PORT);
  assert.equal(defaults.idleCloseMs, DEFAULT_IDLE_CLOSE_MS);
  assert.equal(defaults.quarantineRetryMs, DEFAULT_QUARANTINE_RETRY_MS);
  assert.equal(defaults.closeDeadlineMs, DEFAULT_CLOSE_DEADLINE_MS);
  assert.equal(defaults.logLevel, "debug");
  assert.deepEqual(defaults.model, { provider: "magpie", modelId: "auto/gpt-6-luna" });

  const explicit = readConfig({
    argv: ["--root", "/tmp/root", "--port", "43118"],
    env: { BOTS_LOG_LEVEL: "warn", BOTS_MODEL: "auto/gpt-6-1-sol", BOTS_IDLE_CLOSE_MS: "2500" },
  });
  assert.equal(explicit.root, "/tmp/root");
  assert.equal(explicit.port, 43118);
  assert.equal(explicit.logLevel, "warn");
  assert.equal(explicit.model.modelId, "auto/gpt-6-1-sol");
  assert.equal(explicit.idleCloseMs, 2_500);

  assert.throws(() => readConfig({ argv: ["--root"], env: {} }), /--root needs a path/);
  assert.throws(() => readConfig({ argv: ["--port"], env: {} }), /--port needs a number/);
  assert.equal(
    readConfig({ argv: ["--port", "not-a-number"], env: {} }).port,
    DEFAULT_PORT,
    "a malformed port falls back to the default",
  );
});
