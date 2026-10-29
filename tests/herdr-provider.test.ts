import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HerdrProvider } from "../packages/agent/herdr-provider.ts";

import { herdrFixture as fixture } from "./fixtures/herdr-fixture.ts";

test("existing Herdr is probed without reinstalling or inheriting pane credentials, and needs an explicit session", async (t) => {
  const f = fixture(t);
  let installed = false;
  const provider = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [f.binary],
    installer: async () => {
      installed = true;
      throw new Error("existing CLI must not be reinstalled");
    },
  });
  const initial = await f.invoke(provider, "probe");
  assert.equal(initial.checks.cli, true);
  assert.equal(initial.session, null);
  assert.equal(initial.state, "disabled");
  assert.deepEqual(
    initial.sessions.map((value: { name: string }) => value.name),
    ["default", "work"],
  );
  await f.invoke(provider, "install");
  assert.equal(installed, false);
  const configured = await f.invoke(provider, "configure", {
    session: "work",
    enabled: true,
  });
  assert.equal(configured.state, "ready");
  assert.deepEqual(configured.checks, {
    cli: true,
    server: true,
    session: true,
    tools: true,
  });
  const calls = readFileSync(f.calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    calls.every((call) => call.nested === null && call.secret === null),
  );
  assert.ok(
    calls
      .filter((call) => call.args.includes("agent"))
      .every((call) => call.args.slice(0, 2).join(" ") === "--session work"),
  );
  assert.ok(calls.every((call) => !call.args.includes("server")));
});

test("disabled or lost sessions never fall back, and changing configuration never closes Herdr", async (t) => {
  const f = fixture(t);
  const provider = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [f.binary],
  });
  await f.invoke(provider, "configure", { session: "work", enabled: true });
  const inspection = () => ({
    tool: "herdr.inspect" as const,
    action: "agents" as const,
    session: "work",
    expectedRevision: provider.capabilities().revision,
  });
  const agents = await provider.run(inspection(), new AbortController().signal);
  assert.equal(
    JSON.parse(agents.stdout).result.agents[0].name,
    "fixture-worker",
  );
  await f.invoke(provider, "disable");
  await assert.rejects(
    provider.run(inspection(), new AbortController().signal),
    /disabled/,
  );
  writeFileSync(f.state, "stopped");
  const missing = await f.invoke(provider, "configure", {
    session: "work",
    enabled: true,
  });
  assert.equal(missing.state, "needs_local_setup");
  assert.equal(missing.checks.session, false);
  await assert.rejects(
    provider.run(inspection(), new AbortController().signal),
  );
  const calls = readFileSync(f.calls, "utf8");
  assert.equal(calls.includes('"stop"'), false);
  assert.equal(calls.includes('"attach"'), false);
});

test("a failed install preserves its staging evidence and another explicit attempt can succeed without overwriting", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const provider = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [],
    installer: async () => {
      attempts++;
      return attempts === 1
        ? '#!/bin/sh\necho interrupted > "$HERDR_INSTALL_DIR/evidence"\nexit 1\n'
        : `#!/bin/sh\ncp '${f.binary}' "$HERDR_INSTALL_DIR/herdr"\nchmod 700 "$HERDR_INSTALL_DIR/herdr"\n`;
    },
  });
  const failed = await provider.run(
    { tool: "herdr.setup", action: "install" },
    new AbortController().signal,
  );
  assert.equal(failed.state, "failed");
  assert.equal((await f.invoke(provider, "install")).installed, true);
  assert.equal(attempts, 2);
  const before = readFileSync(join(f.directory, "herdr-bin", "herdr"));
  await f.invoke(provider, "install");
  assert.deepEqual(
    readFileSync(join(f.directory, "herdr-bin", "herdr")),
    before,
  );
  assert.equal(attempts, 2);
  assert.ok(
    readdirSync(f.directory)
      .filter((name) => name.startsWith(".herdr-install-"))
      .some((name) => existsSync(join(f.directory, name, "bin", "evidence"))),
  );
});

test("stale configuration changes are refused and oversized or malformed CLI output never becomes ready", async (t) => {
  const f = fixture(t);
  const provider = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [f.binary],
  });
  const initial = await f.invoke(provider, "probe");
  const ready = await f.invoke(provider, "configure", {
    session: "work",
    enabled: true,
  });
  await assert.rejects(
    f.invoke(provider, "disable", { expectedRevision: initial.revision }),
    /configuration changed/i,
  );
  assert.equal((await f.invoke(provider, "verify")).enabled, true);
  const source = readFileSync(f.binary, "utf8");
  writeFileSync(
    f.binary,
    source.replace(
      "console.log('herdr 0.9.5')",
      "console.log('herdr 0.9.5' + ' '.repeat(70000))",
    ),
  );
  assert.equal((await f.invoke(provider, "verify")).state, "unavailable");
  writeFileSync(
    f.binary,
    source.replace(
      "private_protocol_compatible: yes",
      "private_protocol_compatible: no",
    ),
  );
  assert.equal((await f.invoke(provider, "verify")).state, "unavailable");
  assert.equal(provider.capabilities().revision, ready.revision);
});

test("a missing CLI installs only into the owned directory then verifies, without treating installer output as ready", async (t) => {
  const f = fixture(t);
  const installedAt = join(f.directory, "herdr-bin", "herdr");
  const provider = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [],
    installer: async () =>
      `#!/bin/sh\nset -eu\ncp '${f.binary}' "$HERDR_INSTALL_DIR/herdr"\nchmod 700 "$HERDR_INSTALL_DIR/herdr"\necho installed\n`,
  });
  assert.equal((await f.invoke(provider, "probe")).state, "not_installed");
  const result = await f.invoke(provider, "install");
  assert.equal(existsSync(installedAt), true);
  assert.equal(result.installed, true);
  assert.equal(result.state, "disabled");
  assert.equal(result.checks.tools, null);
});
