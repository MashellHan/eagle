import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FileGrants } from "../packages/agent/file-grants.ts";
import { FileProvider } from "../packages/agent/file-provider.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eagle-file-grants-")));
  const privateRoot = join(root, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  const config = join(privateRoot, "agent.json");
  writeFileSync(
    config,
    JSON.stringify({
      machineId: "grant-mac",
      machineName: "Grant Mac",
      url: "https://example.test",
      token: "isolated-grant-machine-credential-at-least-32-characters",
    }),
    { mode: 0o600 },
  );
  const allowed = join(root, "documents");
  mkdirSync(allowed);
  writeFileSync(join(allowed, "text"), "actual contents");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, privateRoot, config, allowed, store: new FileGrants(config) };
}

test("local directory consent persists privately and reauthorization creates a new generation", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.list(), []);
  const grant = f.store.grant({ root: f.allowed, name: "Documents" });
  assert.equal(grant.root, f.allowed);
  assert.deepEqual(new FileGrants(f.config).list(), [grant]);
  assert.deepEqual(
    f.store.grant({ root: f.allowed, name: "Documents" }),
    grant,
  );
  assert.equal(
    statSync(join(f.privateRoot, "file-grants.json")).mode & 0o777,
    0o600,
  );
  f.store.revoke(grant.id);
  assert.deepEqual(f.store.list(), []);
  const renewed = f.store.grant({ root: f.allowed, name: "Documents" });
  assert.notEqual(renewed.id, grant.id);
  assert.notEqual(renewed.generation, grant.generation);
  assert.throws(() =>
    f.store.grant({ root: f.privateRoot, name: "Private Agent" }),
  );
});

test("permission-file validation fails closed and no credentials are accepted as labels", (t) => {
  const f = fixture(t);
  const secret = JSON.parse(readFileSync(f.config, "utf8")).token;
  assert.throws(() => f.store.grant({ root: f.allowed, name: secret }));
  f.store.grant({ root: f.allowed, name: "Documents" });
  const file = join(f.privateRoot, "file-grants.json");
  chmodSync(file, 0o644);
  assert.throws(() => f.store.list());
  chmodSync(file, 0o600);
  writeFileSync(file, "invalid JSON");
  assert.throws(() => f.store.grant({ root: f.allowed, name: "Other" }));
  assert.equal(readFileSync(file, "utf8"), "invalid JSON");
});

test("a persisted root's inode change requires fresh consent even for a new operation", async (t) => {
  const f = fixture(t);
  const grant = f.store.grant({ root: f.allowed, name: "Documents" });
  const provider = new FileProvider({
    grants: () => f.store.list(),
    privateRoot: f.privateRoot,
  });
  const request = {
    tool: "file.read" as const,
    grantId: grant.id,
    generation: grant.generation,
    path: "text",
  };
  assert.equal(
    (await provider.run(request, new AbortController().signal)).stdout,
    "actual contents",
  );
  renameSync(f.allowed, join(f.root, "previous-documents"));
  mkdirSync(f.allowed);
  writeFileSync(join(f.allowed, "text"), "new unapproved root");
  await assert.rejects(provider.run(request, new AbortController().signal));
  const renewed = f.store.grant({ root: f.allowed, name: "Documents" });
  assert.notEqual(renewed.id, grant.id);
  assert.notEqual(renewed.generation, grant.generation);
  await assert.rejects(provider.run(request, new AbortController().signal));
});

test("every authority read rejects a directory that is no longer private", async (t) => {
  const f = fixture(t);
  const grant = f.store.grant({ root: f.allowed, name: "Documents" });
  const provider = new FileProvider({
    grants: () => f.store.list(),
    privateRoot: f.privateRoot,
  });
  chmodSync(f.privateRoot, 0o755);
  assert.throws(() => f.store.list(), /0700/);
  await assert.rejects(
    provider.run(
      {
        tool: "file.read",
        grantId: grant.id,
        generation: grant.generation,
        path: "text",
      },
      new AbortController().signal,
    ),
  );
  assert.equal(provider.capabilities().state, "unknown");
});

test("FIFO authority is rejected in a real process without blocking before type validation", (t) => {
  const f = fixture(t);
  const authority = join(f.privateRoot, "file-grants.json");
  assert.equal(spawnSync("/usr/bin/mkfifo", [authority]).status, 0);
  chmodSync(authority, 0o600);
  const source = `import {FileGrants} from ${JSON.stringify(new URL("../packages/agent/file-grants.ts", import.meta.url).href)};
    try { new FileGrants(process.argv[1]).list(); process.exitCode = 2; }
    catch { process.exitCode = 1; }`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, f.config],
    {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 1200,
      killSignal: "SIGKILL",
    },
  );
  assert.equal(
    result.error,
    undefined,
    "authority read must not block on a FIFO",
  );
  assert.equal(result.status, 1);
});

test("the local CLI grants and revokes by stdin, without sending credentials as arguments or output", (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(
    new URL("../packages/agent/cli.ts", import.meta.url),
  );
  const invoke = (action: string, input?: unknown) =>
    spawnSync(process.execPath, [cli, "files", action], {
      env: { PATH: "/usr/bin:/bin", EAGLE_CONFIG: f.config },
      input: input === undefined ? undefined : JSON.stringify(input),
      encoding: "utf8",
      timeout: 5000,
    });
  const created = invoke("grant", { root: f.allowed, name: "Documents" });
  assert.equal(created.status, 0, created.stderr);
  const grant = JSON.parse(created.stdout).grant;
  assert.equal(JSON.parse(invoke("list").stdout).grants[0].id, grant.id);
  assert.equal(invoke("revoke", { id: grant.id }).status, 0);
  assert.deepEqual(JSON.parse(invoke("list").stdout).grants, []);
  const secret = JSON.parse(readFileSync(f.config, "utf8")).token;
  const refused = invoke("grant", {
    root: join(f.root, secret),
    name: "Invalid",
  });
  assert.equal(refused.status, 1);
  assert.equal(
    (
      created.stdout +
      created.stderr +
      refused.stdout +
      refused.stderr
    ).includes(secret),
    false,
  );
});
