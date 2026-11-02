import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryReceipt } from "../../src/core/RuntimePort.ts";
import { text, waitFor } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

test("scoped HTTP discovers an empty Bot and passively receives incremental history despite a broken observer", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  const call = (stack: typeof a, path: string, body: unknown, token = stack.token) =>
    fetch(`http://127.0.0.1:${stack.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let detach: (() => void) | undefined;
  let notices = 0;
  try {
    assert.ok(a.faux && b.faux);
    const source = await a.registry.create("empty discovery", "tr_incremental_http");
    const credential = await call(a, "/v1/clients", { name: "history-reader", scopes: ["read"] });
    assert.equal(credential.status, 201);
    const reader = (await credential.json()) as { token: string };
    const catalog = await call(a, "/v1/history/catalog/export", {}, reader.token);
    assert.equal(catalog.status, 200);
    const metadata: unknown = await catalog.json();
    assert.equal((await call(a, "/v1/history/catalog/import", metadata, reader.token)).status, 403);
    assert.equal((await call(b, "/v1/history/catalog/import", metadata)).status, 200);
    assert.equal(b.registry.summaries()[0]?.id, source.id);
    assert.equal(b.opens(), 0, "empty discovery never opens a model runtime");
    const handle = await a.registry.open(source.id, "tr_incremental_http");
    detach = handle.observeHistoryChanges?.(() => {
      notices += 1;
      throw new Error("sync observer fault");
    });
    assert.ok(detach);
    a.faux.setResponses([text("source native history")]);
    await handle.submit({
      requestId: "r_incremental_http",
      text: "incremental source",
      whenBusy: "followUp",
      trace: "tr_incremental_http",
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "r_incremental_http" }))?.status === "done",
      "source commit",
    );
    await waitFor(() => notices > 0, "broken observer delivery");
    const exported = await call(a, `/v1/bots/${source.id}/history/page`, {}, reader.token);
    assert.equal(exported.status, 200, "daemon remains available after observer throws");
    const page = (await exported.json()) as { head: string };
    const listing = await call(a, `/v1/bots/${source.id}/history/branches`, {}, reader.token);
    assert.equal(listing.status, 200);
    assert.ok(Array.isArray(((await listing.json()) as { branches: unknown }).branches));
    assert.equal(
      (await call(a, `/v1/bots/${source.id}/history/receive`, page, reader.token)).status,
      403,
    );
    assert.equal((await call(b, `/v1/bots/${source.id}/history/receive`, page)).status, 200);
    const view = await call(b, `/v1/bots/${source.id}/history/view`, { head: page.head });
    assert.equal(view.status, 200);
    assert.match(JSON.stringify(await view.json()), /source native history/);
    const boundedView = await call(b, `/v1/bots/${source.id}/history/view`, {
      head: page.head,
      after: page.head,
    });
    assert.equal(boundedView.status, 200);
    assert.equal(((await boundedView.json()) as { extendsCurrent: boolean }).extendsCurrent, false);
    for (const after of [2, "not-an-immutable-head"]) {
      assert.equal(
        (await call(b, `/v1/bots/${source.id}/history/view`, { head: page.head, after })).status,
        400,
      );
    }
    assert.equal(
      (await call(a, `/v1/bots/${source.id}/history/assess`, { head: page.head }, reader.token))
        .status,
      200,
    );
    for (const invalid of [
      null,
      [],
      { limit: 0 },
      { limit: 33 },
      { maxBytes: 128 * 1024 + 1 },
      { after: "x", before: "x" },
    ])
      assert.equal(
        (await call(a, `/v1/bots/${source.id}/history/page`, invalid, reader.token)).status,
        400,
      );
    for (const operation of ["view", "assess", "branches"])
      assert.equal(
        (await call(a, `/v1/bots/${source.id}/history/${operation}`, { extra: true }, reader.token))
          .status,
        400,
      );
    assert.equal(
      (await call(a, `/v1/bots/${source.id}/history/page`, { after: "foreign" }, reader.token))
        .status,
      400,
    );
    assert.equal((await call(a, "/v1/history/catalog/export", { knownIds: [null] })).status, 400);
  } finally {
    detach?.();
    await a.close();
    await b.close();
  }
});

test("authenticated HTTP handoff exports/imports/continues with read/write scopes", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  const call = (stack: typeof a, token: string, bot: string, operation: string, body: unknown) =>
    fetch(`http://127.0.0.1:${stack.port}/v1/bots/${bot}/history/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const readerOf = async (stack: typeof a) =>
    (await (
      await fetch(`http://127.0.0.1:${stack.port}/v1/clients`, {
        method: "POST",
        headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "reader", scopes: ["read"] }),
      })
    ).json()) as { token: string };
  try {
    assert.ok(a.faux !== undefined && b.faux !== undefined);
    const left = await a.registry.create("A", "tr_history");
    const right = await b.registry.create("B", "tr_history");
    a.faux.setResponses([text("portable apricot")]);
    const handle = await a.registry.open(left.id, "tr_history");
    await handle.submit({
      requestId: "r_history",
      text: "remember apricot",
      whenBusy: "followUp",
      trace: "tr_history",
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "r_history" }))?.status === "done",
      "source",
    );
    const reader = await readerOf(a);
    const exported = await call(a, reader.token, left.id, "export", {});
    assert.equal(exported.status, 200);
    const archive: unknown = await exported.json();
    const targetReader = await readerOf(b);
    assert.equal((await call(b, targetReader.token, right.id, "import", archive)).status, 403);
    assert.equal((await call(b, "wrong", right.id, "import", archive)).status, 401);
    const imported = await call(b, b.token, right.id, "import", archive);
    assert.equal(imported.status, 200);
    const receipt = (await imported.json()) as HistoryReceipt;
    assert.deepEqual(await (await call(b, b.token, right.id, "import", archive)).json(), receipt);
    b.faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /portable apricot/);
        return text("B continues");
      },
    ]);
    const body = { head: receipt.head, requestId: "r_continue", text: "continue" };
    const continued = await call(b, b.token, right.id, "continue", body);
    assert.equal(continued.status, 200);
    const result = await continued.json();
    assert.match(JSON.stringify(result), /B continues/);
    assert.deepEqual(await (await call(b, b.token, right.id, "continue", body)).json(), result);
    const refused = await call(b, b.token, right.id, "continue", { ...body, text: "changed" });
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: { disposition: string } }).error.disposition,
      "not_admitted",
    );
    for (const [operation, invalid] of [
      ["export", { extra: true }],
      ["import", {}],
      ["continue", {}],
    ] as const)
      assert.equal((await call(b, b.token, right.id, operation, invalid)).status, 400);
    assert.equal(
      (await call(b, b.token, right.id, "export", { selection: "unknown" })).status,
      400,
    );
    assert.equal((await call(b, b.token, "b_missing", "export", {})).status, 404);
  } finally {
    await a.close();
    await b.close();
  }
});
