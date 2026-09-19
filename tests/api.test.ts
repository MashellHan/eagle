import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { viewerAuthorized } from "../src/worker/auth.ts";
import { report, telemetry } from "./fixtures.ts";

let mf: Miniflare;
let options: ReturnType<typeof convertV4MiniflareOptions>;
const token = "test-agent-token-with-at-least-32-characters";
let viewer: string;
let signingKey: CryptoKey;
let profileAvailable = true;
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
  options = convertV4MiniflareOptions({
    workers: [
      {
        name: "eagle",
        modules: true,
        scriptPath: ".local/test-worker/index.js",
        compatibilityDate: "2026-09-19",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        durableObjects: {
          MACHINES: { className: "MachineState", useSQLite: true },
          DIRECTORY: { className: "MachineDirectory", useSQLite: true },
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.origin === "https://lizheng.blog") {
            assert.equal(url.pathname, "/api/authors/profile");
            assert.equal(
              url.searchParams.get("hash"),
              createHash("sha256").update("viewer@example.test").digest("hex"),
            );
            assert.equal(request.headers.get("authorization"), null);
            assert.equal(request.headers.get("cf-access-jwt-assertion"), null);
            return profileAvailable
              ? Response.json({
                  name: "Li Zheng",
                  avatar: "https://images.example.test/avatar.png",
                })
              : new Response("Unavailable", { status: 503 });
          }
          assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`);
          return Response.json({ keys: [jwk] });
        },
        bindings: {
          AGENT_SIGNING_KEY: "test-signing-key-at-least-32-characters-long",
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
  });
  options = { ...options, unsafeInspectDurableObjects: true };
  mf = new Miniflare(options);
  const db = await mf.getD1Database("DB");
  await db.exec(
    readFileSync("migrations/0001_initial.sql", "utf8").replace(/\n/g, " "),
  );
  await db.exec(
    readFileSync("migrations/0002_pane_summaries.sql", "utf8").replace(
      /\n/g,
      " ",
    ),
  );
  const legacy = report("legacy-import");
  legacy.machine.id = "retired";
  await db
    .prepare(
      "INSERT INTO reports(machine_id, report_id, captured_at, received_at, digest, payload) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "retired",
      legacy.reportId,
      legacy.capturedAt,
      legacy.capturedAt,
      "legacy-digest",
      JSON.stringify(legacy),
    )
    .run();
});
test("viewer profile uses verified Access email and hashed avatar service with a safe fallback", async () => {
  assert.equal((await request("/api/v1/me", undefined, "")).status, 401);
  const response = await mf.dispatchFetch("https://eagle.test/api/v1/me", {
    headers: {
      "Cf-Access-Jwt-Assertion": viewer,
      "Cf-Access-Authenticated-User-Email": "forged@example.test",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    email: "viewer@example.test",
    name: "Li Zheng",
    avatar: "https://images.example.test/avatar.png",
    local: false,
  });
  profileAvailable = false;
  try {
    const fallback = await request("/api/v1/me", undefined, viewer);
    assert.equal(fallback.status, 200);
    assert.deepEqual(await fallback.json(), {
      email: "viewer@example.test",
      name: "viewer",
      avatar: null,
      local: false,
    });
  } finally {
    profileAvailable = true;
  }
  assert.equal(
    (
      await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/v1/me", {
        headers: { "Cf-Access-Jwt-Assertion": viewer },
      })
    ).status,
    404,
  );
});
after(async () => {
  await mf?.dispose();
});

test("uploads update current state without writing a D1 report", async () => {
  assert.equal(
    (
      await request(
        "/api/v1/heartbeat",
        {
          schemaVersion: 1,
          machineId: "mac-two",
          sentAt: new Date().toISOString(),
        },
        "different-test-token-with-at-least-32-characters",
      )
    ).status,
    409,
  );
  const value = currentReport("do-only", -20000);
  assert.equal((await request("/api/v1/reports", value)).status, 201);
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM reports").first("n"),
    1,
  );
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { report: typeof value }[] };
  assert.equal(view.machines[0].report.reportId, value.reportId);
});

test("telemetry and current state survive DO eviction without a D1 write", async () => {
  const value = currentReport("telemetry", -10000);
  const snapshot = telemetry(value.capturedAt);
  const payload = {
    ...value,
    machine: { ...value.machine, telemetry: snapshot },
  };
  assert.equal(
    (await request("/api/v1/reports", payload, "wrong")).status,
    401,
  );
  assert.equal((await request("/api/v1/reports", payload)).status, 201);
  const duplicate = await request("/api/v1/reports", payload);
  assert.equal(duplicate.status, 200);
  assert.equal(
    ((await duplicate.json()) as { duplicate: boolean }).duplicate,
    true,
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machines: { report: typeof payload; revision: number }[];
    pendingMachines: string[];
  };
  assert.deepEqual(view.machines[0].report.machine.telemetry, snapshot);
  assert(view.machines[0].revision > 0);
  assert.deepEqual(view.pendingMachines, ["mac-two"]);
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE machine_id = 'mac-one'")
      .first("n"),
    0,
  );
  assert.equal((await request("/api/v1/reports", payload)).status, 200);
  assert.equal(
    (await request("/api/v1/reports", { ...payload, spaces: [] })).status,
    409,
  );
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
  assert.equal(stored.results.length, 1);
  assert.equal(stored.results[0].machine_id, "retired");
  assert(!JSON.stringify(stored).includes(token));
});
test("heartbeats keep known machines alive without rewriting inventory; legacy history stays queryable", async () => {
  const beat = {
    schemaVersion: 1,
    machineId: "mac-one",
    sentAt: new Date().toISOString(),
    warning: "collector retry",
  };
  assert.equal((await request("/api/v1/heartbeat", beat)).status, 200);
  const response = await request(
    "/api/v1/history?machine=retired&limit=1",
    undefined,
    viewer,
  );
  const page = (await response.json()) as {
    entries: { report: { reportId: string } }[];
    nextCursor: number | null;
  };
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].report.reportId, "legacy-import");
  assert.equal(page.nextCursor, null);
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
      new Request("http://127.0.0.1:37053/api/v1/overview"),
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
  assert.equal(result.stateStore, "durable-objects");
  assert.equal(result.historyWrites, false);
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
  assert.equal(history.entries.length, 0);
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

test("concurrent first delivery shares one receipt; complete replacement removes closed Spaces and clears warnings", async () => {
  const value = currentReport("replace-current", 2000);
  value.spaces = [];
  const receipts = await Promise.all(
    Array.from({ length: 4 }, () => request("/api/v1/reports", value)),
  );
  assert.deepEqual(receipts.map((r) => r.status).sort(), [200, 200, 200, 201]);
  const acks = (await Promise.all(receipts.map((r) => r.json()))) as {
    seq: number;
  }[];
  assert.equal(new Set(acks.map((a) => a.seq)).size, 1);
  const read = async () =>
    (await (await request("/api/v1/overview", undefined, viewer)).json()) as {
      machines: {
        id: string;
        report: typeof value;
        warning: string | null;
        changedAt: string;
        changes: string[];
        revision: number;
      }[];
    };
  const current = (await read()).machines[0];
  assert.equal(current.warning, null);
  assert.deepEqual(current.report.spaces, []);
  assert(current.changes.some((change) => change.includes("已关闭")));
  const reordered = {
    ...value,
    machine: Object.fromEntries(Object.entries(value.machine).reverse()),
  };
  const duplicate = await request("/api/v1/reports", reordered);
  assert.equal(duplicate.status, 200);
  assert.equal(((await duplicate.json()) as { seq: number }).seq, acks[0].seq);
  const beforeConflict = (await read()).machines[0];
  assert.equal(
    (await request("/api/v1/reports", { ...value, warnings: ["changed body"] }))
      .status,
    409,
  );
  assert.deepEqual((await read()).machines[0], beforeConflict);
  await request("/api/v1/reports", {
    ...value,
    reportId: "same-inventory",
    capturedAt: new Date(Date.parse(value.capturedAt) + 1000).toISOString(),
  });
  const after = (await read()).machines[0];
  assert.equal(after.changedAt, current.changedAt);
  assert.deepEqual(after.changes, current.changes);
  assert(after.revision > current.revision);
});

test("Connect creates scoped credentials, rotates and revokes them without persisting tokens", async () => {
  assert.equal((await request("/api/v1/machines", undefined, "")).status, 401);
  assert.equal(
    (
      await request(
        "/api/v1/machines",
        { id: "connected", name: "New Mac" },
        token,
      )
    ).status,
    401,
  );
  const created = await request(
    "/api/v1/machines",
    {
      id: "connected",
      name: "New Mac",
      watchPorts: [{ name: "Raven", port: 7024 }],
    },
    viewer,
  );
  assert.equal(created.status, 201);
  const first = (await created.json()) as {
    token: string;
    machine: { id: string; credentialId: string };
  };
  assert(first.token.startsWith("eag1."));
  assert.equal(
    (
      await request(
        "/api/v1/machines",
        { id: "connected", name: "Duplicate" },
        viewer,
      )
    ).status,
    409,
  );
  const value = currentReport("connect-first");
  value.machine.id = "connected";
  assert.equal(
    (await request("/api/v1/reports", value, first.token)).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        currentReport("cross-machine"),
        first.token,
      )
    ).status,
    403,
  );
  const leaked = structuredClone(value);
  leaked.reportId = "credential-leak";
  leaked.warnings = [first.token];
  assert.equal(
    (await request("/api/v1/reports", leaked, first.token)).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/reports", value, `${first.token}x`)).status,
    401,
  );
  const list = await (
    await request("/api/v1/machines", undefined, viewer)
  ).text();
  assert(!list.includes(first.token));
  assert(list.includes('"name":"New Mac"'));
  const rotated = await request(
    "/api/v1/machines/connected/rotate",
    {},
    viewer,
  );
  assert.equal(rotated.status, 200);
  const second = (await rotated.json()) as { token: string };
  assert.notEqual(second.token, first.token);
  assert.equal(
    (await request("/api/v1/reports", value, first.token)).status,
    401,
  );
  assert.equal(
    (await request("/api/v1/reports", value, second.token)).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/v1/machines/connected/rename",
        { name: "Renamed Mac" },
        viewer,
      )
    ).status,
    200,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { id: string; name: string }[] };
  assert.equal(
    overview.machines.find((m) => m.id === "connected")?.name,
    "Renamed Mac",
  );
  assert.equal(
    (await request("/api/v1/machines/connected/revoke", {}, viewer)).status,
    200,
  );
  assert.equal(
    (await request("/api/v1/reports", value, second.token)).status,
    401,
  );
  const after = (await (
    await request("/api/v1/machines", undefined, viewer)
  ).json()) as { machines: { id: string; enabled: boolean }[] };
  assert.equal(
    after.machines.find((m) => m.id === "connected")?.enabled,
    false,
  );
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM reports WHERE machine_id = 'connected'",
      )
      .first("n"),
    0,
  );
});

test("Connect mutations reject cross-origin requests and can revoke legacy machine tokens", async () => {
  assert.equal(
    (await request("/api/v1/machines/mac-two/rotate", {}, viewer)).status,
    200,
  );
  assert("workers" in options);
  await mf.setOptions({
    ...options,
    workers: options.workers.map((worker) => ({
      ...worker,
      config: {
        ...worker.config,
        env: {
          ...worker.config.env,
          AGENT_TOKENS: {
            type: "text",
            value: JSON.stringify({ "mac-one": token }),
          },
        },
      },
    })),
  });
  const listing = (await (
    await request("/api/v1/machines", undefined, viewer)
  ).json()) as { machines: { id: string }[] };
  assert(
    listing.machines.some((machine) => machine.id === "mac-two"),
    "Migrated legacy identity must remain discoverable after removing its legacy secret",
  );
  const csrf = await mf.dispatchFetch("https://eagle.test/api/v1/machines", {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": viewer,
      Origin: "https://evil.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: "csrf", name: "CSRF" }),
  });
  assert.equal(csrf.status, 403);
  assert.equal(
    (await request("/api/v1/machines", { id: "bad/id", name: "Bad" }, viewer))
      .status,
    400,
  );
  assert.equal(
    (await request("/api/v1/machines/mac-two/revoke", {}, viewer)).status,
    200,
  );
  const value = currentReport("revoked-legacy");
  value.machine.id = "mac-two";
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        value,
        "different-test-token-with-at-least-32-characters",
      )
    ).status,
    401,
  );
});

test("credentials embedded in reports are rejected; missing legacy tables cannot break live ingestion or viewing", async () => {
  const value = currentReport("secret-in-evidence");
  value.warnings = [token];
  assert.equal((await request("/api/v1/reports", value)).status, 400);
  const db = await mf.getD1Database("DB");
  await db.exec("DROP TABLE machines; DROP TABLE reports;");
  assert.equal(
    (await request("/api/v1/reports", currentReport("archive-outage", 1000)))
      .status,
    201,
  );
  assert.equal(
    (await request("/api/v1/overview", undefined, viewer)).status,
    200,
  );
  assert.equal((await request("/api/live", undefined, "")).status, 200);
  assert.equal(
    (await request("/api/v1/history", undefined, viewer)).status,
    503,
  );
});

test("semantic summaries bind current tasks and facts, dedupe changes, preserve history, and reject fabricated evidence", async () => {
  const { evidenceKeys } = await import("../src/shared/summaries.ts");
  const current = currentReport("semantic-base", 10000);
  const pane = current.spaces[0].tabs[0].panes[0];
  pane.evidence = [
    {
      kind: "git",
      status: "success",
      source: "git:HEAD+status",
      observedAt: current.capturedAt,
      taskId: pane.task.id,
      revision: "a".repeat(40),
      summary: "main clean",
    },
  ];
  assert.equal((await request("/api/v1/reports", current)).status, 201);
  const basis = Object.keys(await evidenceKeys(pane.evidence));
  const entry = {
    spaceId: current.spaces[0].id,
    paneId: pane.id,
    taskId: pane.task.id,
    basis,
    observedAt: new Date().toISOString(),
    summary: {
      task: "实现实时总结",
      phase: "verify",
      progress: "正在核对实际数据",
      outcomes: [{ kind: "commit", text: "main 已提交", evidenceRefs: basis }],
      blocker: null,
      nextStep: "生产验收",
      rationale: "Git 可见，测试与部署待核对",
      evidenceRefs: basis,
    },
  };
  const batch = {
    protocolVersion: 1,
    machineId: current.machine.id,
    managerId: "cherry",
    sequence: 1,
    sentAt: new Date().toISOString(),
    updates: [entry],
    checks: [],
  };
  assert.equal(
    (await request("/api/v1/summaries", batch, "wrong")).status,
    401,
  );
  assert.equal((await request("/api/v1/summaries", batch)).status, 201);
  assert.equal((await request("/api/v1/summaries", batch)).status, 200);
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    1,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        updates: [
          { ...entry, summary: { ...entry.summary, progress: "conflict" } },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 2,
        updates: [{ ...entry, observedAt: new Date().toISOString() }],
      })
    ).status,
    201,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    1,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 3,
        updates: [
          {
            ...entry,
            summary: { ...entry.summary, evidenceRefs: ["b".repeat(64)] },
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 3,
        updates: [{ ...entry, taskId: "wrong-task" }],
      })
    ).status,
    409,
  );
  const changed = {
    ...entry,
    observedAt: new Date().toISOString(),
    summary: { ...entry.summary, progress: "完成核对，等待发布" },
  };
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 3,
        updates: [changed],
      })
    ).status,
    201,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    2,
  );
  const { summary, ...check } = {
    ...entry,
    observedAt: new Date().toISOString(),
  };
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 4,
        updates: [],
        checks: [check],
      })
    ).status,
    201,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    2,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        managerId: "other",
        sequence: 5,
      })
    ).status,
    409,
  );
  const own = await request("/api/v1/agent-state");
  assert.equal(own.status, 200);
  const self = (await own.json()) as {
    manager: { sequence: number };
    summaries: { summary: { progress: string } }[];
  };
  assert.equal(self.manager.sequence, 4);
  assert.equal(self.summaries[0].summary.progress, changed.summary.progress);
  const history = await request(
    "/api/v1/summary-history?machine=mac-one&space=default:w1&pane=w1:p1",
    undefined,
    viewer,
  );
  assert.equal(history.status, 200);
  assert.equal(
    ((await history.json()) as { entries: unknown[] }).entries.length,
    2,
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 4,
        updates: [],
        checks: [check],
      })
    ).status,
    200,
  );
});

test("summaries accept recent acknowledged evidence during active work, while checks cannot refresh old facts; outbox survives D1 outage", async () => {
  const { evidenceKeys } = await import("../src/shared/summaries.ts");
  const base = currentReport("semantic-moving", 20000);
  const pane = base.spaces[0].tabs[0].panes[0];
  pane.evidence = [
    {
      kind: "git",
      status: "success",
      source: "git:HEAD+status",
      observedAt: base.capturedAt,
      taskId: pane.task.id,
      revision: "a".repeat(40),
      summary: "main clean",
    },
  ];
  assert.equal((await request("/api/v1/reports", base)).status, 201);
  const entry = {
    spaceId: base.spaces[0].id,
    paneId: pane.id,
    taskId: pane.task.id,
    basis: Object.keys(await evidenceKeys(pane.evidence)),
    observedAt: new Date().toISOString(),
    summary: {
      task: "持续变化任务",
      phase: "implement",
      progress: "已完成第一步，后续仍在进行",
      outcomes: [],
      blocker: null,
      nextStep: "继续验证",
      rationale: "基于分析开始时的实际证据",
      evidenceRefs: [],
    },
  };
  const next = structuredClone(base);
  next.reportId = "semantic-moving-next";
  next.capturedAt = new Date(Date.parse(base.capturedAt) + 1).toISOString();
  next.spaces[0].tabs[0].panes[0].evidence[0].revision = "b".repeat(40);
  assert.equal((await request("/api/v1/reports", next)).status, 201);
  const batch = {
    protocolVersion: 1,
    machineId: "mac-one",
    managerId: "cherry",
    sequence: 5,
    sentAt: new Date().toISOString(),
    updates: [entry],
    checks: [],
  };
  const db = await mf.getD1Database("DB");
  await db.exec("ALTER TABLE pane_summaries RENAME TO archive_unavailable");
  const response = await request("/api/v1/summaries", batch);
  assert.equal(response.status, 201);
  assert.equal(
    ((await response.json()) as { archivePending: number }).archivePending,
    1,
  );
  const { summary, ...check } = {
    ...entry,
    observedAt: new Date().toISOString(),
  };
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 6,
        updates: [],
        checks: [check],
      })
    ).status,
    409,
  );
  await db.exec("ALTER TABLE archive_unavailable RENAME TO pane_summaries");
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  assert.equal((await request("/api/v1/summaries", batch)).status, 200);
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM pane_summaries WHERE task_id=? AND payload LIKE ?",
      )
      .bind("task-1", "%已完成第一步%")
      .first("n"),
    1,
  );
});

test("DO independently retains semantic records in UTC hours with latest/all queries, source and hashes", async () => {
  const now = new Date();
  const previousHour = new Date(now.getTime() - 3600000).toISOString();
  const entry = {
    spaceId: "default:w1",
    paneId: "w1:p1",
    taskId: "older-task",
    basis: [],
    observedAt: previousHour,
    summary: {
      task: "过去的任务",
      phase: "verify",
      progress: "小时内首次核对",
      outcomes: [],
      blocker: null,
      nextStep: "继续",
      rationale: "仅语义描述，无事实凭据",
      evidenceRefs: [],
    },
  };
  const batch = {
    protocolVersion: 1,
    machineId: "mac-one",
    managerId: "cherry",
    sequence: 6,
    sentAt: now.toISOString(),
    updates: [entry],
    checks: [],
  };
  assert.equal(
    (await request("/api/v1/summaries", batch)).status,
    201,
    "Delayed independent semantic report must not require an aligned current snapshot",
  );
  const second = {
    ...batch,
    sequence: 7,
    updates: [
      {
        ...entry,
        observedAt: new Date(Date.parse(previousHour) + 1).toISOString(),
        summary: { ...entry.summary, progress: "同一小时第二次实质变化" },
      },
    ],
  };
  assert.equal((await request("/api/v1/summaries", second)).status, 201);
  assert.equal((await request("/api/v1/summaries", second)).status, 200);
  const hour = `${previousHour.slice(0, 13)}:00:00.000Z`;
  const query =
    "/api/v1/semantic-hours?machine=mac-one&space=default:w1&pane=w1:p1";
  const get = async (path: string) =>
    (await request(path, undefined, viewer)).json() as Promise<{
      hours: {
        hour: string;
        count: number;
        latest: {
          contentHash: string;
          source: { managerId: string };
          value: { sequence: number; taskId: string };
        };
      }[];
      entries: {
        contentHash: string;
        hour: string;
        value: { sequence: number };
      }[];
    }>;
  const grouped = await get(query);
  const bucket = grouped.hours.find((h) => h.hour === hour);
  assert(bucket);
  assert.equal(bucket.count, 2);
  assert.equal(bucket.latest.value.sequence, 7);
  assert.equal(bucket.latest.source.managerId, "cherry");
  assert.match(bucket.latest.contentHash, /^[a-f0-9]{64}$/);
  const all = await get(`${query}&hour=${encodeURIComponent(hour)}&mode=all`);
  assert.equal(all.entries.length, 2);
  assert(all.entries.every((e) => e.hour === hour));
  const latest = await get(
    `${query}&hour=${encodeURIComponent(hour)}&mode=latest`,
  );
  assert.equal(latest.entries.length, 1);
  assert.equal(latest.entries[0].value.sequence, 7);
  const own = (await (await request("/api/v1/agent-state")).json()) as {
    summaries: { taskId: string }[];
  };
  assert(
    own.summaries.every((s) => s.taskId !== "older-task"),
    "Delayed task cannot replace current interpretation",
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  assert.equal(
    (await get(`${query}&hour=${encodeURIComponent(hour)}&mode=all`)).entries
      .length,
    2,
  );
  assert.equal((await request(query, undefined, "wrong")).status, 401);
  assert.equal(
    (
      await request(
        `${query}&hour=${encodeURIComponent(hour)}&mode=latest&before=2`,
        undefined,
        viewer,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 8,
        updates: [
          {
            ...entry,
            observedAt: new Date(Date.now() - 31 * 86400000).toISOString(),
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 8,
        updates: [
          {
            ...entry,
            observedAt: new Date(Date.parse(previousHour) - 1).toISOString(),
            summary: { ...entry.summary, progress: "迟到的更早观察" },
          },
        ],
      })
    ).status,
    201,
  );
  const active = currentReport("activate-historical-task", 30000);
  active.spaces[0].tabs[0].panes[0].task.id = "older-task";
  assert.equal((await request("/api/v1/reports", active)).status, 201);
  const restored = (await (await request("/api/v1/agent-state")).json()) as {
    summaries: { sequence: number }[];
  };
  assert.equal(
    restored.summaries[0].sequence,
    7,
    "A later upload of an older observation must never roll back the per-task latest pointer",
  );
});

test("retention cannot evict a live task interpretation in favor of delayed historical tasks", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: "mac-one" },
  );
  await storage.exec(
    "UPDATE semantic_current SET received_at='2000-01-01T00:00:00.000Z' WHERE task_id='older-task'",
  );
  await request("/api/v1/semantic-hours?machine=mac-one", undefined, viewer);
  const own = (await (await request("/api/v1/agent-state")).json()) as {
    summaries: { taskId: string; sequence: number }[];
  };
  assert.equal(own.summaries[0]?.taskId, "older-task");
  assert.equal(own.summaries[0].sequence, 7);
});
