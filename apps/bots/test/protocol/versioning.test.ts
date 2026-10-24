// Ladder row 5: additive versioning. Unknown server events are ignorable but their
// revision is consumed; unknown commands are refused; a version the server does not
// speak is reported as such, not as a generic failure.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeCommand, decodeServerEvent } from "../../src/protocol/frames.ts";
import { validateCommand } from "../../src/protocol/validate.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

test("an unknown server event keeps its envelope so the revision is consumed", () => {
  const event = decodeServerEvent({
    type: "bot.presence.v2",
    rev: 44,
    trace,
    extra: { nested: true },
  });
  assert.deepEqual(event, { type: "unknown", rawType: "bot.presence.v2", rev: 44, trace });
});

test("an unknown event without an envelope is still ignorable", () => {
  assert.deepEqual(decodeServerEvent({ type: "future.notice" }), {
    type: "unknown",
    rawType: "future.notice",
  });
});

test("unknown fields on a known event are ignored, not preserved", () => {
  const event = decodeServerEvent({
    type: "status",
    rev: 7,
    trace,
    running: false,
    streaming: null,
    inbox: [],
    futureField: "dropped",
  });
  assert.equal(event.type, "status");
  assert.equal("futureField" in event, false);
});

test("an unknown command is refused rather than ignored", () => {
  assert.throws(
    () => decodeCommand({ type: "future.command", trace }),
    (error: Error & { reason?: string }) => error.reason === "invalid_command",
  );
});

test("a version the server does not speak is reported as version_mismatch", () => {
  assert.throws(
    () => validateCommand({ type: "hello", protocolVersion: 2, client: "BotsApp/0.1.0" }),
    (error: Error & { reason?: string }) => error.reason === "version_mismatch",
  );
  assert.equal(
    validateCommand({ type: "hello", protocolVersion: 1, client: "BotsApp/0.1.0" }).type,
    "hello",
  );
});

test("the handshake failure frame is parseable without a session", () => {
  const event = decodeServerEvent({
    type: "error",
    kind: "version_mismatch",
    message: "server speaks protocol 1",
    server: { protocolVersion: 1 },
  });
  assert.equal(event.type, "error");
  assert.equal(event.type === "error" && event.kind, "version_mismatch");
});
