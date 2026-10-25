// The fixture directory and the PROTOCOL.md table must agree exactly, and every
// entity sample must decode and re-encode. A skipped file is not a verified file.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { encodeServerEvent } from "../../src/protocol/encode.ts";
import { decodeServerEvent } from "../../src/protocol/frames.ts";

const fixturesDir = new URL("../../../../fixtures/bots-protocol/", import.meta.url).pathname;
const docsDir = new URL("../../../../docs/bots/", import.meta.url).pathname;
const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const documented = new Set(
  [...readFileSync(join(docsDir, "PROTOCOL.md"), "utf8").matchAll(/`([a-z0-9.-]+\.json)`/g)].map(
    (match) => match[1],
  ),
);
const present = readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));

test("the fixture directory matches the documented table", () => {
  assert.deepEqual([...documented].sort(), [...present].sort());
});

test("every entity sample decodes and re-encodes", () => {
  const entities = JSON.parse(readFileSync(join(fixturesDir, "entities.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  const frame = (payload: Record<string, unknown>) =>
    encodeServerEvent(decodeServerEvent(payload)) as Record<string, unknown>;

  assert.deepEqual(frame({ type: "bots", bots: [entities.bot] }).bots, [entities.bot]);
  assert.deepEqual(
    frame({ type: "append", rev: 1, trace, message: entities.message }).message,
    entities.message,
  );
  assert.deepEqual(
    frame({ type: "append", rev: 1, trace, message: entities.userMessage }).message,
    entities.userMessage,
  );
  assert.deepEqual(
    frame({ type: "append", rev: 1, trace, message: entities.toolCall }).message,
    entities.toolCall,
  );
  assert.deepEqual(
    frame({ type: "append", rev: 1, trace, message: entities.toolMessage }).message,
    entities.toolMessage,
  );
  const snapshot = frame({
    type: "snapshot",
    rev: 1,
    trace,
    value: {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [],
      inbox: [entities.inboxItem],
      running: false,
    },
  });
  assert.deepEqual((snapshot.value as Record<string, unknown>).inbox, [entities.inboxItem]);
});
