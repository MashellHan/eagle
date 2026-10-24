// Ladder row 4: limits. Text is capped in characters; every outbound frame is capped
// in encoded bytes, measured with the same encoder that builds it.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, Message } from "../../src/core/domain.ts";
import { encodeServerEvent, serialize } from "../../src/protocol/encode.ts";
import { decodeCommand } from "../../src/protocol/frames.ts";
import { MAX_FRAME_BYTES, MAX_SEND_TEXT, PAGE_MAX_MESSAGES } from "../../src/protocol/limits.ts";
import { assertFrameBytes, measureFrame, validateCommand } from "../../src/protocol/validate.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const text = (length: number) => "x".repeat(length);

test("text at the cap is accepted and one character more is not", () => {
  const atCap = decodeCommand({ type: "send", requestId, text: text(MAX_SEND_TEXT), trace });
  assert.equal(validateCommand(atCap).type, "send");
  const overCap = decodeCommand({ type: "send", requestId, text: text(MAX_SEND_TEXT + 1), trace });
  assert.throws(
    () => validateCommand(overCap),
    (error: Error & { reason?: string }) => error.reason === "limit_exceeded",
  );
});

const message = (bytes: number): Message => ({
  id: "e_1",
  role: "assistant",
  state: "complete",
  createdAt: "2026-10-25T02:11:04.001Z",
  blocks: [{ type: "text", text: text(bytes) }],
});

const snapshot = (messages: readonly Message[]): ConversationSnapshot => ({
  botId: "b_0190a1b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b",
  messages,
  streaming: null,
  pending: [],
  inbox: [],
  running: false,
});

test("a frame above the cap is refused before it is written", () => {
  const frame = encodeServerEvent({
    type: "snapshot",
    rev: 1,
    trace,
    value: snapshot([message(MAX_FRAME_BYTES)]),
  });
  assert.ok(measureFrame(frame) > MAX_FRAME_BYTES);
  assert.throws(
    () => assertFrameBytes(frame),
    (error: Error & { reason?: string }) => error.reason === "limit_exceeded",
  );
});

test("a frame at or below the cap is allowed and measured as encoded", () => {
  const frame = encodeServerEvent({
    type: "snapshot",
    rev: 1,
    trace,
    value: snapshot([message(1024)]),
  });
  assert.ok(measureFrame(frame) <= MAX_FRAME_BYTES);
  assert.equal(assertFrameBytes(frame), measureFrame(frame));
  assert.equal(measureFrame(frame), Buffer.byteLength(serialize(frame), "utf8"));
});

test("the page budget counts messages and bytes", () => {
  const messages = Array.from({ length: PAGE_MAX_MESSAGES + 1 }, (_, index) => ({
    ...message(16),
    id: `e_${index}`,
  }));
  const frame = encodeServerEvent({ type: "snapshot", rev: 1, trace, value: snapshot(messages) });
  assert.throws(
    () => assertFrameBytes(frame, { messages: messages.length }),
    (error: Error & { reason?: string }) => error.reason === "limit_exceeded",
  );
});
