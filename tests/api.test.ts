import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { viewerAuthorized } from "../src/worker/auth.ts";
import { report } from "./fixtures.ts";

let mf: Miniflare;
const token = "test-agent-token-with-at-least-32-characters";
let viewer: string;
let signingKey: CryptoKey;
const issuer = "https://nocoo.cloudflareaccess.com";
const audience =
  "d1ffdb7fe2787e2a9e8f957a68ed5feec2b944c44c6fdbfd54341887eab6f873";
async function accessToken(aud = audience, iss = issuer, expires = "1h") {
  return new SignJWT({ email: "viewer@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject("test-user")
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(signingKey);
}
const currentReport = (id: string, offset = 0) =>
  report(id, new Date(Date.now() + offset).toISOString());
before(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test-key",
    alg: "RS256",
  };
  viewer = await accessToken();
  mkdirSync(".local/test-assets", { recursive: true });
  writeFileSync(
    ".local/test-assets/index.html",
    "<!doctype html><title>API test</title>",
  );
  execFileSync(
    "node_modules/.bin/wrangler",
    [
      "deploy",
      "--dry-run",
      "--outdir",
      ".local/test-worker",
      "--assets",
      ".local/test-assets",
    ],
    { stdio: "pipe" },
  );
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle",
          modules: true,
          scriptPath: ".local/test-worker/index.js",
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          outboundService: async (request) => {
            assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`);
            return Response.json({ keys: [jwk] });
          },
          bindings: {
            AGENT_TOKENS: JSON.stringify({
              "mac-one": token,
              "mac-two": "different-test-token-with-at-least-32-characters",
            }),
            ACCESS_TEAM_URL: issuer,
            ACCESS_AUD: audience,
            LOCAL_DEV: "false",
            BUILD_REVISION: "test-build-sha",
          },
        },
      ],
    }),
  );
  const db = await mf.getD1Database("DB");
  await db.exec(
    readFileSync("migrations/0001_initial.sql", "utf8").replace(/\n/g, " "),
  );
});
after(async () => {
  await mf?.dispose();
});
function request(path: string, body?: unknown, bearer = token) {
  return mf.dispatchFetch(`https://eagle.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(bearer === viewer
        ? { "Cf-Access-Jwt-Assertion": viewer }
        : { Authorization: `Bearer ${bearer}` }),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("fail-closed auth, machine scoping, versions, body limits and no token persistence", async () => {
  assert.equal(
    (await request("/api/v1/reports", currentReport("bad-auth"), "wrong"))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/api/v1/reports", {
        ...currentReport("bad-machine"),
        machine: { ...report().machine, id: "mac-two" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/v1/reports", {
        ...currentReport("bad-version"),
        schemaVersion: 2,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/v1/reports", {
        ...currentReport("bad-secret"),
        token,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/reports", currentReport("future", 600_000))).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/reports", "a".repeat(1_100_000))).status,
    413,
  );
  assert.equal((await request("/api/v1/overview")).status, 401);
  assert.equal((await request("/api/live", undefined, "")).status, 200);
});
test("atomic dedup, content conflicts, concurrent retries and out-of-order current state", async () => {
  const value = currentReport("newest");
  assert.equal((await request("/api/v1/reports", value)).status, 201);
  const retries = await Promise.all(
    Array.from({ length: 4 }, () => request("/api/v1/reports", value)),
  );
  assert(retries.every((r) => r.status === 200));
  assert.equal(
    (await request("/api/v1/reports", { ...value, spaces: [] })).status,
    409,
  );
  assert.equal(
    (await request("/api/v1/reports", currentReport("older", -60_000))).status,
    201,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { report: { reportId: string } }[] };
  assert.equal(overview.machines[0].report.reportId, "newest");
  const db = await mf.getD1Database("DB");
  const stored = await db.prepare("SELECT * FROM reports").all();
  assert.equal(stored.results.length, 2);
  assert(!JSON.stringify(stored).includes(token));
});
test("heartbeats keep known machines alive without rewriting inventory and history is paginated", async () => {
  const beat = {
    schemaVersion: 1,
    machineId: "mac-one",
    sentAt: new Date().toISOString(),
    warning: "collector retry",
  };
  assert.equal((await request("/api/v1/heartbeat", beat)).status, 200);
  const response = await request(
    "/api/v1/history?machine=mac-one&limit=1",
    undefined,
    viewer,
  );
  const page = (await response.json()) as {
    entries: { seq: number; report: { reportId: string } }[];
    nextCursor: number | null;
  };
  assert.equal(page.entries.length, 1);
  assert(page.nextCursor);
  const next = (await (
    await request(
      `/api/v1/history?machine=mac-one&limit=1&before=${page.nextCursor}`,
      undefined,
      viewer,
    )
  ).json()) as { entries: { seq: number }[] };
  assert(next.entries[0].seq < page.entries[0].seq);
  assert.equal(
    (await request("/api/v1/history?limit=-1", undefined, viewer)).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/history?before=oops", undefined, viewer)).status,
    400,
  );
});
test("Access validates signature, issuer, audience and expiry and rejects legacy credentials", async () => {
  const access = (jwt: string, headers: Record<string, string> = {}) =>
    mf.dispatchFetch("https://eagle.test/api/v1/overview", {
      headers: { "Cf-Access-Jwt-Assertion": jwt, ...headers },
    });
  assert.equal((await access(viewer)).status, 200);
  for (const jwt of [
    await accessToken("wrong"),
    await accessToken(audience, "https://attacker.test"),
    await accessToken(audience, issuer, "-1h"),
    `${viewer.slice(0, -8)}tampered`,
    "unsigned",
  ]) {
    assert.equal((await access(jwt)).status, 401);
  }
  assert.equal(
    (
      await mf.dispatchFetch("https://eagle.test/api/v1/overview", {
        headers: {
          Authorization: `Bearer ${viewer}`,
          Cookie: "eagle_session=old-session",
          "Cf-Access-Authenticated-User-Email": "viewer@example.test",
        },
      })
    ).status,
    401,
  );
  assert.equal((await request("/api/session", undefined, viewer)).status, 404);
  const crossOrigin = await mf.dispatchFetch(
    "https://eagle.test/api/v1/reports",
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.test",
        Authorization: `Bearer ${token}`,
      },
    },
  );
  assert.equal(crossOrigin.status, 403);
});

