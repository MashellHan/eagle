import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandRunner } from "../packages/agent/command-runner.ts";
import {
  type FileGrant,
  FileProvider,
} from "../packages/agent/file-provider.ts";
import { OperationJournal } from "../packages/agent/operation-journal.ts";

function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  commands = false,
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "eagle-file-execution-")),
  );
  const allowed = join(root, "files");
  mkdirSync(allowed);
  writeFileSync(join(allowed, "text"), "first read");
  const journalPath = join(root, "private", "operations.sqlite");
  let journal = new OperationJournal(journalPath);
  let grants: FileGrant[] = [
    { id: "documents", generation: "g1", root: allowed },
  ];
  const createRunner = () =>
    new CommandRunner(journal, {
      machineId: "file-mac",
      enabled: commands,
      workingDirectory: root,
      files: new FileProvider({
        grants: () => grants,
        privateRoot: join(root, "private"),
      }),
    });
  let runner = createRunner();
  t.after(async () => {
    await runner.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = {
    id: "file-once",
    machineId: "file-mac",
    tool: "file.read" as const,
    grantId: "documents",
    generation: "g1",
    path: "text",
  };
  return {
    root,
    allowed,
    request,
    get runner() {
      return runner;
    },
    get journal() {
      return journal;
    },
    revoke: () => {
      grants = [];
    },
    restart: async () => {
      await runner.close();
      journal.close();
      journal = new OperationJournal(journalPath);
      runner = createRunner();
    },
  };
}

test("file tools share durable admission while commands remain disabled", async (t) => {
  const f = fixture(t);
  const first = await f.runner.runFile(f.request);
  assert.deepEqual(first, {
    id: "file-once",
    state: "succeeded",
    stdout: "first read",
    stderr: "",
    exitCode: null,
  });
  writeFileSync(join(f.allowed, "text"), "later contents");
  assert.deepEqual(await f.runner.runFile(f.request), first);
  assert.deepEqual(f.runner.getVisible(f.request.id), first);
  await assert.rejects(
    f.runner.runFile({ ...f.request, path: "different" }),
    /conflict/i,
  );
  await assert.rejects(
    f.runner.run({
      id: "not-enabled",
      machineId: "file-mac",
      program: "/usr/bin/printf",
      args: ["not run"],
    }),
    /disabled/i,
  );
  assert.equal(f.journal.get("not-enabled"), null);
});

test("grant revocation hides cached file results across query, retry and process reconstruction", async (t) => {
  const f = fixture(t);
  await f.runner.runFile(f.request);
  await f.restart();
  assert.equal(f.runner.getVisible(f.request.id)?.stdout, "first read");
  f.revoke();
  assert.throws(() => f.runner.getVisible(f.request.id), /grant|revoked/i);
  await assert.rejects(f.runner.runFile(f.request), /grant|revoked/i);
  assert.equal(
    f.journal.get(f.request.id)?.stdout,
    "first read",
    "private dedup evidence is retained, not exposed",
  );
});

test("file and command work use one active slot and one journal admission", async (t) => {
  const f = fixture(t, true);
  const work = f.runner.runFile(f.request);
  await assert.rejects(
    f.runner.run({
      id: "busy-command",
      machineId: "file-mac",
      program: "/usr/bin/printf",
      args: ["not run"],
    }),
    /busy/i,
  );
  await work;
  assert.equal(f.journal.get("busy-command"), null);
  assert.equal(readFileSync(join(f.allowed, "text"), "utf8"), "first read");
});

test("disabled commands do not make file access depend on an obsolete command directory", async (t) => {
  const f = fixture(t);
  const provider = new FileProvider({
    privateRoot: join(f.root, "private"),
    grants: () => [{ id: "documents", generation: "g1", root: f.allowed }],
  });
  let runner: CommandRunner | undefined;
  try {
    runner = new CommandRunner(f.journal, {
      machineId: "file-mac",
      enabled: false,
      workingDirectory: join(f.root, "removed-directory"),
      files: provider,
    });
    assert.equal((await runner.runFile(f.request)).stdout, "first read");
  } finally {
    await runner?.close();
  }
});
