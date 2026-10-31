import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { carrier, requestDigest } from "../src/crypto.ts";
import type { RequestValue } from "../src/wire.ts";
import { cached, getInput, identity, pageFixture, runtime, ttl, until } from "./support.ts";

let rt: Awaited<ReturnType<typeof runtime>>;
before(async () => {
  rt = await runtime();
});
after(async () => {
  await rt?.close();
});
async function fixture() {
  const f = pageFixture();
  await rt.control(f.sharedBotId, { now: null });
  return f;
}

test("real DO/R2 immutable ciphertext publish/get returns original upload clock and no plaintext in SQLite", async () => {
  const f = await fixture();
  carrier(f.carrier);
  const first = await cached(rt, f);
  assert(first.cloudCached);
  assert.equal(first.expiresAt, first.firstCachedAt + ttl);
  const second = await cached(rt, f);
  assert.deepEqual(second, first);
  const get = getInput(f),
    result = await rt.call(get, await rt.authorize(get, f));
  assert.equal(result.status, 200, await result.clone().text());
  const value = (await result.json()) as { carrier: unknown; expiresAt: number };
  assert.deepEqual(value.carrier, f.carrier);
  assert.equal(value.expiresAt, first.expiresAt);
  const storage = await rt.storage(f.sharedBotId);
  const rows = await storage.exec("SELECT metadata FROM objects");
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(f.carrier.ciphertext), false);
  assert.equal(JSON.stringify(rows).includes("ciphertext-only Worker"), false);
});

test("real SQLite read failures retain storage attribution and cause without supplying cached content", async (context) => {
  for (const [table, operation] of [
    ["objects", "get"],
    ["events", "list"],
    ["recipients", "get"],
    ["recipients", "list"],
    ["event_objects", "list"],
  ] as const) {
    await context.test(`${operation} with owned ${table} unavailable`, async () => {
      const f = await fixture();
      await cached(rt, f);
      const get = getInput(f);
      const originalResponse = await rt.call(get, await rt.authorize(get, f));
      assert.equal(originalResponse.status, 200);
      const original = await originalResponse.json();
      const storage = await rt.storage(f.sharedBotId);
      const originalRows = await storage.exec(`SELECT * FROM ${table}`);
      const readsBefore = (await storage.exec("SELECT gets FROM test_io"))[0]?.gets;
      const input: RequestValue =
        operation === "get"
          ? get
          : {
              version: 1,
              operation: "list",
              sharedBotId: f.sharedBotId,
              peerDeviceId: f.publisher.peer.deviceId,
              source: f.source,
              after: 0,
              limit: 128,
            };
      const authority = await rt.authorize(input, f);
      await storage.exec(`ALTER TABLE ${table} RENAME TO owned_unavailable_${table}`);
      try {
        const response = await rt.call(input, authority);
        const text = await response.text();
        const result = JSON.parse(text) as {
          error: { failure: { id: string; kind: string; layer: string } };
          trace: string;
        };
        context.diagnostic(
          JSON.stringify({
            table,
            operation,
            status: response.status,
            kind: result.error?.failure?.kind,
          }),
        );
        assert.equal(response.status, 503);
        assert.equal(result.error.failure.kind, "storage_failed");
        assert.equal(result.error.failure.layer, "runtime");
        assert.equal(result.trace, "tr_cache_fixture");
        assert.match(result.error.failure.id, /^f_[A-Za-z0-9_-]{1,32}$/);
        assert.equal(text.includes("carrier"), false);
        assert.equal(text.includes("objects"), false);
        assert.equal(text.includes("no such table"), false);
        assert.equal(text.includes(f.carrier.ciphertext), false);
        assert.equal((await storage.exec("SELECT gets FROM test_io"))[0]?.gets, readsBefore);
        assert.equal((await rt.control(f.sharedBotId, {})).sqlCausePreserved, true);
        await until(async () =>
          rt.logs.some((row) => row.message.includes(result.error.failure.id)) ? true : undefined,
        );
        const origins = rt.logs.filter((row) => row.message.includes(result.error.failure.id));
        assert.equal(origins.length, 1);
        assert.equal(origins[0]?.level, "error");
        assert.match(origins[0]?.message ?? "", /tr_cache_fixture/);
        assert.match(origins[0]?.message ?? "", /b_cache_fixture/);
        assert.equal(JSON.stringify(origins).includes("no such table"), false);
        assert.equal(JSON.stringify(origins).includes(f.carrier.ciphertext), false);
      } finally {
        await storage.exec(`ALTER TABLE owned_unavailable_${table} RENAME TO ${table}`);
        assert.deepEqual(await storage.exec(`SELECT * FROM ${table}`), originalRows);
        const recovered = await rt.call(get, await rt.authorize(get, f));
        assert.equal(recovered.status, 200);
        assert.deepEqual(await recovered.json(), original);
      }
    });
  }
});

