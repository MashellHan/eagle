// Provider keys (docs/bots/PROTOCOL.md, "Providers"): the catalogue is code, the secret lives
// in the user's own config with 0600, and the public shape only says whether a key is set.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROVIDERS,
  providerDefinition,
  publicProviders,
  readProviders,
  writeProviders,
} from "../../src/server/providers.ts";

test("a saved key is stored 0600 and never comes back out", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-providers-"));
  const path = join(root, "config", "eagle-bots", "providers.json");
  try {
    await writeProviders({ "deepseek-search": { apiKey: "sk-secret", enabled: true } }, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const raw = await readFile(path, "utf8");
    assert.match(raw, /sk-secret/, "the daemon owns the file; the API redacts it");
    const shown = publicProviders(await readProviders(path));
    assert.equal(shown[0]?.id, "deepseek-search");
    assert.equal(shown[0]?.title, "DeepSeek");
    assert.equal(shown[0]?.hasApiKey, true);
    assert.equal(shown[0]?.enabled, true);
    assert.equal(JSON.stringify(shown).includes("sk-secret"), false, "the key stays in the file");
    assert.equal(shown[0]?.docsUrl, "https://api-docs.deepseek.com/guides/search/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an absent or malformed file is nothing configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-providers-"));
  const path = join(root, "providers.json");
  try {
    assert.deepEqual(await readProviders(path), {});
    await writeProviders({}, path);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ half");
    assert.deepEqual(await readProviders(path), {});
    await writeFile(path, JSON.stringify({ version: 1, providers: { x: { enabled: true } } }));
    assert.deepEqual(await readProviders(path), {}, "a config without a key is not a provider");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the search catalogue has two providers with independent unselected keys", () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.id),
    ["deepseek-search", "tavily-search"],
  );
  assert.equal(providerDefinition("deepseek-search")?.kind, "deepseek-search");
  assert.equal(providerDefinition("nope"), undefined);
  assert.deepEqual(
    publicProviders({}).map((provider) => [provider.hasApiKey, provider.enabled]),
    [
      [false, false],
      [false, false],
    ],
    "an unconfigured provider is neither set nor enabled",
  );
});
