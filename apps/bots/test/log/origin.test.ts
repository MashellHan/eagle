// Ladder row 42, origin half: exactly one `level=error` per failure identity, on the layer
// where it originated, with every layer above recording a propagated `warn`
// (docs/bots/OBSERVABILITY.md, "Failure recording: origin versus propagation").
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { LogRecord } from "../../src/log/log.ts";
import { closeCode, frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

const withFailure = (records: readonly LogRecord[], id: string): LogRecord[] =>
  records.filter((record) => record.err?.failure === id);

const errors = (records: readonly LogRecord[]): LogRecord[] =>
  records.filter((record) => record.level === "error");

const identity = (records: readonly LogRecord[]): Set<string> => {
  const ids = new Set<string>();
  for (const record of records) if (record.err !== undefined) ids.add(record.err.failure);
  return ids;
};

test("a storage failure is one error at runtime, then warn records above it", async () => {
  // The bot's sqlite path is a directory, so the real Harness cannot open it.
  const stack = await startStack({
    real: true,
    prepare: async ({ directory }) => {
      const config = {
        id: "b_broken",
        title: "坏的",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        model: { provider: "faux", modelId: "faux-1" },
      };
      await directory.create(config);
      await mkdir(join(directory.botDir(config.id), "session.sqlite"));
    },
  });
  try {
    const botRecords = stack.records.filter((record) => record.botId === "b_broken");
    assert.ok(botRecords.length > 0, "the recovery scan recorded the failed open");
    const failed = errors(botRecords);
    assert.equal(failed.length, 1, "one failure episode, one error record");
    assert.equal(failed[0]?.layer, "runtime");
    assert.equal(failed[0]?.evt, "runtime.open.fail");
    assert.equal(failed[0]?.err?.origin, true);
    const id = failed[0]?.err?.failure as string;
    assert.deepEqual([...identity(botRecords)], [id], "one identity for the whole episode");

    const above = withFailure(botRecords, id).filter((record) => record.level !== "error");
    assert.ok(above.length > 0, "the upper layers report what they handed on");
    for (const record of above) {
      assert.equal(record.layer, "core");
      assert.equal(record.detail?.propagated, true);
      assert.equal(record.err?.origin, undefined, "only the origin claims origin");
    }
    assert.ok(
      above.some((record) => record.evt === "core.bot.open.fail"),
      "the registry records the open it handed on",
    );
    assert.ok(
      above.some((record) => record.evt === "core.recovery.bot.fail"),
      "the startup scan carries the same identity, not a new one",
    );

    // The connection still works and renders the reason instead of failing.
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const before = stack.records.length;
    await send(socket, { type: "subscribe", botId: "b_broken", trace: tr("broken") });
    const snapshot = await frames.next();
    assert.equal(snapshot.type, "snapshot");
    const value = snapshot.value as { unavailable?: { reason: string } };
    assert.equal(value.unavailable?.reason, "storage_failed");
    // A second open attempt is a second episode: it gets its own identity, still exactly
    // one error record and the same propagated chain above it.
    const retried = stack.records.slice(before);
    const retriedErrors = errors(retried);
    assert.equal(retriedErrors.length, 1, "one error per episode");
    const retriedId = retriedErrors[0]?.err?.failure as string;
    assert.notEqual(retriedId, id, "a new attempt is a new episode");
    for (const record of withFailure(retried, retriedId).filter(
      (record) => record.level !== "error",
    )) {
      assert.equal(record.detail?.propagated, true);
      assert.equal(record.err?.origin, undefined);
    }
    socket.close();
  } finally {
    await stack.close();
  }
});

test("an unknown bot is one error at core and nothing reaches the runtime", async () => {
  const stack = await startStack({ real: true });
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const before = stack.records.length;
    await send(socket, { type: "subscribe", botId: "b_missing", trace: tr("missing") });
    assert.equal(await closeCode(socket), 4004);
    const records = stack.records.slice(before);
    const failed = errors(records);
    assert.equal(failed.length, 1, "exactly one error record");
    assert.equal(failed[0]?.layer, "core");
    assert.equal(failed[0]?.evt, "core.bot.resolve.fail");
    assert.equal(failed[0]?.err?.origin, true);
    assert.deepEqual(
      records.filter((record) => record.layer === "runtime"),
      [],
      "no runtime record for a bot that never resolved",
    );
    const propagated = records.filter((record) => record.evt === "protocol.command.fail");
    assert.equal(propagated.length, 1, "the transport reports what core refused");
    assert.equal(propagated[0]?.level, "warn");
    assert.equal(propagated[0]?.err?.failure, failed[0]?.err?.failure);
    assert.equal(propagated[0]?.detail?.propagated, true);
  } finally {
    await stack.close();
  }
});