test("same digest cannot substitute namespace, operation or recipient claims; current revocation fails closed", async () => {
  const f = await fixture();
  for (const change of [
    { sharedBotId: randomUUID() },
    { operation: "get" as const },
    { recipient: pageFixture().recipient.peer },
    { uploader: pageFixture().publisher.peer },
  ]) {
    const response = await rt.call(f.publish, await rt.authorize(f.publish, f, Date.now(), change));
    assert.equal(response.status, 403);
  }
  await cached(rt, f);
  const get = getInput(f);
  const hash = requestDigest(get);
  const publishToken = await rt.authorize(f.publish, f, Date.now(), { requestDigest: hash });
  assert.equal((await rt.call(get, publishToken)).status, 403);
  const bad = await rt.call(
    get,
    await rt.authorize(get, f, Date.now(), { recipient: pageFixture().recipient.peer }),
  );
  assert.equal(bad.status, 403);
  await rt.registryControl({ reject: true });
  try {
    assert.equal((await rt.call(get, await rt.authorize(get, f))).status, 403);
  } finally {
    await rt.registryControl({ reject: false });
  }
});

test("empty signed page does not create cache object or cloud-cached acknowledgement", async () => {
  const f = pageFixture({ empty: true });
  await rt.control(f.sharedBotId, { now: null });
  const response = await rt.call(f.publish, await rt.authorize(f.publish, f));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 1, cloudCached: false, reason: "empty_page" });
  const storage = await rt.storage(f.sharedBotId);
  assert.equal((await storage.exec("SELECT * FROM objects")).length, 0);
  assert.equal(await rt.bucket.head(`v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`), null);
});

test("event primary tuple rejects a different signed digest and expired data cannot be resurrected", async () => {
  const f = await fixture(),
    first = await cached(rt, f);
  const changed = pageFixture({
    sharedBotId: f.sharedBotId,
    source: f.source,
    publisher: f.publisher,
    recipient: f.recipient,
  });
  assert.notEqual(
    changed.carrier.manifest.included[0]?.eventDigest,
    f.carrier.manifest.included[0]?.eventDigest,
  );
  assert.equal(
    (await rt.call(changed.publish, await rt.authorize(changed.publish, changed))).status,
    409,
  );
  const get = getInput(f);
  await rt.control(f.sharedBotId, { now: first.expiresAt - 1 });
  assert.equal((await rt.call(get, await rt.authorize(get, f, first.expiresAt - 1))).status, 200);
  await rt.control(f.sharedBotId, { now: first.expiresAt });
  assert.equal((await rt.call(get, await rt.authorize(get, f, first.expiresAt))).status, 410);
  assert.equal(
    (await rt.call(f.publish, await rt.authorize(f.publish, f, first.expiresAt))).status,
    410,
  );
  await rt.control(f.sharedBotId, { alarm: true });
  assert.equal(await rt.bucket.head(`v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`), null);
  const storage = await rt.storage(f.sharedBotId);
  const event = await storage.exec("SELECT * FROM events");
  assert.equal(event[0]?.tombstone, 1);
  assert.equal(event[0]?.firstCachedAt, first.firstCachedAt);
  await rt.control(f.sharedBotId, { now: null });
});

test("R2 await crossing retention rejects before supply and keeps complete bounded body verification", async () => {
  const f = await fixture(),
    first = await cached(rt, f),
    get = getInput(f);
  await rt.control(f.sharedBotId, { mode: "get-after" });
  const pending = rt.call(get, await rt.authorize(get, f, first.expiresAt));
  await until(async () => ((await rt.control(f.sharedBotId, {})).started ? true : undefined));
  await rt.control(f.sharedBotId, { now: first.expiresAt, release: true });
  const expired = await pending;
  assert.equal(expired.status, 410);
  await rt.control(f.sharedBotId, { mode: "body-throw", now: null });
  assert.equal((await rt.call(get, await rt.authorize(get, f))).status, 503);
  await rt.control(f.sharedBotId, { mode: "body-missing" });
  assert.equal((await rt.call(get, await rt.authorize(get, f))).status, 503);
  await rt.control(f.sharedBotId, { mode: "" });
});

