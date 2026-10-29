import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import WebSocket from "ws";
import {
  containsCredential,
  viewerIdentity,
} from "../apps/web/src/worker/auth.ts";
import { report } from "./fixtures.ts";

const owner = "isolated-native-owner-secret-at-least-32-characters";
const agent = "isolated-native-machine-secret-at-least-32-characters";
const issuer = "https://native-access.example.test";
const audience = "isolated-native-audience";
const storage = mkdtempSync(join(tmpdir(), "eagle-native-auth-"));
let mf: Miniflare;
let access: string;
const sockets = new Set<WebSocket>();

before(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "native-test",
    alg: "RS256",
  };
  access = await new SignJWT({ email: "owner@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "native-test" })
    .setSubject("native-test-owner")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const assets = join(storage, "assets");
  mkdirSync(assets);
  writeFileSync(
    join(assets, "index.html"),
    "<!doctype html><title>Native auth fixture</title>",
  );
  const worker = join(storage, "worker");
  // Use the production bundler's nodejs_compat shims with a fixture-owned output.
  execFileSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "deploy",
      "--dry-run",
      "--config",
      "apps/web/wrangler.jsonc",
      "--outdir",
      worker,
      "--assets",
      assets,
    ],
    { stdio: "pipe", timeout: 120_000 },
  );
  const scriptPath = join(worker, "index.js");
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle-native-auth",
          modules: true,
          modulesRoot: worker,
          scriptPath,
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          durableObjects: {
            MACHINES: { className: "MachineState", useSQLite: true },
            DIRECTORY: { className: "MachineDirectory", useSQLite: true },
          },
          bindings: {
            OWNER_TOKEN: owner,
            AGENT_SIGNING_KEY:
              "isolated-native-signing-key-at-least-32-characters",
            AGENT_TOKENS: JSON.stringify({ "mac-one": agent }),
            ACCESS_TEAM_URL: issuer,
            ACCESS_AUD: audience,
            LOCAL_DEV: "false",
          },
          outboundService: async (request) => {
            assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`);
            return Response.json({ keys: [jwk] });
          },
        },
      ],
    }),
    resourcePersistencePath: storage,
    isolatedResourcePersistencePath: storage,
  });
  await mf.ready;
  const seeded = await mf.dispatchFetch(
    "https://eagle-ingest.hexly.ai/api/v1/reports",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(report("native-auth-seed")),
    },
  );
  assert.equal(seeded.status, 201);
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  await mf?.dispose();
  rmSync(storage, { recursive: true, force: true });
});

async function websocket(headers: Record<string, string>) {
  const url = new URL(
    "/api/v1/realtime?machine=mac-one&space=default%3Aw1",
    await mf.ready,
  );
  url.protocol = "ws:";
  return new Promise<{ status: number; socket?: WebSocket }>(
    (resolveResult, reject) => {
      const socket = new WebSocket(url, { headers, handshakeTimeout: 3000 });
      sockets.add(socket);
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        sockets.delete(socket);
        socket.terminate();
        resolveResult({ status: response.statusCode ?? 0 });
      });
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "ping" }));
        resolveResult({ status: 101, socket });
      });
    },
  );
}

test("native owner identity is distinct from machine credentials and missing configuration", async () => {
  const env = {
    OWNER_TOKEN: owner,
    AGENT_TOKENS: JSON.stringify({ "mac-one": agent }),
  } as Env;
  const request = (token: string) =>
    new Request("https://eagle.test/api/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
  assert.deepEqual(await viewerIdentity(request(owner), env), {
    email: "",
    name: "部署所有者",
    avatar: null,
    local: false,
  });
  for (const token of ["wrong", agent])
    assert.equal(await viewerIdentity(request(token), env), null);
  assert.equal(
    await viewerIdentity(request(owner), { ...env, OWNER_TOKEN: undefined }),
    null,
  );
  assert.equal(
    await viewerIdentity(
      new Request("http://eagle.test/api/v1/me", {
        headers: { Authorization: `Bearer ${owner}` },
      }),
      env,
    ),
    null,
  );
});

test("native owner reaches real machine APIs while ingestion stays restricted", async () => {
  const url = "https://eagle.test/api/v1/machines";
  const response = await mf.dispatchFetch(url, {
    headers: { Authorization: `Bearer ${owner}` },
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { machines: { id: string }[] };
  assert.deepEqual(
    result.machines.map((machine) => machine.id),
    ["mac-one"],
  );
  for (const headers of [{}, { Authorization: `Bearer ${agent}` }])
    assert.equal((await mf.dispatchFetch(url, { headers })).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/v1/machines", {
        headers: { Authorization: `Bearer ${owner}` },
      })
    ).status,
    404,
  );
});

test("an explicit invalid owner credential cannot fall back to a valid Access JWT", async () => {
  const response = await mf.dispatchFetch(
    "https://eagle.test/api/v1/machines",
    {
      headers: {
        Authorization: "Bearer wrong",
        "Cf-Access-Jwt-Assertion": access,
      },
    },
  );
  assert.equal(response.status, 401);
});

test("a real native websocket connects without Origin or Access JWT", async () => {
  const result = await websocket({ Authorization: `Bearer ${owner}` });
  assert.equal(result.status, 101);
  assert(result.socket);
  result.socket.close();
  assert.equal(
    (await websocket({ Authorization: `Bearer ${agent}` })).status,
    401,
  );
  assert.equal(
    (
      await websocket({
        Authorization: `Bearer ${owner}`,
        Origin: "https://other.test",
      })
    ).status,
    403,
  );
});

test("browser Access websocket still requires an exact Origin", async () => {
  const base =
    "https://eagle.test/api/v1/realtime?machine=mac-one&space=default%3Aw1";
  for (const origin of [undefined, "https://other.test"]) {
    const response = await mf.dispatchFetch(base, {
      headers: {
        Upgrade: "websocket",
        "Cf-Access-Jwt-Assertion": access,
        ...(origin ? { Origin: origin } : {}),
      },
    });
    assert.equal(response.status, 403);
  }
});

test("owner secrets are rejected in reports and machine names", async () => {
  assert.equal(
    containsCredential(`value:${owner}`, { OWNER_TOKEN: owner } as Env),
    true,
  );
  const response = await mf.dispatchFetch(
    "https://eagle.test/api/v1/machines/mac-one/rename",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: owner }),
    },
  );
  assert.equal(response.status, 400);
});
