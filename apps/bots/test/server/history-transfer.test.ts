import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryReceipt } from "../../src/core/RuntimePort.ts";
import { text, waitFor } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

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
    assert.equal(
      (await call(b, b.token, right.id, "continue", { ...body, text: "changed" })).status,
      400,
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
