import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CommandRequest,
  CommandRunner,
} from "../packages/agent/command-runner.ts";
import { OperationJournal } from "../packages/agent/operation-journal.ts";

function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  enabled = true,
  secrets: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "eagle-command-"));
  const journal = new OperationJournal(
    join(root, "private", "operations.sqlite"),
  );
  const runner = new CommandRunner(journal, {
    machineId: "test-mac",
    enabled,
    workingDirectory: root,
    secrets,
  });
  t.after(async () => {
    await runner.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = (
    id: string,
    program: string,
    args: string[],
  ): CommandRequest => ({
    id,
    machineId: "test-mac",
    program,
    args,
  });
  return { root, journal, runner, request };
}

test("real commands return stdout, stderr and their actual exit code without Herdr", async (t) => {
  const { runner, request } = fixture(t);
  const result = await runner.run(
    request("exit-status", "/bin/sh", [
      "-c",
      "printf actual-out; printf actual-err >&2; exit 7",
    ]),
  );
  assert.deepEqual(result, {
    id: "exit-status",
    state: "failed",
    stdout: "actual-out",
    stderr: "actual-err",
    exitCode: 7,
  });
  const environment = await runner.run(
    request("clean-environment", process.execPath, [
      "-e",
      "process.stdout.write(String(process.env.HERDR_ENV))",
    ]),
  );
  assert.equal(environment.state, "succeeded");
  assert.equal(environment.stdout, "undefined");
});

test("a repeated operation applies its real file effect once and conflicting content is rejected", async (t) => {
  const { root, journal, runner, request } = fixture(t);
  const input = request("append-once", "/bin/sh", [
    "-c",
    "printf x >> effect; printf done",
  ]);
  const [first, concurrent] = await Promise.all([
    runner.run(input),
    runner.run(input),
  ]);
  assert.equal(first.state, "succeeded");
  assert.deepEqual(concurrent, first);
  assert.deepEqual(await runner.run(input), first);
  assert.equal(readFileSync(join(root, "effect"), "utf8"), "x");
  await assert.rejects(
    runner.run({ ...input, args: ["-c", "printf changed >> effect"] }),
    /conflict/i,
  );
  assert.deepEqual(journal.get(input.id), first);
});

test("machine mismatch and a disabled command capability cause no admission or side effects", async (t) => {
  const { root, journal, runner, request } = fixture(t, false);
  const input = request("disabled", "/bin/sh", ["-c", "printf bad > effect"]);
  await assert.rejects(runner.run(input), /disabled/i);
  assert.equal(journal.get(input.id), null);
  assert.equal(existsSync(join(root, "effect")), false);
  const enabled = fixture(t);
  await assert.rejects(
    enabled.runner.run({ ...input, machineId: "other-mac" }),
    /machine/i,
  );
  assert.equal(enabled.journal.get(input.id), null);
});

test("combined output stays within 64 KiB with real flooding and invalid UTF-8", async (t) => {
  const { runner, request } = fixture(t);
  const result = await runner.run(
    request("bounded", process.execPath, [
      "-e",
      "process.stdout.write(Buffer.alloc(200000,255)); process.stderr.write('z'.repeat(200000));",
    ]),
  );
  assert.equal(result.state, "succeeded");
  assert.equal(result.exitCode, 0);
  assert(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
      65536,
  );
  assert.match(result.stderr, /truncated/i);
});

test("cancel before spawn prevents an effect; cancel after spawn signals it but retains unknown", async (t) => {
  const { root, runner, request } = fixture(t);
  const early = runner.run(
    request("cancel-early", "/bin/sh", ["-c", "printf bad > early"]),
  );
  assert.equal(runner.cancel("cancel-early"), true);
  assert.equal((await early).state, "cancelled");
  assert.equal(existsSync(join(root, "early")), false);
  const started = runner.run(
    request("cancel-running", process.execPath, [
      "-e",
      "const fs=require('node:fs'); fs.writeFileSync('ready','1'); setInterval(()=>fs.appendFileSync('ticks','x'),10);",
    ]),
  );
  const deadline = Date.now() + 3000;
  while (!existsSync(join(root, "ready")) && Date.now() < deadline)
    await delay(5);
  assert.equal(existsSync(join(root, "ready")), true);
  assert.equal(runner.cancel("cancel-running"), true);
  const result = await started;
  assert.equal(result.state, "unknown");
  assert.equal(result.exitCode, null);
  const ticks = () =>
    existsSync(join(root, "ticks"))
      ? readFileSync(join(root, "ticks"), "utf8")
      : "";
  const before = ticks();
  await delay(60);
  assert.equal(ticks(), before);
});

test("timeouts are bounded and retries do not replay unknown work", async (t) => {
  const { runner, request } = fixture(t);
  const input = {
    ...request("deadline", process.execPath, [
      "-e",
      "setInterval(()=>{},1000)",
    ]),
    timeoutMs: 100,
  };
  const result = await runner.run(input);
  assert.equal(result.state, "unknown");
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /timeout/i);
  assert.deepEqual(await runner.run(input), result);
});

