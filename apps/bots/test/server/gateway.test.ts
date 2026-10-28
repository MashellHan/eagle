// The gateway settings store and its connection probe (docs/bots/PROTOCOL.md, "Gateway
// settings"): one file beside the token, a key that never comes back out, and a probe that
// distinguishes a refused key from an unreachable gateway.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewayConfig } from "../../src/server/gateway.ts";
import {
  gatewayFromEnv,
  listGatewayModels,
  normalizeBaseUrl,
  publicGateway,
  readGateway,
  testGateway,
  writeGateway,
} from "../../src/server/gateway.ts";

const bench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-gateway-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("settings round-trip, stay 0600 and never expose the key", async () => {
  const bench_ = await bench();
  try {
    assert.equal(await readGateway(bench_.root), undefined);
    const config: GatewayConfig = {
      provider: "magpie",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "auto/gpt-6-astra",
      apiKey: "sk-secret-0123456789",
      thinkingLevel: "medium",
      toolGroups: ["core", "coding", "herdr", "agents"],
    };
    await writeGateway(bench_.root, config);
    assert.deepEqual(await readGateway(bench_.root), config);
    assert.equal((await stat(join(bench_.root, "gateway.json"))).mode & 0o777, 0o600);
    const raw = await readFile(join(bench_.root, "gateway.json"), "utf8");
    assert.match(raw, /sk-secret/, "the daemon owns the file; the API redacts it");
    const shown = publicGateway(config);
    assert.deepEqual(shown, {
      configured: true,
      provider: "magpie",
      thinkingLevel: "medium",
      toolGroups: ["core", "coding", "herdr", "agents"],
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "auto/gpt-6-astra",
      hasApiKey: true,
    });
    assert.equal(JSON.stringify(shown).includes("sk-secret"), false);
  } finally {
    await bench_.cleanup();
  }
});

test("dotenv values are the fallback, and a broken file is not configured", async () => {
  assert.deepEqual(
    gatewayFromEnv({
      BOTS_BASE_URL: " http://x/v1 ",
      BOTS_API_KEY: " k ",
      BOTS_MODEL: " m ",
      BOTS_PROVIDER: "",
    }),
    {
      provider: "magpie",
      baseUrl: "http://x/v1",
      model: "m",
      apiKey: "k",
      thinkingLevel: "medium",
      toolGroups: ["core", "coding", "herdr", "agents"],
    },
  );
  const env = { BOTS_BASE_URL: "http://x/v1", BOTS_API_KEY: "k", BOTS_MODEL: "m" };
  assert.equal(gatewayFromEnv({ ...env, BOTS_THINKING_LEVEL: "xhigh" })?.thinkingLevel, "xhigh");
  assert.equal(gatewayFromEnv({ ...env, BOTS_THINKING_LEVEL: "loud" })?.thinkingLevel, "medium");
  assert.equal(gatewayFromEnv({ BOTS_BASE_URL: "http://x" }), undefined);
  const bench_ = await bench();
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(bench_.root, "gateway.json"), "{ half");
    assert.equal(await readGateway(bench_.root), undefined);
    assert.equal(publicGateway(undefined).configured, false);
  } finally {
    await bench_.cleanup();
  }
});

test("a gateway URL must be http(s), without a trailing slash", () => {
  assert.equal(normalizeBaseUrl(" http://127.0.0.1:3425/v1/ "), "http://127.0.0.1:3425/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("file:///etc/passwd"), undefined);
  assert.equal(normalizeBaseUrl("not a url"), undefined);
});

test("the probe reports reachability, auth and model count", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer good") {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const ok = await testGateway({
      provider: "magpie",
      baseUrl,
      model: "m",
      apiKey: "good",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.models, 2);
    assert.match(ok.message, /2 个模型/);

    const refused = await testGateway({
      provider: "magpie",
      baseUrl,
      model: "m",
      apiKey: "bad",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 401);
    assert.match(refused.message, /API Key/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the gateway's model list is read for a per-bot picker and never throws", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer key") {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ id: "auto/gpt-6-luna" }, { id: "auto/gpt-6-sol" }, {}] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    assert.deepEqual(await listGatewayModels({ baseUrl, apiKey: "key" }), [
      "auto/gpt-6-luna",
      "auto/gpt-6-sol",
    ]);
    assert.deepEqual(
      await listGatewayModels({ baseUrl, apiKey: "wrong" }),
      [],
      "a 401 lists nothing",
    );
    assert.deepEqual(
      await listGatewayModels({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "key" }),
      [],
      "an unreachable gateway lists nothing",
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
