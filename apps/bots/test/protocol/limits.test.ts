// Ladder row 4: limits. Text is capped in code points; every outbound frame is capped
// in encoded bytes, page and entity budgets are derived from the payload, and the
// inbound cap is measured before parsing.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, Message } from "../../src/core/domain.ts";
import { encodeServerEvent } from "../../src/protocol/encode.ts";
import { decodeCommand } from "../../src/protocol/frames.ts";
import {
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_SEND_TEXT,
  PAGE_MAX_BYTES,
  PAGE_MAX_MESSAGES,
} from "../../src/protocol/limits.ts";
import {
  assertFrameBudget,
  assertInboundBytes,
  measureFrame,
  validateCommand,
} from "../../src/protocol/validate.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";
const text = (length: number) => "x".repeat(length);
const denied = (reason: string) => (error: Error & { reason?: string }) => {
  assert.equal(error.reason, reason);
  return true;
};

test("text at the cap is accepted and one character more is not", () => {
  const atCap = decodeCommand({ type: "send", requestId, text: text(MAX_SEND_TEXT), trace });
  assert.equal(validateCommand(atCap).type, "send");
  const overCap = decodeCommand({ type: "send", requestId, text: text(MAX_SEND_TEXT + 1), trace });
  // The contract classifies an over-long send as an invalid command, not as a budget.
  assert.throws(() => validateCommand(overCap), denied("invalid_command"));
});

test("an inbound frame is capped by the bytes that arrived, not by the parsed shape", () => {
  const padded = `{"type":"ping"}${" ".repeat(MAX_FRAME_BYTES)}`;
  assert.ok(Buffer.byteLength(padded, "utf8") > MAX_FRAME_BYTES);
  assert.throws(() => assertInboundBytes(padded), denied("limit_exceeded"));
  assert.ok(assertInboundBytes('{"type":"ping"}') > 0);
});

const message = (bytes: number, id = "e_1"): Message => ({
  id,
  role: "assistant",
  state: "complete",
  createdAt: "2026-10-25T02:11:04.001Z",
  blocks: [{ type: "text", text: text(bytes) }],
});

const snapshot = (messages: readonly Message[]): Record<string, unknown> =>
  encodeServerEvent({
    type: "snapshot",
    rev: 1,
    trace,
    value: {
      botId: "b_0190a1b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b",
      messages,
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    } satisfies ConversationSnapshot,
  }) as Record<string, unknown>;

test("a frame above the cap is refused before it is written", () => {
  const frame = snapshot([message(MAX_FRAME_BYTES)]);
  assert.ok(measureFrame(frame) > MAX_FRAME_BYTES);
  assert.throws(() => assertFrameBudget(frame), denied("limit_exceeded"));
});

test("a frame at or below the cap is allowed and measured as encoded", () => {
  const frame = snapshot([message(1024)]);
  assert.ok(measureFrame(frame) <= MAX_FRAME_BYTES);
  assert.equal(assertFrameBudget(frame), Buffer.byteLength(JSON.stringify(frame), "utf8"));
});

test("a page under the frame cap but over the page budget is refused", () => {
  const per = Math.floor(PAGE_MAX_BYTES / 3);
  const frame = snapshot([message(per, "e_1"), message(per, "e_2"), message(per, "e_3")]);
  assert.ok(measureFrame(frame) < MAX_FRAME_BYTES);
  assert.throws(() => assertFrameBudget(frame), denied("limit_exceeded"));
});

test("the page budget counts messages without trusting a caller hint", () => {
  const messages = Array.from({ length: PAGE_MAX_MESSAGES + 1 }, (_, index) =>
    message(16, `e_${index}`),
  );
  assert.throws(() => assertFrameBudget(snapshot(messages)), denied("limit_exceeded"));
});

test("a single message above the inline budget is refused even when alone", () => {
  const frame = snapshot([message(MAX_MESSAGE_BYTES + 1024)]);
  assert.ok(measureFrame(frame) < MAX_FRAME_BYTES);
  assert.throws(() => assertFrameBudget(frame), denied("limit_exceeded"));
});

test("the catalog budget is per encoded bot summary", () => {
  const bot = {
    id: "b_0190a1b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b",
    // 200 control characters escape to six bytes each: 1200 encoded bytes on their own.
    title: "\u0001".repeat(200),
    createdAt: "2026-10-25T02:11:03.412Z",
    updatedAt: "2026-10-25T02:11:03.412Z",
    model: { provider: "magpie", modelId: "auto/gpt-6-luna" },
    state: "idle" as const,
  };
  const frame = encodeServerEvent({ type: "bots", bots: [bot] }) as Record<string, unknown>;
  // Control characters escape to six bytes each, so 80 of them exceed 1200 encoded.
  assert.throws(() => assertFrameBudget(frame), denied("limit_exceeded"));
});

test("the inline message budget applies wherever a message is carried", () => {
  const big = message(MAX_MESSAGE_BYTES + 1024);
  const appendFrame = encodeServerEvent({
    type: "append",
    rev: 1,
    trace,
    message: big,
  }) as Record<string, unknown>;
  assert.throws(() => assertFrameBudget(appendFrame), denied("limit_exceeded"));

  const deltaFrame = encodeServerEvent({
    type: "delta",
    rev: 1,
    trace,
    messageId: "p_a1",
    changes: [{ kind: "message", message: big }],
  }) as Record<string, unknown>;
  assert.throws(() => assertFrameBudget(deltaFrame), denied("limit_exceeded"));
});

test("pending and inbox are capped", () => {
  const pending = Array.from({ length: 33 }, (_, index) => ({
    requestId: `r_${String(index).padStart(8, "0")}`,
    submissionId: `s_${index}`,
    status: "queued" as const,
  }));
  const frame = snapshot([]) as { value: Record<string, unknown> };
  frame.value.pending = pending;
  assert.throws(() => assertFrameBudget(frame), denied("limit_exceeded"));
});