test("delete failure retains unknown cleanup, retry physically deletes without serving expired data", async () => {
  const f = await fixture(),
    first = await cached(rt, f),
    get = getInput(f),
    key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`;
  await rt.control(f.sharedBotId, { mode: "delete-throw", now: first.expiresAt, alarm: true });
  assert(await rt.bucket.head(key));
  const storage = await rt.storage(f.sharedBotId);
  const state = await storage.exec("SELECT state,physical FROM objects");
  assert.deepEqual(state, [{ state: "expired", physical: "unknown" }]);
  assert.equal((await rt.call(get, await rt.authorize(get, f, first.expiresAt))).status, 410);
  await rt.control(f.sharedBotId, { mode: "", alarm: true });
  assert.equal(await rt.bucket.head(key), null);
  assert.deepEqual(await storage.exec("SELECT state,physical FROM objects"), [
    { state: "deleted", physical: "deleted" },
  ]);
  await rt.control(f.sharedBotId, { now: null });
});

test("committed put with lost result remains pending, alarm/retry recovers winner uploaded without a new clock", async () => {
  const f = await fixture();
  await rt.control(f.sharedBotId, { mode: "put-after-throw" });
  const lost = await rt.call(f.publish, await rt.authorize(f.publish, f));
  assert.equal(lost.status, 503);
  const key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`,
    head = await rt.bucket.head(key);
  assert(head);
  const storage = await rt.storage(f.sharedBotId);
  assert.equal((await storage.exec("SELECT firstCachedAt FROM events"))[0]?.firstCachedAt, null);
  await rt.control(f.sharedBotId, { mode: "negative-head", alarm: true });
  const recovered = await storage.exec("SELECT firstCachedAt,expiresAt FROM events");
  assert.equal(recovered[0]?.firstCachedAt, head.uploaded.getTime());
  assert.equal(recovered[0]?.expiresAt, head.uploaded.getTime() + ttl);
  const retry = await cached(rt, f);
  assert.equal(retry.firstCachedAt, head.uploaded.getTime());
  assert.equal((await rt.bucket.head(key))?.uploaded.getTime(), head.uploaded.getTime());
});