test("known credentials are rejected as arguments and filtered before journal persistence", async (t) => {
  const secret = "isolated-command-secret-with-at-least-32-characters";
  const { root, runner, journal, request } = fixture(t, true, [secret]);
  await assert.rejects(
    runner.run(request("bad-argument", "/usr/bin/printf", [secret])),
    /credential/i,
  );
  assert.equal(journal.get("bad-argument"), null);
  writeFileSync(join(root, "output"), secret);
  const result = await runner.run(
    request("redacted-result", "/bin/cat", ["output"]),
  );
  assert.equal(result.state, "succeeded");
  assert.equal(result.stdout, "[REDACTED]");
  assert.equal(
    JSON.stringify(journal.get("redacted-result")).includes(secret),
    false,
  );
});

test("JSON-escaped credentials in raw argv, program or cwd are rejected before admission", async (t) => {
  const secret = 'isolated-"quoted"-credential-at-least-32-characters';
  const { runner, journal, request } = fixture(t, true, [secret]);
  for (const [field, change] of Object.entries({
    args: { args: [secret] },
    program: { program: `/tmp/${secret}` },
    cwd: { cwd: `/tmp/${secret}` },
  })) {
    const input = {
      ...request(`raw-${field}`, "/usr/bin/printf", ["unused"]),
      ...change,
    };
    await assert.rejects(runner.run(input), /credential/i);
    assert.equal(journal.get(input.id), null);
  }
});

test("cancelled and timed-out partial credentials are redacted before persistence", async (t) => {
  const secret = "isolated-private-credential-with-at-least-32-characters";
  const { root, runner, journal, request } = fixture(t, true, [secret]);
  writeFileSync(join(root, "credential-fixture"), secret, { mode: 0o600 });
  for (const mode of ["cancel", "timeout"]) {
    const input = {
      ...request(`partial-${mode}`, process.execPath, [
        "-e",
        "const fs=require('node:fs'); process.stdout.write(fs.readFileSync('credential-fixture','utf8').slice(0,-1),()=>fs.writeFileSync('ready-" +
          mode +
          "','1'));setInterval(()=>{},1000);",
      ]),
      timeoutMs: mode === "timeout" ? 500 : 3000,
    };
    const work = runner.run(input);
    const deadline = Date.now() + 2000;
    while (!existsSync(join(root, `ready-${mode}`)) && Date.now() < deadline)
      await delay(5);
    assert.equal(existsSync(join(root, `ready-${mode}`)), true);
    if (mode === "cancel") assert.equal(runner.cancel(input.id), true);
    const result = await work;
    assert.equal(result.state, "unknown");
    assert.equal(result.stdout, "[REDACTED]");
    assert.deepEqual(journal.get(input.id), result);
  }
});

test("a real SQLite admission failure latches the runner off even after storage recovers", async (t) => {
  const { root, runner, journal, request } = fixture(t);
  // Fault injection through the already-owned connection preserves its locks.
  const database = (journal as unknown as { database: DatabaseSync }).database;
  database.exec("PRAGMA query_only = ON");
  await assert.rejects(
    runner.run(request("storage-fails", "/usr/bin/printf", ["not run"])),
    /readonly|storage/i,
  );
  database.exec("PRAGMA query_only = OFF");
  await assert.rejects(
    runner.run(
      request("storage-restored", "/bin/sh", ["-c", "printf bad > effect"]),
    ),
    /unavailable/i,
  );
  assert.equal(journal.get("storage-fails"), null);
  assert.equal(journal.get("storage-restored"), null);
  assert.equal(existsSync(join(root, "effect")), false);
});

test("an ordinary admission conflict does not poison a healthy runner", async (t) => {
  const { runner, request } = fixture(t);
  const input = request("ordinary-conflict", "/usr/bin/printf", ["first"]);
  await runner.run(input);
  await assert.rejects(
    runner.run({ ...input, args: ["conflict"] }),
    /conflict/i,
  );
  assert.equal(
    (await runner.run(request("after-conflict", "/usr/bin/printf", ["next"])))
      .stdout,
    "next",
  );
});
