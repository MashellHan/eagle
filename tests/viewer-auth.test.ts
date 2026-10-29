import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentIdentity,
  authenticateViewer,
  containsCredential,
  issueToken,
  payloadContainsCredential,
  safeAiConfiguration,
  viewerIdentity,
} from "../apps/web/src/worker/auth.ts";

const owner = "isolated-owner-credential-at-least-32-characters";
const agent = "isolated-agent-credential-at-least-32-characters";
const env = {
  OWNER_TOKEN: owner,
  AGENT_TOKENS: JSON.stringify({ "mac-one": agent }),
} as Env;
const request = (value: string, url = "https://eagle.test/api/v1/me") =>
  new Request(url, { headers: { Authorization: value } });

test("an owner Bearer yields a native identity and a finite server-owned lease", async () => {
  const before = Date.now();
  const input = request(`Bearer ${owner}`);
  input.headers.set("Cf-Access-Jwt-Assertion", "unverified.fake.jwt");
  input.headers.set("x-live-expires", "Infinity");
  const auth = await authenticateViewer(input, env);
  assert(auth);
  assert.equal(auth.kind, "owner");
  assert(auth.expiresAt >= before + 15 * 60_000);
  assert(auth.expiresAt <= Date.now() + 15 * 60_000);
  assert.deepEqual(await viewerIdentity(input, env), {
    email: "",
    name: "部署所有者",
    avatar: null,
    local: false,
  });
});

test("native owner and machine credentials cannot substitute for each other", async () => {
  assert.equal(await authenticateViewer(request(`Bearer ${agent}`), env), null);
  assert.equal(await agentIdentity(request(`Bearer ${owner}`), env), null);
  assert.equal(
    (await agentIdentity(request(`Bearer ${agent}`), env))?.machineId,
    "mac-one",
  );
  assert.equal(
    await authenticateViewer(request(`Bearer ${owner}`), {
      ...env,
      OWNER_TOKEN: agent,
    }),
    null,
  );
  assert.equal(
    await authenticateViewer(request(`Bearer ${agent}`), {
      ...env,
      OWNER_TOKEN: agent,
    }),
    null,
  );
});

test("a genuinely signed machine token cannot be configured as the owner credential", async () => {
  const signedEnv = {
    ...env,
    AGENT_SIGNING_KEY: "isolated-signing-key-with-at-least-32-characters",
  };
  const token = await issueToken(
    {
      id: "mac-one",
      name: "Test Mac",
      enabled: true,
      source: "managed",
      credentialId: "test-credential",
      createdAt: null,
      rotatedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      watchPorts: [],
    },
    signedEnv,
  );
  const input = request(`Bearer ${token}`);
  assert.equal((await agentIdentity(input, signedEnv))?.machineId, "mac-one");
  assert.equal(
    await authenticateViewer(input, { ...signedEnv, OWNER_TOKEN: token }),
    null,
  );
});

test("explicit invalid authorization never falls back to local development", async () => {
  for (const value of [
    "",
    "Bearer wrong",
    "Basic invalid",
    `Bearer ${owner} extra`,
  ]) {
    const input = request(value, "http://127.0.0.1/api/v1/me");
    assert.equal(
      await viewerIdentity(input, { ...env, LOCAL_DEV: "true" }),
      null,
    );
  }
});

test("owner auth rejects missing or malformed configuration and non-loopback HTTP", async () => {
  for (const secret of [undefined, "short", " ".repeat(32), "x".repeat(4097)])
    assert.equal(
      await authenticateViewer(request(`Bearer ${owner}`), {
        ...env,
        OWNER_TOKEN: secret,
      }),
      null,
    );
  assert.equal(
    await authenticateViewer(
      request(`Bearer ${owner}`, "http://eagle.test/api/v1/me"),
      env,
    ),
    null,
  );
  assert.equal(
    (
      await authenticateViewer(
        request(`Bearer ${owner}`, "http://127.0.0.1/api/v1/me"),
        env,
      )
    )?.kind,
    "owner",
  );
});

test("local auth metadata preserves the existing viewer and bounded lease", async () => {
  const before = Date.now();
  const input = new Request("http://127.0.0.1/api/v1/me");
  const auth = await authenticateViewer(input, { ...env, LOCAL_DEV: "true" });
  assert(auth);
  assert.equal(auth.kind, "local");
  assert.equal(auth.viewer.local, true);
  assert(auth.expiresAt >= before + 15 * 60_000);
  assert(auth.expiresAt <= Date.now() + 15 * 60_000);
});

test("known owner credentials are excluded from payloads alongside machine credentials", () => {
  assert.equal(containsCredential(`value:${owner}`, env), true);
  assert.equal(containsCredential(`value:${agent}`, env), true);
  assert.equal(containsCredential("ordinary machine name", env), false);
});

test("decoded payload strings reveal escaped credentials before storage or forwarding", () => {
  const secret = 'isolated-"quoted"-owner-secret-at-least-32-characters';
  const quotedEnv = { ...env, OWNER_TOKEN: secret };
  const payload = JSON.parse(JSON.stringify({ fields: [{ value: secret }] }));
  assert.equal(payloadContainsCredential(payload, quotedEnv), true);
  const unicode = `{"text":"${[...owner].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`;
  assert.equal(payloadContainsCredential(JSON.parse(unicode), env), true);
  assert.equal(
    payloadContainsCredential({ fields: ["ordinary", 3, null] }, env),
    false,
  );
});

test("AI save and connection-test validation reject owner credentials in either field", () => {
  assert.equal(safeAiConfiguration({ model: "example" }, owner, env), false);
  assert.equal(safeAiConfiguration({ model: owner }, "new-ai-key", env), false);
  assert.equal(
    safeAiConfiguration(
      { model: "example", endpoint: "https://ai.example" },
      "new-ai-key",
      env,
    ),
    true,
  );
  assert.equal(
    safeAiConfiguration({ model: "new-ai-key" }, "new-ai-key", env),
    false,
  );
  const quoted = 'isolated-"quoted"-owner-credential-at-least-32-characters';
  assert.equal(
    safeAiConfiguration({ model: quoted }, null, {
      ...env,
      OWNER_TOKEN: quoted,
    }),
    false,
  );
});