test("overlapping packaging stays pending; late preexisting put after expiry/delete is cleaned again", async () => {
  const f = pageFixture({ eventValue: "fixed event" });
  await rt.control(f.sharedBotId, { now: null, mode: "put-before" });
  const pending = rt.call(f.publish, await rt.authorize(f.publish, f));
  try {
    await until(async () => ((await rt.control(f.sharedBotId, {})).started ? true : undefined));
    assert.equal(await rt.bucket.head(`v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`), null);
    const repage = pageFixture({
      sharedBotId: f.sharedBotId,
      source: f.source,
      publisher: f.publisher,
      recipient: f.recipient,
      eventValue: "fixed event",
      hasMore: true,
    });
    assert.notEqual(repage.carrier.manifest.objectId, f.carrier.manifest.objectId);
    assert.deepEqual(repage.carrier.manifest.included, f.carrier.manifest.included);
    assert.equal(
      (await rt.call(repage.publish, await rt.authorize(repage.publish, repage))).status,
      409,
    );
    const winner = await cached(rt, f);
    const key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`;
    await rt.control(f.sharedBotId, { now: winner.expiresAt, alarm: true });
    assert.equal(await rt.bucket.head(key), null);
    const storage = await rt.storage(f.sharedBotId);
    assert.deepEqual(await storage.exec("SELECT state,physical,unresolved FROM objects"), [
      { state: "expired", physical: "unknown", unresolved: 1 },
    ]);
    await rt.control(f.sharedBotId, { release: true });
    const late = await pending;
    assert.notEqual(late.status, 200);
    await until(async () => {
      const rows = await storage.exec("SELECT state,physical,unresolved FROM objects");
      return rows[0]?.state === "deleted" &&
        rows[0]?.unresolved === 0 &&
        (await rt.bucket.head(key)) === null
        ? true
        : undefined;
    });
    assert.equal(
      (await storage.exec("SELECT firstCachedAt FROM events"))[0]?.firstCachedAt,
      winner.firstCachedAt,
    );
  } finally {
    await rt.control(f.sharedBotId, { release: true, mode: "", now: null });
    await pending;
  }
});

test("last Registry await cannot cross object or authority expiry before supplying ciphertext", async () => {
  for (const boundary of ["authority", "object"]) {
    const f = await fixture(),
      first = await cached(rt, f),
      get = getInput(f);
    const now = boundary === "object" ? first.expiresAt - 1 : Date.now();
    await rt.control(f.sharedBotId, { now });
    const token = await rt.authorize(get, f, now);
    await rt.registryControl({ holdAt: 3 });
    const pending = rt.call(get, token);
    try {
      await until(async () => {
        const state = (await (await rt.registryControl({})).json()) as { started: boolean };
        return state.started ? true : undefined;
      });
      await rt.control(f.sharedBotId, {
        now: boundary === "object" ? first.expiresAt : now + 60000,
      });
      await rt.registryControl({ release: true });
      const response = await pending;
      assert.equal(response.status, 410);
      assert.equal((await response.text()).includes(f.carrier.ciphertext), false);
    } finally {
      await rt.registryControl({ release: true });
      await pending;
      await rt.control(f.sharedBotId, { now: null });
    }
  }
});

test("real DO eviction/reopen recovers committed pending winner and metadata reference failure without renewing uploaded", async () => {
  for (const mode of ["put-after-throw", "reference-throw"]) {
    const f = await fixture();
    await rt.control(f.sharedBotId, { mode });
    const failed = await rt.call(f.publish, await rt.authorize(f.publish, f));
    assert.equal(failed.status, 503);
    const key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`;
    const head = await rt.bucket.head(key);
    assert(head);
    const before = await rt.storage(f.sharedBotId);
    const boots = (await before.exec("SELECT count FROM test_boots"))[0]?.count;
    assert.deepEqual(await before.exec("SELECT state FROM objects"), [{ state: "pending" }]);
    await rt.evict(f.sharedBotId);
    await rt.control(f.sharedBotId, { mode: "negative-head", alarm: true });
    const reopened = await rt.storage(f.sharedBotId);
    assert.equal(
      (await reopened.exec("SELECT count FROM test_boots"))[0]?.count,
      Number(boots) + 1,
    );
    const result = await cached(rt, f);
    assert.equal(result.firstCachedAt, head.uploaded.getTime());
    assert.equal(result.expiresAt, head.uploaded.getTime() + ttl);
    const get = getInput(f),
      response = await rt.call(get, await rt.authorize(get, f));
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { carrier: unknown }).carrier, f.carrier);
  }
});

test("same-object concurrent publishers return the original R2 winner and one recipient slot", async () => {
  const f = await fixture();
  const results = await Promise.all([cached(rt, f), cached(rt, f), cached(rt, f)]);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  const storage = await rt.storage(f.sharedBotId);
  assert.equal((await storage.exec("SELECT * FROM objects")).length, 1);
  assert.equal((await storage.exec("SELECT * FROM recipients")).length, 1);
  assert.equal((await storage.exec("SELECT unresolved FROM objects"))[0]?.unresolved, 0);
});

