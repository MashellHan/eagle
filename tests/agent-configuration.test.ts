import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OperationJournal } from "../packages/agent/operation-journal.ts";
import {
  prepareIdentity,
  updateConfiguration,
} from "../packages/agent/service.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "eagle-config-repair-")),
  );
  const path = join(root, "agent.json");
  const config = {
    machineId: "repair-mac",
    machineName: "Repair Mac",
    url: "https://ingest.example.test",
    ownerOrigin: "https://owner.example.test",
    token: "isolated-machine-credential-at-least-32-characters",
    execution: { commands: false, workingDirectory: "." },
  };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const patch = {
    machineId: config.machineId,
    url: config.url,
    ownerOrigin: config.ownerOrigin,
    execution: { commands: true, workingDirectory: root },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    path,
    config,
    patch,
    read: () => JSON.parse(readFileSync(path, "utf8")),
  };
}

test("identity remains inspectable for a saved configuration whose working directory needs repair", (t) => {
  const f = fixture(t);
  const { ownerOrigin: _ownerOrigin, ...legacy } = f.config;
  writeFileSync(f.path, JSON.stringify(legacy));
  const identity = prepareIdentity(f.path);
  assert.equal(identity.machineId, f.config.machineId);
  assert.equal(identity.configured, true);
  assert.equal((identity as { ownerOrigin?: string }).ownerOrigin, undefined);
  assert.equal(JSON.stringify(identity).includes(f.config.token), false);
});

test("explicit configuration repair preserves its machine, deployment and credential", (t) => {
  const f = fixture(t);
  updateConfiguration(f.path, f.patch);
  assert.deepEqual(f.read().execution, f.patch.execution);
  assert.equal(f.read().machineId, f.config.machineId);
  assert.equal(f.read().token, f.config.token);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  for (const change of [
    { machineId: "other-mac" },
    { url: "https://foreign.example.test" },
    { ownerOrigin: "https://foreign-owner.example.test" },
    { execution: { commands: true, workingDirectory: "." } },
  ]) {
    const before = readFileSync(f.path, "utf8");
    assert.throws(() => updateConfiguration(f.path, { ...f.patch, ...change }));
    assert.equal(readFileSync(f.path, "utf8"), before);
  }
});

test("repair refuses a live operation journal and never changes running evidence", (t) => {
  const f = fixture(t);
  const journal = new OperationJournal(
    join(f.root, "execution", "operations.sqlite"),
  );
  try {
    journal.begin("active", "a".repeat(64));
    assert.throws(() => updateConfiguration(f.path, f.patch));
    assert.equal(journal.get("active")?.state, "running");
    assert.equal(f.read().execution.workingDirectory, ".");
  } finally {
    journal.close();
  }
  updateConfiguration(f.path, f.patch);
  assert.equal(f.read().execution.workingDirectory, f.root);
});

test("CLI init rejects an invalid directory before persistence and explicit repair accepts only stdin", (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(
    new URL("../packages/agent/cli.ts", import.meta.url),
  );
  const fresh = join(f.root, "fresh", "agent.json");
  const invoke = (path: string, action: string, input: unknown) =>
    spawnSync(process.execPath, [cli, action], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin", EAGLE_CONFIG: path },
    });
  const invalid = invoke(fresh, "init", {
    ...f.config,
    execution: { commands: true, workingDirectory: "." },
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(fresh), false);
  const repaired = invoke(f.path, "reconfigure", f.patch);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(f.read().execution.workingDirectory, f.root);
  assert.equal(
    (repaired.stdout + repaired.stderr).includes(f.config.token),
    false,
  );
});

test("CLI permits a disabled command capability independently of an obsolete command directory", (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(
    new URL("../packages/agent/cli.ts", import.meta.url),
  );
  const fresh = join(f.root, "file-only", "agent.json");
  const result = spawnSync(process.execPath, [cli, "init"], {
    input: JSON.stringify(f.config),
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/bin:/bin", EAGLE_CONFIG: fresh },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(fresh, "utf8")).execution.commands,
    false,
  );
});
