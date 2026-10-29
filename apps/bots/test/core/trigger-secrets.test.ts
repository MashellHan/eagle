// Webhook credentials (docs/bots/TRIGGERS.md §9.2): one token per trigger, persisted 0600,
// compared in constant time, and never confused with another trigger's.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TriggerSecretStore, triggerSecretsPath } from "../../src/core/TriggerSecrets.ts";

const withDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "bots-secrets-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("a token is generated once, persisted, and survives a reopen", async () => {
  await withDir(async (dir) => {
    const path = triggerSecretsPath(join(dir, "bot"));
    const store = await TriggerSecretStore.open(path);
    assert.equal(store.matches("t_aaaaaaaaaa", ""), false, "an unknown trigger never matches");
    const token = await store.tokenFor("t_aaaaaaaaaa");
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/, "32 random bytes, URL-safe");
    assert.equal(await store.tokenFor("t_aaaaaaaaaa"), token, "one token per trigger");

    const reopened = await TriggerSecretStore.open(path);
    assert.equal(reopened.matches("t_aaaaaaaaaa", token), true);
    assert.equal(reopened.matches("t_aaaaaaaaaa", `${token}x`), false);
    assert.equal(reopened.matches("t_bbbbbbbbbb", token), false, "tokens are not shared");
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600, "the file holds a credential");
  });
});

test("forget removes one token and leaves the others", async () => {
  await withDir(async (dir) => {
    const path = triggerSecretsPath(join(dir, "bot"));
    const store = await TriggerSecretStore.open(path);
    const first = await store.tokenFor("t_aaaaaaaaaa");
    const second = await store.tokenFor("t_bbbbbbbbbb");
    await store.forget("t_aaaaaaaaaa");
    assert.equal(store.matches("t_aaaaaaaaaa", first), false);
    assert.equal(store.matches("t_bbbbbbbbbb", second), true);
    assert.deepEqual(store.tokens().length, 1);
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(path, "utf8"))),
      ["t_bbbbbbbbbb"],
      "the file follows memory",
    );
  });
});

test("a corrupt file is replaced on the next write instead of crashing", async () => {
  await withDir(async (dir) => {
    const path = triggerSecretsPath(join(dir, "bot"));
    await mkdir(join(dir, "bot"), { recursive: true });
    await writeFile(path, "{not json", { mode: 0o600 });
    const store = await TriggerSecretStore.open(path);
    assert.deepEqual(store.tokens(), []);
    const token = await store.tokenFor("t_aaaaaaaaaa");
    const reopened = await TriggerSecretStore.open(path);
    assert.equal(reopened.matches("t_aaaaaaaaaa", token), true);
  });
});