test("bounded list reports only available recipient coverage, with pending/missing/expired gaps", async () => {
  const f = await fixture(),
    first = await cached(rt, f);
  const query: RequestValue = {
    version: 1,
    operation: "list",
    sharedBotId: f.sharedBotId,
    peerDeviceId: f.publisher.peer.deviceId,
    source: f.source,
    after: 0,
    limit: 1,
  };
  const call = async () => rt.call(query, await rt.authorize(query, f));
  let response = await call();
  assert.equal(response.status, 200);
  const expected = (await response.json()) as {
    objects: { objectId: string }[];
    gaps: unknown[];
    complete: boolean;
  };
  assert.deepEqual(
    expected.objects.map((v) => v.objectId),
    [f.carrier.manifest.objectId],
  );
  assert.deepEqual(expected.gaps, []);
  assert.equal(expected.complete, false);
  const key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`;
  await rt.bucket.delete(key);
  response = await call();
  assert.equal(response.status, 200);
  let result = (await response.json()) as { objects: unknown[]; gaps: unknown[] };
  assert.deepEqual(result.objects, []);
  assert.deepEqual(result.gaps, [{ seq: 1, reason: "unavailable" }]);
  await rt.control(f.sharedBotId, { now: first.expiresAt });
  response = await rt.call(query, await rt.authorize(query, f, first.expiresAt));
  assert.equal(response.status, 200);
  result = (await response.json()) as { objects: unknown[]; gaps: unknown[] };
  assert.deepEqual(result.objects, []);
  assert.deepEqual(result.gaps, [{ seq: 1, reason: "expired" }]);
  await rt.control(f.sharedBotId, { now: null });
});

test("R2 body I/O has a single redacted runtime failure identity and trace for remote propagation", async () => {
  const f = await fixture();
  await cached(rt, f);
  const get = getInput(f);
  await rt.control(f.sharedBotId, { mode: "body-throw" });
  const response = await rt.call(get, await rt.authorize(get, f));
  assert.equal(response.status, 503);
  const result = (await response.json()) as {
    error: { failure: { id: string; kind: string; layer: string } };
    trace: string;
  };
  assert.equal(result.error.failure?.kind, "storage_failed");
  assert.equal(result.error.failure.layer, "runtime");
  assert.match(result.error.failure.id, /^f_[A-Za-z0-9_-]{1,32}$/);
  assert.equal(result.trace, "tr_cache_fixture");
  await until(async () =>
    rt.logs.some((log) => log.message.includes(result.error.failure.id)) ? true : undefined,
  );
  const logs = rt.logs.filter((log) => log.message.includes(result.error.failure.id));
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "error");
  assert.match(logs[0]?.message ?? "", /b_cache_fixture/);
  assert.match(logs[0]?.message ?? "", /tr_cache_fixture/);
  assert.equal(JSON.stringify(logs).includes(f.carrier.ciphertext), false);
  assert.equal(JSON.stringify(logs).includes(f.carrier.envelope.ciphertext), false);
  await rt.control(f.sharedBotId, { mode: "" });
});

test("list does not advertise an immutable key whose complete cipher winner is corrupt", async () => {
  const f = await fixture();
  await cached(rt, f);
  const key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`,
    head = await rt.bucket.head(key);
  assert(head);
  assert(head.customMetadata);
  const bytes = Buffer.from(f.carrier.ciphertext, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  await rt.bucket.put(key, bytes, { customMetadata: head.customMetadata });
  const query: RequestValue = {
    version: 1,
    operation: "list",
    sharedBotId: f.sharedBotId,
    peerDeviceId: f.publisher.peer.deviceId,
    source: f.source,
    after: 0,
    limit: 1,
  };
  const response = await rt.call(query, await rt.authorize(query, f));
  assert.equal(response.status, 200);
  const result = (await response.json()) as { objects: unknown[]; gaps: unknown[] };
  assert.deepEqual(result.objects, []);
  assert.deepEqual(result.gaps, [{ seq: 1, reason: "unavailable" }]);
});

test("128 included events verify each distinct complete cipher only once in one list request", async () => {
  const f = pageFixture({ count: 128 });
  await rt.control(f.sharedBotId, { now: null });
  await cached(rt, f);
  const query: RequestValue = {
    version: 1,
    operation: "list",
    sharedBotId: f.sharedBotId,
    peerDeviceId: f.publisher.peer.deviceId,
    source: f.source,
    after: 0,
    limit: 128,
  };
  const storage = await rt.storage(f.sharedBotId),
    key = `v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`;
  for (const damaged of [false, true]) {
    if (damaged) {
      const head = await rt.bucket.head(key);
      assert(head);
      assert(head.customMetadata);
      const bytes = Buffer.from(f.carrier.ciphertext, "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await rt.bucket.put(key, bytes, { customMetadata: head.customMetadata });
    }
    const before = Number((await storage.exec("SELECT gets FROM test_io"))[0]?.gets);
    const response = await rt.call(query, await rt.authorize(query, f));
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      objects: { included: unknown[] }[];
      gaps: unknown[];
    };
    assert.equal(Number((await storage.exec("SELECT gets FROM test_io"))[0]?.gets) - before, 1);
    assert.equal(result.objects.length, damaged ? 0 : 1);
    assert.equal(result.gaps.length, damaged ? 128 : 0);
    if (!damaged) assert.equal(result.objects[0]?.included.length, 128);
  }
});

test("repage and another authorized publisher preserve the original event clock; another cipher under one object ID conflicts", async () => {
  const f = pageFixture({ eventValue: "immutable event" });
  await rt.control(f.sharedBotId, { now: null });
  const first = await cached(rt, f);
  const repage = pageFixture({
    sharedBotId: f.sharedBotId,
    source: f.source,
    publisher: f.publisher,
    recipient: f.recipient,
    eventValue: "immutable event",
    hasMore: true,
  });
  const forwarded = pageFixture({
    sharedBotId: f.sharedBotId,
    source: f.source,
    publisher: identity(f.publisher.peer.groupId as string),
    recipient: f.recipient,
    eventValue: "immutable event",
  });
  for (const value of [repage, forwarded]) {
    assert.notEqual(value.carrier.manifest.objectId, f.carrier.manifest.objectId);
    assert.deepEqual(value.carrier.manifest.included, f.carrier.manifest.included);
    const result = await cached(rt, value);
    assert.equal(result.firstCachedAt, first.firstCachedAt);
    assert.equal(result.expiresAt, first.expiresAt);
  }
  const conflict = pageFixture({
    sharedBotId: f.sharedBotId,
    source: f.source,
    publisher: f.publisher,
    recipient: f.recipient,
    eventValue: "immutable event",
  });
  assert.equal(conflict.carrier.manifest.objectId, f.carrier.manifest.objectId);
  assert.notEqual(conflict.carrier.ciphertext, f.carrier.ciphertext);
  assert.equal(
    (await rt.call(conflict.publish, await rt.authorize(conflict.publish, conflict))).status,
    409,
  );
  const get = getInput(f),
    result = await rt.call(get, await rt.authorize(get, f));
  assert.equal(result.status, 200);
  assert.deepEqual(((await result.json()) as { carrier: unknown }).carrier, f.carrier);
});

test("all cache signatures and cipher/object/envelope bindings reject before metadata or R2 publication", async () => {
  const f = await fixture();
  const mutations = [
    (c: typeof f.carrier) => {
      c.manifest.signature = "A".repeat(86);
    },
    (c: typeof f.carrier) => {
      c.descriptor.signature = "A".repeat(86);
    },
    (c: typeof f.carrier) => {
      c.descriptor.keyId = "0".repeat(64);
    },
    (c: typeof f.carrier) => {
      c.envelope.signature = "A".repeat(86);
    },
    (c: typeof f.carrier) => {
      c.envelope.recipientDescriptor.signature = "A".repeat(86);
    },
    (c: typeof f.carrier) => {
      c.envelope.objectId = "0".repeat(64);
    },
    (c: typeof f.carrier) => {
      c.envelope.nonce = "A".repeat(16);
    },
    (c: typeof f.carrier) => {
      c.manifest.source.epoch = randomUUID();
    },
    (c: typeof f.carrier) => {
      const bytes = Buffer.from(c.ciphertext, "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      c.ciphertext = bytes.toString("base64url");
    },
  ];
  for (const mutate of mutations) {
    const c = structuredClone(f.carrier);
    mutate(c);
    assert.notDeepEqual(c, f.carrier);
    const input = { ...f.publish, carrier: c };
    const response = await rt.call(input, await rt.authorize(input, f));
    assert.equal(response.status, 403);
  }
  const storage = await rt.storage(f.sharedBotId);
  assert.equal((await storage.exec("SELECT * FROM objects")).length, 0);
  assert.equal(await rt.bucket.head(`v1/${f.sharedBotId}/${f.carrier.manifest.objectId}`), null);
});

test("revocation during the final Registry await fails closed after complete R2 body validation", async () => {
  const f = await fixture();
  await cached(rt, f);
  const get = getInput(f),
    token = await rt.authorize(get, f);
  await rt.registryControl({ holdAt: 3 });
  const pending = rt.call(get, token);
  try {
    await until(async () => {
      const state = (await (await rt.registryControl({})).json()) as { started: boolean };
      return state.started ? true : undefined;
    });
    await rt.registryControl({ reject: true, release: true });
    const response = await pending;
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(f.carrier.ciphertext), false);
  } finally {
    await rt.registryControl({ reject: false, release: true });
    await pending;
  }
});
