import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { assistant, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { type Stack, startStack } from "../support/server.ts";

const post = (stack: Stack, botId: string, method: string, body: unknown) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${botId}/replica/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("two independent runtimes transfer original tool history without executing it on import", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  try {
    const sourceId = await a.createBot("source");
    const targetId = await b.createBot("replica");
    const source = await a.registry.open(sourceId, trace);
    a.faux?.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "原始工具结果" })], {
        stopReason: "toolUse",
      }),
      text("saved"),
    ]);
    await source.submit({ requestId: "r_source", text: "write once", whenBusy: "followUp", trace });
    await waitFor(
      async () => (await source.submission({ requestId: "r_source" }))?.status === "done",
      "source output commit",
    );
    const exported = await post(a, sourceId, "export", {});
    assert.equal(
      exported.status,
      200,
      "the daemon exports durable history rather than a UI projection",
    );
    assert.equal(
      await readFile(join(a.directory.botDir(sourceId), "workspace/original.txt"), "utf8"),
      "原始工具结果",
    );
    const bundle = (await exported.json()) as HistoryBundle;
    assert.ok(bundle.entries.some((entry) => entry.kind === "pi.tool-result"));
    const imported = await post(b, targetId, "import", { bundle });
    assert.equal(imported.status, 200);
    const receipt = (await imported.json()) as { head: string };
    const importedAgain = await post(b, targetId, "import", { bundle });
    assert.deepEqual(
      await importedAgain.json(),
      receipt,
      "passive admission is durable and idempotent",
    );
    await assert.rejects(readFile(join(b.directory.botDir(targetId), "workspace/original.txt")), {
      code: "ENOENT",
    });
    assert.equal(b.faux?.state.callCount, 0, "import invokes no model");
    const reexported = await post(b, targetId, "export", { head: receipt.head });
    assert.equal(reexported.status, 200);
    assert.deepEqual(
      await reexported.json(),
      bundle,
      "original entries and source ids survive unchanged",
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("history handoff keeps authentication, bot leases, method and dedicated body boundaries", async () => {
  const stack = await startStack({ real: true });
  const fake = await startStack();
  try {
    const bot = await stack.createBot("boundaries");
    const url = `http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/export`;
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal(
      (await fetch(url, { headers: { authorization: `Bearer ${stack.token}` } })).status,
      404,
    );
    assert.equal((await post(stack, "b_absent", "export", {})).status, 404);
    assert.equal((await post(stack, bot, "import", { bundle: {} })).status, 400);
    assert.equal((await post(stack, bot, "import", {})).status, 400);
    assert.equal(
      (await post(stack, bot, "export", { oversized: "x".repeat(8 * 1024 * 1024) })).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${stack.token}` },
          body: "{",
        })
      ).status,
      400,
    );
    const fakeBot = await fake.createBot("unsupported");
    assert.equal((await post(fake, fakeBot, "export", {})).status, 400);
    const failed = stack.records.filter((record) => record.evt === "runtime.replica.fail");
    assert.equal(failed.length, 2);
    assert.equal(
      stack.records.filter(
        (record) => record.level === "error" && record.evt === "core.replica.fail",
      ).length,
      1,
      "unknown bot is a core origin; runtime errors only propagate",
    );
  } finally {
    await Promise.all([stack.close(), fake.close()]);
  }
});
