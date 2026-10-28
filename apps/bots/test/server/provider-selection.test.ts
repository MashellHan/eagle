import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderService } from "../../src/main.ts";
import { readProviders, writeProviders } from "../../src/server/providers.ts";

test("keys save independently; selection is exclusive, durable and never implicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-selection-"));
  const path = join(root, "providers.json");
  try {
    const service = await createProviderService({ path });
    assert.ok((await service.save("tavily-search", { enabled: true })).error);
    await Promise.all([
      service.save("deepseek-search", { apiKey: "ds-fixture" }),
      service.save("tavily-search", { apiKey: "tvly-fixture" }),
    ]);
    assert.deepEqual(
      service.public().map((p) => [p.hasApiKey, p.enabled]),
      [
        [true, false],
        [true, false],
      ],
    );
    await service.save("deepseek-search", { enabled: true });
    await service.save("tavily-search", { apiKey: "tvly-updated" });
    assert.equal(service.public().find((p) => p.enabled)?.id, "deepseek-search");
    await service.save("tavily-search", { enabled: true });
    assert.deepEqual(
      service.public().map((p) => p.enabled),
      [false, true],
    );
    assert.equal((await readProviders(path))["deepseek-search"]?.apiKey, "ds-fixture");
    const reopened = await createProviderService({ path });
    assert.deepEqual(reopened.public(), service.public());
    await service.save("tavily-search", { enabled: false });
    assert.equal(
      service.public().some((p) => p.enabled),
      false,
    );
    assert.ok((await service.save("unknown", { apiKey: "x" })).error);
    assert.ok((await service.save("deepseek-search", { apiKey: " " })).error);
    assert.doesNotMatch(JSON.stringify(service.public()), /fixture|updated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same routing client follows saved selection and key changes with no fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-route-"));
  const requests: string[] = [];
  let refuse = false;
  try {
    const service = await createProviderService({
      path: join(root, "providers.json"),
      fetch: async (url, init) => {
        requests.push(
          `${new URL(String(url)).host}:${new Headers(init?.headers).get("authorization")}`,
        );
        if (refuse) return new Response("upstream secret", { status: 401 });
        return Response.json({ results: [] });
      },
    });
    const client = service.client;
    await assert.rejects(client.search({ query: "x" }), /选择.*搜索/);
    assert.deepEqual(requests, []);
    await service.save("deepseek-search", { apiKey: "ds-1", enabled: true });
    await client.search({ query: "x" });
    await service.save("tavily-search", { apiKey: "tvly-1", enabled: true });
    await client.search({ query: "x" });
    await service.save("tavily-search", { apiKey: "tvly-2" });
    await client.search({ query: "x" });
    refuse = true;
    await assert.rejects(client.search({ query: "x" }), /refused the API key/);
    assert.deepEqual(requests, [
      "api.deepseek.com:Bearer ds-1",
      "api.tavily.com:Bearer tvly-1",
      "api.tavily.com:Bearer tvly-2",
      "api.tavily.com:Bearer tvly-2",
    ]);
    assert.equal((await service.test("deepseek-search")).ok, false);
    assert.equal(service.public().find((p) => p.enabled)?.id, "tavily-search");
    assert.equal((await service.test("unknown")).ok, false);
    refuse = false;
    assert.equal((await service.test("deepseek-search")).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed persistence keeps the old route and a later queued save still succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-write-"));
  const path = join(root, "providers.json");
  try {
    const service = await createProviderService({ path });
    await service.save("deepseek-search", { apiKey: "ds", enabled: true });
    await mkdir(`${path}.${process.pid}.tmp`);
    await assert.rejects(service.save("tavily-search", { apiKey: "tv", enabled: true }));
    assert.equal(service.public().find((p) => p.enabled)?.id, "deepseek-search");
    assert.equal((await readProviders(path))["tavily-search"], undefined);
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    await service.save("tavily-search", { apiKey: "tv", enabled: true });
    assert.equal(service.public().find((p) => p.enabled)?.id, "tavily-search");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous stored selections never choose by catalogue order", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-ambiguous-"));
  const path = join(root, "providers.json");
  try {
    await writeProviders(
      {
        "deepseek-search": { apiKey: "ds", enabled: true },
        "tavily-search": { apiKey: "tv", enabled: true },
      },
      path,
    );
    const service = await createProviderService({
      path,
      fetch: async () => {
        throw new Error("must not call");
      },
    });
    await assert.rejects(service.client.search({ query: "x" }), /选择.*搜索/);
    assert.equal(
      service.public().some((p) => p.enabled),
      false,
    );
    await service.save("tavily-search", { enabled: true });
    assert.equal(service.public().find((p) => p.enabled)?.id, "tavily-search");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing selection does not retarget a request that already started", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-inflight-"));
  const pending = Promise.withResolvers<Response>();
  const seen: string[] = [];
  try {
    const service = await createProviderService({
      path: join(root, "providers.json"),
      fetch: async (url, init) => {
        seen.push(
          `${new URL(String(url)).host}:${new Headers(init?.headers).get("authorization")}`,
        );
        return seen.length === 1 ? pending.promise : Response.json({ results: [] });
      },
    });
    await service.save("deepseek-search", { apiKey: "old-key", enabled: true });
    const first = service.client.search({ query: "before" });
    await service.save("tavily-search", { apiKey: "new-key", enabled: true });
    pending.resolve(Response.json({ results: [] }));
    await first;
    await service.client.search({ query: "after" });
    assert.deepEqual(seen, ["api.deepseek.com:Bearer old-key", "api.tavily.com:Bearer new-key"]);
  } finally {
    pending.resolve(Response.json({ results: [] }));
    await rm(root, { recursive: true, force: true });
  }
});
