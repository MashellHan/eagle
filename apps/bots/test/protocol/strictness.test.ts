// Negative cases for the wire contract: required fields, closed unions and the
// one-of-two error shapes. A decoder that accepts these would let a broken daemon or
// client look healthy.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeCommand, decodeServerEvent } from "../../src/protocol/frames.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const invalidEvent = (wire: Record<string, unknown>) => {
  assert.throws(
    () => decodeServerEvent(wire),
    (error: Error & { reason?: string }) => error.reason === "invalid_event",
  );
};
const invalidCommand = (wire: Record<string, unknown>) => {
  assert.throws(
    () => decodeCommand(wire),
    (error: Error & { reason?: string }) => error.reason === "invalid_command",
  );
};

const sessionError = (extra: Record<string, unknown> = {}) => ({
  type: "error",
  trace,
  kind: "storage_failed",
  failure: "f_7",
  disposition: "runtime",
  message: "boom",
  ...extra,
});

test("a session error requires trace, failure and disposition", () => {
  assert.equal(decodeServerEvent(sessionError()).type, "error");
  invalidEvent(sessionError({ failure: undefined }));
  invalidEvent(sessionError({ disposition: undefined }));
  invalidEvent({ ...sessionError(), trace: undefined });
  invalidEvent(sessionError({ disposition: "maybe" }));
  invalidEvent(sessionError({ kind: "made_up" }));
});

test("the handshake error carries server and no disposition", () => {
  const handshake = {
    type: "error",
    kind: "version_mismatch",
    message: "server speaks protocol 1",
    server: { protocolVersion: 1 },
  };
  assert.equal(decodeServerEvent(handshake).type, "error");
  invalidEvent({ ...handshake, server: undefined });
  invalidEvent({ ...handshake, disposition: "runtime" });
});

test("required event fields are not defaulted", () => {
  const status = { type: "status", rev: 1, trace, running: true, inbox: [] };
  invalidEvent(status); // streaming is required, null or a string
  assert.equal(decodeServerEvent({ ...status, streaming: null }).type, "status");
  invalidEvent({ type: "history", trace }); // messages and hasMore are required
  invalidEvent({ type: "snapshot", rev: 1, trace, value: {} });
  invalidEvent({ type: "append", trace, message: { id: "e_1" } }); // rev required
});

test("a snapshot's streaming id must be one of its messages", () => {
  const value = {
    botId: "b_1",
    messages: [],
    streaming: { messageId: "p_a1" },
    pending: [],
    inbox: [],
    running: true,
  };
  invalidEvent({ type: "snapshot", rev: 1, trace, value });
  assert.equal(
    decodeServerEvent({
      ...{ type: "snapshot", rev: 1, trace },
      value: { ...value, streaming: null },
    }).type,
    "snapshot",
  );
});

test("submission fields must agree with the status", () => {
  const base = { type: "submission", trace, requestId, submissionId: "s_1" };
  assert.equal(decodeServerEvent({ ...base, status: "queued" }).type, "submission");
  for (const status of ["placed", "done", "unanswered"]) {
    invalidEvent({ ...base, status }); // these need their own fields
  }
  assert.equal(
    decodeServerEvent({ ...base, status: "done", entryId: "e_1", answerEntryId: "e_2" }).type,
    "submission",
  );
  invalidEvent({ ...base, status: "done", entryId: "e_1" });
  invalidEvent({ ...base, status: "unanswered", answerEntryId: "e_2", reason: "aborted" });
});

test("delta indexes and paths are validated", () => {
  const frame = { type: "delta", rev: 1, trace, messageId: "p_a1" };
  invalidEvent({ ...frame, changes: [{ kind: "text", index: -1, append: "x" }] });
  invalidEvent({ ...frame, changes: [{ kind: "text", index: 1.5, append: "x" }] });
  invalidEvent({
    ...frame,
    changes: [{ kind: "toolcall", index: 0, callId: "c", path: [{}], append: "x" }],
  });
  assert.equal(
    decodeServerEvent({ ...frame, changes: [{ kind: "text", index: 0, append: "x" }] }).type,
    "delta",
  );
});

test("requestId belongs to user messages only", () => {
  const message = {
    id: "e_1",
    role: "assistant",
    state: "complete",
    createdAt: "2026-10-25T02:11:04.001Z",
    blocks: [],
    requestId,
  };
  invalidEvent({ type: "append", rev: 1, trace, message });
});

test("unknown fields are tolerated but unknown events and commands are not", () => {
  const append = {
    type: "append",
    rev: 1,
    trace,
    message: { id: "e_1", role: "user", state: "complete", createdAt: "x", blocks: [], requestId },
    futureField: "ignored",
  };
  assert.equal(decodeServerEvent(append).type, "append");
  invalidEvent({ type: "future_event" });
  invalidCommand({ type: "future_command", trace });
});

test("an explicit null whenBusy is a client bug, not a default", () => {
  invalidCommand({ type: "send", requestId, text: "hi", trace, whenBusy: null });
  assert.equal(
    decodeCommand({ type: "send", requestId, text: "hi", trace, whenBusy: "steer" }).type,
    "send",
  );
});
