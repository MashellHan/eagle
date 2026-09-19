import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { report } from "./fixtures.ts";

let mf: Miniflare;
const token = "test-agent-token-with-at-least-32-characters";
const viewer = "test-viewer-token-with-at-least-32-characters";
const currentReport = (id: string, offset = 0) =>
  report(id, new Date(Date.now() + offset).toISOString());
before(async () => {
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
          bindings: {
            AGENT_TOKENS: JSON.stringify({
              "mac-one": token,
              "mac-two": "different-test-token-with-at-least-32-characters",
            }),
            VIEWER_TOKEN: viewer,
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
      Authorization: `Bearer ${bearer}`,
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
test("browser session has secure HttpOnly cookie, no token, origin checks and logout", async () => {
  const response = await request("/api/session", {}, viewer);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert(!cookie.includes(viewer));
  const sessionCookie = cookie.split(";")[0];
  const overview = await mf.dispatchFetch(
    "https://eagle.test/api/v1/overview",
    { headers: { Cookie: sessionCookie } },
  );
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get("cache-control"), "no-store");
  const crossOrigin = await mf.dispatchFetch("https://eagle.test/api/session", {
    method: "POST",
    headers: {
      Origin: "https://attacker.test",
      Authorization: `Bearer ${viewer}`,
    },
  });
  assert.equal(crossOrigin.status, 403);
  const logout = await mf.dispatchFetch("https://eagle.test/api/session", {
    method: "DELETE",
    headers: { Cookie: sessionCookie },
  });
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
});
