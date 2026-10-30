import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClassifiedFailure } from "../src/core/domain.ts";
import { SocketDeviceSyncPort } from "../src/device-sync.ts";
import { captureLog } from "../src/log/log.ts";

test("the private sync adapter preserves refusal cause/trace and rejects mismatched metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-sync-port-"));
  await chmod(root, 0o700);
  const path = join(root, "access.sock");
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../fixtures/bots-protocol/sync-access.http.json", import.meta.url),
      "utf8",
    ),
  );
  let reply: unknown = { error: "sync_not_shared" };
  const calls: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (part) => {
      buffer += part;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      calls.push(request.method);
      socket.end(`${JSON.stringify({ requestId: request.requestId, ...(reply as object) })}\n`);
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  await chmod(path, 0o600);
  const { log, records } = captureLog();
  const port = new SocketDeviceSyncPort(path, log);
  const context = { trace: "tr_sync_adapter", botId: "b_sync" };
  const input = { ...fixture.request, sharedBotId: fixture.response.sharedBotId };
  try {
    await assert.rejects(port.access(input, context), (error: unknown) => {
      assert(error instanceof ClassifiedFailure);
      assert.equal(error.failure.kind, "auth_failed");
      assert.equal((error.cause as Error).message, "sync_not_shared");
      assert.equal(records.find((r) => r.err?.origin)?.err?.failure, error.failure.id);
      assert.equal(records.find((r) => r.err?.origin)?.trace, context.trace);
      return true;
    });
    reply = { result: fixture.response };
    assert.deepEqual(await port.access(input, context), fixture.response);
    reply = { result: { version: 1, identity: fixture.response.local } };
    assert.deepEqual(await port.identity(context), (reply as { result: unknown }).result);
    for (const result of [
      { ...fixture.response, sharedBotId: "55555555-5555-4555-8555-555555555555" },
      { ...fixture.response, local: fixture.response.peer },
      {
        ...fixture.response,
        endpoints: { ...fixture.response.endpoints, identity: fixture.response.local },
      },
      { version: 99 },
    ]) {
      reply = { result };
      await assert.rejects(port.access(input, context), (error: unknown) => {
        assert(error instanceof ClassifiedFailure);
        assert.ok(error.cause);
        return true;
      });
    }
    assert.equal(calls.length, 7);
    assert.equal(records.filter((r) => r.level === "error").length, 5);
    assert.equal(JSON.stringify(records).includes(path), false);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