test("local viewing needs no token but a local hostname never bypasses production authentication", async () => {
  const env = {
    ACCESS_TEAM_URL: issuer,
    ACCESS_AUD: audience,
    LOCAL_DEV: "true",
  } as Env;
  assert.equal(
    await viewerAuthorized(
      new Request("https://eagle.dev.hexly.ai/api/v1/overview"),
      env,
    ),
    true,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("http://127.0.0.1:36001/api/v1/overview"),
      env,
    ),
    true,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("https://eagle.hexly.ai/api/v1/overview"),
      env,
    ),
    false,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("https://eagle.dev.hexly.ai/api/v1/overview"),
      { ...env, LOCAL_DEV: "false" },
    ),
    false,
  );
});

test("public health identifies the deployed revision without exposing inventory", async () => {
  const response = await request("/api/live", undefined, "");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(result.status, "ok");
  assert.equal(
    result.version,
    JSON.parse(readFileSync("package.json", "utf8")).version,
  );
  assert.equal(result.revision, "test-build-sha");
  assert(!("machines" in result));
});

test("an ordinary heartbeat and old retry cannot clear a collector failure warning", async () => {
  const beat = {
    schemaVersion: 1,
    machineId: "mac-one",
    sentAt: new Date().toISOString(),
  };
  await request("/api/v1/heartbeat", {
    ...beat,
    warning: "Collection incomplete",
  });
  await request("/api/v1/heartbeat", beat);
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machines: { warning: string; report: ReturnType<typeof report> }[];
  };
  assert.equal(view.machines[0].warning, "Collection incomplete");
  await request("/api/v1/reports", view.machines[0].report);
  const after = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as typeof view;
  assert.equal(after.machines[0].warning, "Collection incomplete");
});

test("two machines may share Herdr IDs without inventory or history collisions", async () => {
  const second = currentReport("second-machine");
  second.machine.id = "mac-two";
  second.machine.name = "Mac Two";
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        second,
        "different-test-token-with-at-least-32-characters",
      )
    ).status,
    201,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machines: { id: string; report: ReturnType<typeof report> }[];
  };
  assert.deepEqual(
    overview.machines.map((m) => m.id),
    ["mac-one", "mac-two"],
  );
  assert.equal(
    overview.machines[0].report.spaces[0].id,
    overview.machines[1].report.spaces[0].id,
  );
  const history = (await (
    await request("/api/v1/history?machine=mac-two", undefined, viewer)
  ).json()) as { entries: { report: ReturnType<typeof report> }[] };
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].report.machine.id, "mac-two");
});

test("the machine ingress exposes only Bearer-protected ingestion and public health", async () => {
  for (const path of [
    "/",
    "/assets/app.js",
    "/api/v1/overview",
    "/api/v1/history",
  ]) {
    const response = await mf.dispatchFetch(
      `https://eagle-ingest.hexly.ai${path}`,
      { headers: { "Cf-Access-Jwt-Assertion": viewer } },
    );
    assert.equal(response.status, 404);
  }
  assert.equal(
    (await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/live")).status,
    200,
  );
  assert.equal(
    (
      await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/v1/reports", {
        method: "POST",
      })
    ).status,
    401,
  );
  const response = await mf.dispatchFetch(
    "https://eagle-ingest.hexly.ai/api/v1/reports",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(currentReport("ingress-test")),
    },
  );
  assert.equal(response.status, 201);
});
