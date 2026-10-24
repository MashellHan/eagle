// Ladder row 1-2: every committed fixture decodes without loss, and the encoder
// reproduces the snapshot fixture byte for byte. The fixtures are the only normative
// samples of the wire format (docs/bots/PROTOCOL.md#fixtures).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ConversationSnapshot } from "../../src/core/domain.ts";
import { encodeServerEvent, serialize } from "../../src/protocol/encode.ts";
import {
  type ClientCommand,
  decodeCommand,
  decodeServerEvent,
  parseJson,
  type ServerEvent,
} from "../../src/protocol/frames.ts";

const dir = new URL("../../../../fixtures/bots-protocol/", import.meta.url);
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort();
const read = (name: string) => JSON.parse(readFileSync(join(dir.pathname, name), "utf8"));

const clientFiles = files.filter((name) => name.endsWith(".client.json"));
const serverFiles = files.filter(
  (name) => name.endsWith(".server.json") && !name.startsWith("entities"),
);

test("the fixture set is complete and documented", () => {
  assert.ok(clientFiles.length >= 5, "client fixtures are missing");
  assert.ok(serverFiles.length >= 10, "server fixtures are missing");
  assert.ok(files.includes("entities.json"), "entity samples are missing");
});

for (const name of serverFiles) {
  test(`decodes and re-encodes ${name} without loss`, () => {
    const wire = read(name);
    const event = decodeServerEvent(wire) as ServerEvent;
    assert.equal(event.type, wire.type);
    assert.deepEqual(encodeServerEvent(event), wire);
  });
}

for (const name of clientFiles) {
  test(`decodes ${name}`, () => {
    const command = decodeCommand(read(name)) as ClientCommand;
    // hello and ping carry no trace by contract (docs/bots/OBSERVABILITY.md).
    if (command.type !== "hello" && command.type !== "ping") {
      assert.match(command.trace, /^[A-Za-z0-9_-]{8,64}$/);
    }
  });
}

test("the encoder reproduces snapshot.server.json byte for byte", () => {
  const wire = decodeServerEvent(read("snapshot.server.json")) as ServerEvent;
  assert.equal(wire.type, "snapshot");
  if (wire.type !== "snapshot") return;
  const snapshot: ConversationSnapshot = wire.value;
  const encoded = encodeServerEvent({
    type: "snapshot",
    rev: 42,
    trace: wire.trace ?? "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172",
    value: snapshot,
  });
  assert.equal(serialize(encoded as Record<string, unknown>), readText("snapshot.server.json"));
});

function readText(name: string): string {
  return readFileSync(join(dir.pathname, name), "utf8");
}

test("entity samples decode individually", () => {
  const entities = read("entities.json");
  const bot = decodeServerEvent({ type: "bots", bots: [entities.bot] }) as ServerEvent;
  assert.equal(bot.type, "bots");
  const append = decodeServerEvent({
    type: "append",
    rev: 1,
    trace: "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172",
    message: entities.message,
  }) as ServerEvent;
  assert.equal(append.type, "append");
});

test("JSON errors are distinguished from schema errors", () => {
  assert.throws(
    () => parseJson("{"),
    (error: Error & { reason?: string }) => error.reason === "invalid_json",
  );
  assert.throws(
    () => decodeServerEvent({ type: "nope" }),
    (error: Error & { reason?: string }) => error.reason === "invalid_event",
  );
});
