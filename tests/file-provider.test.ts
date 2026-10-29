import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type FileGrant,
  FileProvider,
  type FileRequest,
} from "../packages/agent/file-provider.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "eagle-file-provider-")),
  );
  const allowed = join(root, "allowed");
  const privateRoot = join(allowed, "private-agent");
  mkdirSync(allowed);
  mkdirSync(privateRoot, { mode: 0o700 });
  const generation = "generation-one";
  let grants: FileGrant[] = [{ id: "documents", generation, root: allowed }];
  const secret = "isolated-file-provider-secret-at-least-32-characters";
  const provider = new FileProvider({
    grants: () => grants,
    privateRoot,
    secrets: [secret],
  });
  const request = (
    path: string,
    tool: FileRequest["tool"] = "file.read",
  ): FileRequest => ({
    tool,
    path,
    grantId: "documents",
    generation,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    allowed,
    privateRoot,
    provider,
    request,
    secret,
    revoke: () => {
      grants = [];
    },
  };
}

test("authorized real files and directory entries return bounded results without command permission", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.allowed, "notes.txt"), "actual file contents\n");
  const read = await f.provider.run(
    f.request("notes.txt"),
    new AbortController().signal,
  );
  assert.deepEqual(read, {
    state: "succeeded",
    stdout: "actual file contents\n",
    stderr: "",
    exitCode: null,
  });
  const list = await f.provider.run(
    f.request(".", "file.list"),
    new AbortController().signal,
  );
  assert.deepEqual(JSON.parse(list.stdout), [
    { name: "notes.txt", kind: "file" },
  ]);
  assert.equal(list.exitCode, null);
});

test("traversal, symlinks, hardlinks and private Agent state never become file contents", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "outside"), "outside evidence");
  writeFileSync(join(f.privateRoot, "credential.json"), f.secret);
  symlinkSync(join(f.root, "outside"), join(f.allowed, "linked"));
  symlinkSync(f.root, join(f.allowed, "linked-directory"));
  linkSync(join(f.root, "outside"), join(f.allowed, "hardlinked"));
  for (const path of [
    "../outside",
    "/etc/hosts",
    "linked",
    "linked-directory/outside",
    "hardlinked",
    "private-agent/credential.json",
  ])
    await assert.rejects(
      f.provider.run(f.request(path), new AbortController().signal),
    );
});

test("byte and entry budgets fail before returning unbounded content", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.allowed, "large"), Buffer.alloc(32 * 1024 + 1, 65));
  await assert.rejects(
    f.provider.run(f.request("large"), new AbortController().signal),
  );
  const many = join(f.allowed, "many");
  mkdirSync(many);
  for (let i = 0; i < 2001; i++) writeFileSync(join(many, `entry-${i}`), "");
  await assert.rejects(
    f.provider.run(
      f.request("many", "file.list"),
      new AbortController().signal,
    ),
  );
});

test("moving or replacing private state invalidates fixed-grant read, list and cached scope", async (t) => {
  for (const replace of [false, true]) {
    const f = fixture(t);
    writeFileSync(
      join(f.privateRoot, "private-sentinel"),
      "private-state-sentinel",
    );
    const scope = f.provider.authorize(f.request("."));
    fs.renameSync(f.privateRoot, join(f.allowed, "private-old"));
    if (replace) mkdirSync(f.privateRoot, { mode: 0o700 });
    await assert.rejects(
      f.provider.run(
        f.request("private-old/private-sentinel"),
        new AbortController().signal,
      ),
    );
    await assert.rejects(
      f.provider.run(
        f.request("private-old", "file.list"),
        new AbortController().signal,
      ),
    );
    assert.throws(() => f.provider.authorizeScope(scope));
    assert.equal(f.provider.capabilities().state, "unknown");
  }
});

test("revoked generations and cancellation reject access, and credentials are removed from results", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.allowed, "content"), f.secret);
  const result = await f.provider.run(
    f.request("content"),
    new AbortController().signal,
  );
  assert.equal(result.stdout, "[REDACTED]");
  await assert.rejects(
    f.provider.run(
      { ...f.request("content"), generation: "old" },
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    f.provider.run(f.request("content"), AbortSignal.abort()),
  );
  f.revoke();
  await assert.rejects(
    f.provider.run(f.request("content"), new AbortController().signal),
  );
});

test("credential-like entry names are omitted before JSON encoding so listing remains parseable", async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.allowed, "API_KEY=redaction-fixture-value"),
    "private name",
  );
  writeFileSync(join(f.allowed, "safe.txt"), "safe");
  const result = await f.provider.run(
    f.request(".", "file.list"),
    new AbortController().signal,
  );
  assert.deepEqual(JSON.parse(result.stdout), [
    { name: "safe.txt", kind: "file" },
  ]);
  assert.equal(result.stdout.includes("redaction-fixture-value"), false);
});

test("listing uses the current file type when an entry becomes a special file after readdir", async (t) => {
  const f = fixture(t);
  const path = join(f.allowed, "replaced");
  writeFileSync(path, "ordinary at readdir");
  const stat = fs.lstatSync;
  let replaced = false;
  t.mock.method(
    fs,
    "lstatSync",
    (value: fs.PathLike, options?: fs.StatOptions & { bigint?: false }) => {
      if (String(value) === path && !replaced) {
        replaced = true;
        fs.unlinkSync(path);
        execFileSync("/usr/bin/mkfifo", [path]);
      }
      return stat(value, options);
    },
  );
  syncBuiltinESMExports();
  try {
    const result = await f.provider.run(
      f.request(".", "file.list"),
      new AbortController().signal,
    );
    assert.equal(replaced, true);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("revocation or abort during real asynchronous IO returns no content", async (t) => {
  for (const kind of ["read", "list"] as const) {
    const f = fixture(t);
    writeFileSync(join(f.allowed, "text"), "must not be exposed");
    const request = f.request(
      kind === "read" ? "text" : ".",
      kind === "read" ? "file.read" : "file.list",
    );
    const work = f.provider.run(request, new AbortController().signal);
    f.revoke();
    await assert.rejects(work, /grant|revoked/i);
  }
  const f = fixture(t);
  writeFileSync(join(f.allowed, "text"), "must not be exposed");
  const controller = new AbortController();
  const work = f.provider.run(f.request("text"), controller.signal);
  controller.abort();
  await assert.rejects(work, { name: "AbortError" });
});

test("exact byte budget succeeds, invalid UTF-8 fails, and replaced root identity is rejected", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.allowed, "limit"), "x".repeat(32 * 1024));
  assert.equal(
    (await f.provider.run(f.request("limit"), new AbortController().signal))
      .stdout.length,
    32 * 1024,
  );
  writeFileSync(join(f.allowed, "invalid"), Buffer.from([0xff]));
  await assert.rejects(
    f.provider.run(f.request("invalid"), new AbortController().signal),
  );
  const work = f.provider.run(f.request("limit"), new AbortController().signal);
  fs.renameSync(f.allowed, `${f.allowed}-old`);
  mkdirSync(f.allowed);
  writeFileSync(join(f.allowed, "limit"), "replacement");
  await assert.rejects(work, /grant|changed/i);
});
