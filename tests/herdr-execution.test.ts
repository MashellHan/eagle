import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandRunner } from "../packages/agent/command-runner.ts";
import { HerdrProvider } from "../packages/agent/herdr-provider.ts";
import { OperationJournal } from "../packages/agent/operation-journal.ts";
import { herdrFixture } from "./fixtures/herdr-fixture.ts";

test("Herdr setup shares durable admission with disabled commands; retries keep original configuration evidence", async (t) => {
  const f = herdrFixture(t);
  const journal = new OperationJournal(
    join(f.directory, "execution", "operations.sqlite"),
  );
  const herdr = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [f.binary],
  });
  const runner = new CommandRunner(journal, {
    machineId: "herdr-mac",
    enabled: false,
    workingDirectory: ".",
    herdr,
  });
  try {
    await assert.rejects(
      runner.run({
        id: "command",
        machineId: "herdr-mac",
        program: "/usr/bin/true",
        args: [],
      }),
      /disabled/,
    );
    const probe = await runner.runHerdr({
      id: "probe",
      machineId: "herdr-mac",
      tool: "herdr.setup",
      action: "probe",
    });
    const configure = {
      id: "configure",
      machineId: "herdr-mac",
      tool: "herdr.setup" as const,
      action: "configure" as const,
      session: "work",
      enabled: true,
      expectedRevision: JSON.parse(probe.stdout).revision,
    };
    const first = await runner.runHerdr(configure);
    assert.equal(first.state, "succeeded");
    assert.equal(JSON.parse(first.stdout).state, "ready");
    const count = readFileSync(f.calls, "utf8").length;
    assert.deepEqual(await runner.runHerdr(configure), first);
    assert.equal(readFileSync(f.calls, "utf8").length, count);
    await assert.rejects(
      runner.runHerdr({ ...configure, session: "default" }),
      /conflict/i,
    );
    await assert.rejects(
      runner.runHerdr({
        ...configure,
        id: "foreign",
        machineId: "another-mac",
      }),
      /identity|invalid/i,
    );
    assert.equal(journal.get("foreign"), null);
    const stop = {
      id: "disable",
      machineId: "herdr-mac",
      tool: "herdr.setup" as const,
      action: "disable" as const,
      expectedRevision: JSON.parse(first.stdout).revision,
    };
    const disabled = await runner.runHerdr(stop);
    assert.deepEqual(await runner.runHerdr(stop), disabled);
    assert.deepEqual(
      runner.getVisible("configure"),
      first,
      "get remains historical evidence, not a fresh ready observation",
    );
    const inspection = await runner.runHerdr({
      id: "inspect-disabled",
      machineId: "herdr-mac",
      tool: "herdr.inspect",
      action: "agents",
      session: "work",
      expectedRevision: JSON.parse(disabled.stdout).revision,
    });
    assert.equal(inspection.state, "failed");
    assert.equal(inspection.stdout, "");
  } finally {
    await runner.close();
    journal.close();
  }
});

test("explicit creation starts only a fresh named headless session and its operation retry never starts another", {
  timeout: 5000,
}, async (t) => {
  const f = herdrFixture(t);
  const journal = new OperationJournal(
    join(f.directory, "execution", "operations.sqlite"),
  );
  const herdr = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [f.binary],
  });
  const runner = new CommandRunner(journal, {
    machineId: "herdr-mac",
    enabled: false,
    workingDirectory: ".",
    herdr,
  });
  try {
    const request = {
      id: "headless",
      machineId: "herdr-mac",
      tool: "herdr.setup" as const,
      action: "create_session" as const,
      session: "eagle-new-session",
      enabled: true,
      expectedRevision: "unconfigured",
    };
    const existing = await runner.runHerdr({
      ...request,
      id: "existing",
      session: "work",
    });
    assert.equal(existing.state, "failed");
    assert.equal(existsSync(f.serverPid), false);
    const result = await runner.runHerdr(request);
    assert.equal(result.state, "succeeded");
    assert.equal(JSON.parse(result.stdout).state, "ready");
    assert.equal(JSON.parse(result.stdout).session, "eagle-new-session");
    const pid = Number(readFileSync(f.serverPid, "utf8"));
    process.kill(pid, 0);
    assert.deepEqual(await runner.runHerdr(request), result);
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((call) => call.args.includes("server")).length,
      1,
    );
    assert.ok(
      calls.every(
        (call) =>
          !call.args.includes("stop") &&
          !call.args.includes("delete") &&
          call.nested === null,
      ),
    );
  } finally {
    await runner.close();
    journal.close();
  }
});

test("one Herdr deadline covers all subprocess probes and cancelled or timed-out IDs never repeat work", {
  timeout: 5000,
}, async (t) => {
  const f = herdrFixture(t);
  const journal = new OperationJournal(
    join(f.directory, "execution", "operations.sqlite"),
  );
  const herdr = new HerdrProvider({
    configPath: f.configPath,
    binaryCandidates: [f.binary],
  });
  await f.invoke(herdr, "configure", { session: "work", enabled: true });
  const source = readFileSync(f.binary, "utf8");
  writeFileSync(
    f.binary,
    source.replace(
      "const args=",
      "await new Promise(r=>setTimeout(r,120));\nconst args=",
    ),
  );
  const runner = new CommandRunner(journal, {
    machineId: "herdr-mac",
    enabled: false,
    workingDirectory: ".",
    herdr,
  });
  try {
    const request = {
      id: "deadline",
      machineId: "herdr-mac",
      tool: "herdr.setup" as const,
      action: "verify" as const,
      timeoutMs: 300,
    };
    const start = performance.now();
    const result = await runner.runHerdr(request);
    assert.equal(result.state, "unknown");
    assert.ok(performance.now() - start < 1800);
    const calls = readFileSync(f.calls, "utf8");
    assert.deepEqual(await runner.runHerdr(request), result);
    assert.equal(readFileSync(f.calls, "utf8"), calls);
    const cancelled = runner.runHerdr({
      ...request,
      id: "cancel-before-start",
    });
    assert.equal(runner.cancel("cancel-before-start"), true);
    assert.equal((await cancelled).state, "cancelled");
    assert.equal(readFileSync(f.calls, "utf8"), calls);
  } finally {
    await runner.close();
    journal.close();
  }
});
