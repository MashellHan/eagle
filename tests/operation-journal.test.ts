import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationJournal } from "../packages/agent/operation-journal.ts";

const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function fixture(t: { after: (fn: () => void) => void }, capacity = 10_000) {
  const root = mkdtempSync(join(tmpdir(), "eagle-operation-"));
  const file = join(root, "private", "operations.sqlite");
  const journal = new OperationJournal(file, capacity);
  t.after(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, journal };
}

test("a machine admits an operation once and returns its durable result on retry", (t) => {
  const { journal, file } = fixture(t);
  const id = randomUUID();
  const digest = fingerprint("bounded file read on this machine");
  const admitted = journal.begin(id, digest);
  assert.equal(admitted.created, true);
  assert.equal(admitted.operation.state, "running");
  assert.deepEqual(journal.begin(id, digest), {
    created: false,
    operation: admitted.operation,
  });
  const outcome = {
    state: "succeeded" as const,
    stdout: "actual file content",
    stderr: "",
    exitCode: 0,
  };
  journal.finish(id, outcome);
  journal.close();
  const reopened = new OperationJournal(file);
  try {
    assert.deepEqual(reopened.begin(id, digest), {
      created: false,
      operation: { id, ...outcome },
    });
  } finally {
    reopened.close();
  }
});

test("a reused operation ID rejects different content without changing the original", (t) => {
  const { journal } = fixture(t);
  const id = randomUUID();
  const first = journal.begin(id, fingerprint("first"));
  assert.throws(() => journal.begin(id, fingerprint("different")), /conflict/i);
  assert.deepEqual(journal.get(id), first.operation);
});

test("restart makes unfinished work unknown and never admits its retry as new", (t) => {
  const { journal, file } = fixture(t);
  const id = randomUUID();
  const digest = fingerprint("command with an external effect");
  journal.begin(id, digest);
  journal.close();
  const restarted = new OperationJournal(file);
  try {
    const retry = restarted.begin(id, digest);
    assert.equal(retry.created, false);
    assert.equal(retry.operation.state, "unknown");
    assert.equal(retry.operation.exitCode, null);
  } finally {
    restarted.close();
  }
});

test("another live journal owner cannot convert running operations to unknown", (t) => {
  const { journal, file } = fixture(t);
  const id = randomUUID();
  journal.begin(id, fingerprint("live"));
  assert.throws(() => new OperationJournal(file), /locked|busy/i);
  assert.equal(journal.get(id)?.state, "running");
});

test("a rejected same-process open preserves the OS lock against another Node process", (t) => {
  const { journal, file } = fixture(t);
  const id = randomUUID();
  journal.begin(id, fingerprint("live across a rejected local open"));
  assert.throws(() => new OperationJournal(file), /locked|busy/i);
  const moduleURL = new URL(
    "../packages/agent/operation-journal.ts",
    import.meta.url,
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { OperationJournal } from ${JSON.stringify(moduleURL)};
      try {
        const journal = new OperationJournal(process.env.EAGLE_JOURNAL_PROBE);
        process.stdout.write(JSON.stringify({ opened: true, operation: journal.get(process.env.EAGLE_JOURNAL_OPERATION) }));
        journal.close();
      } catch {
        process.stdout.write(JSON.stringify({ opened: false }));
      }
    `,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        EAGLE_JOURNAL_PROBE: file,
        EAGLE_JOURNAL_OPERATION: id,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { opened: false });
  assert.equal(journal.get(id)?.state, "running");
});

test("settlement returns exactly the stored identity and fields", (t) => {
  const { journal } = fixture(t);
  const id = randomUUID();
  journal.begin(id, fingerprint("return identity"));
  const outcome = {
    id: "injected",
    extra: "not part of the result contract",
    state: "succeeded" as const,
    stdout: "result",
    stderr: "",
    exitCode: 0,
  };
  const result = journal.finish(id, outcome);
  assert.deepEqual(result, journal.get(id));
  assert.equal(result.id, id);
  assert.equal(Object.hasOwn(result, "extra"), false);
});

test("settled results cannot be overwritten by late or repeated completion", (t) => {
  const { journal } = fixture(t);
  const id = randomUUID();
  journal.begin(id, fingerprint("cancel race"));
  const final = journal.finish(id, {
    state: "failed",
    stdout: "",
    stderr: "process failed",
    exitCode: 7,
  });
  assert.deepEqual(
    journal.finish(id, {
      state: "cancelled",
      stdout: "",
      stderr: "",
      exitCode: null,
    }),
    final,
  );
});

test("journal storage is private and capacity never evicts retry evidence", (t) => {
  const { journal, root, file } = fixture(t, 1);
  const id = randomUUID();
  const digest = fingerprint("retained");
  journal.begin(id, digest);
  assert.equal(statSync(join(root, "private")).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => journal.begin(randomUUID(), digest), /capacity/i);
  assert.equal(journal.begin(id, digest).created, false);
});
