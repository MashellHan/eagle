// Independent expectations. The round-trip test proves the two directions agree with
// each other; this file pins the actual values, so a decoder and encoder that share a
// mistake still fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ConversationSnapshot } from "../../src/core/domain.ts";
import { encodeServerEvent } from "../../src/protocol/encode.ts";
import { decodeCommand, decodeServerEvent } from "../../src/protocol/frames.ts";
import { MAX_FRAME_BYTES, MAX_MESSAGE_BYTES, PAGE_MAX_BYTES } from "../../src/protocol/limits.ts";
import { assertFrameBudget, validateCommand } from "../../src/protocol/validate.ts";

const dir = new URL("../../../../fixtures/bots-protocol/", import.meta.url).pathname;
const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("a decoded snapshot carries the documented values", () => {
  const event = decodeServerEvent(read("snapshot.streaming.server.json"));
  assert.equal(event.type, "snapshot");
  if (event.type !== "snapshot") return;
  assert.equal(event.rev, 47);
  assert.equal(event.value.botId, "b_0190a1b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b");
  assert.equal(event.value.streaming, "p_a2");
  assert.equal(event.value.running, true);
  assert.equal(event.value.truncatedBefore, "e_10");
  assert.deepEqual(
    event.value.messages.map((m) => [m.id, m.role, m.state]),
    [
      ["e_10", "assistant", "complete"],
      ["p_a2", "assistant", "streaming"],
    ],
  );
  assert.equal(
    event.value.messages[1]?.blocks[0]?.type === "text"
      ? event.value.messages[1].blocks[0].text
      : "",
    "巴黎是法国的",
  );
  assert.equal(
    event.value.messages[0]?.blocks[0]?.type === "text"
      ? event.value.messages[0].blocks[0].text
      : "",
    "巴黎。",
  );
  assert.equal(event.value.pending[0]?.status, "placed");
  assert.equal(event.value.pending[0]?.entryId, "e_7");
  assert.deepEqual(event.value.inbox, [{ id: "s_4", mode: "followUp" }]);
});

test("a decoded delta keeps its indexes and the whole message replacement", () => {
  const event = decodeServerEvent(read("delta.server.json"));
  assert.equal(event.type, "delta");
  if (event.type !== "delta") return;
  assert.deepEqual(
    event.changes.map((change) => change.kind),
    ["text", "block", "message"],
  );
  const [text, block, message] = event.changes;
  assert.deepEqual(text, { kind: "text", index: 0, append: "首都" });
  assert.deepEqual(block, {
    kind: "block",
    index: 0,
    block: { type: "text", text: "巴黎是法国的首都" },
  });
  assert.equal(message?.kind === "message" ? message.message.id : "", "p_a2");
  assert.equal(
    message?.kind === "message" && message.message.blocks[0]?.type === "text"
      ? message.message.blocks[0].text
      : "",
    "巴黎是法国的首都",
  );
});

test("a decoded submission separates the entry from the answer", () => {
  const event = decodeServerEvent(read("submission.server.json"));
  assert.equal(event.type, "submission");
  if (event.type !== "submission") return;
  assert.deepEqual(event.record, {
    id: "s_3",
    requestId: "r_0190a1b4-5061-7c72-8d3e-4f5061728394",
    status: "done",
    entryId: "e_7",
    answerEntryId: "e_10",
  });
});

test("a decoded session error carries its identity and disposition", () => {
  const event = decodeServerEvent(read("error.server.json"));
  assert.equal(event.type, "error");
  if (event.type !== "error" || event.kind === "version_mismatch") return;
  assert.equal(event.kind, "task_parked");
  assert.equal(event.disposition, "runtime");
  assert.equal(event.failure, "f_7f3a");
  assert.equal(event.requestId, "r_0190a1b4-5061-7c72-8d3e-4f5061728394");
});

test("the encoder writes the documented wire object for an independently built snapshot", () => {
  const value: ConversationSnapshot = {
    botId: "b_1",
    messages: [
      {
        id: "e_1",
        role: "user",
        state: "complete",
        createdAt: "2026-10-25T02:11:04.001Z",
        blocks: [{ type: "text", text: "hi" }],
        requestId: "r_0190a1b4-5061-7c72-8d3e-4f5061728394",
      },
    ],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  assert.deepEqual(encodeServerEvent({ type: "snapshot", rev: 3, trace, value }), {
    type: "snapshot",
    rev: 3,
    trace,
    value: {
      botId: "b_1",
      messages: [
        {
          id: "e_1",
          role: "user",
          state: "complete",
          createdAt: "2026-10-25T02:11:04.001Z",
          blocks: [{ type: "text", text: "hi" }],
          requestId: "r_0190a1b4-5061-7c72-8d3e-4f5061728394",
        },
      ],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
  });
});

const snapshotOf = (
  messages: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) =>
  encodeServerEvent({
    type: "snapshot",
    rev: 1,
    trace,
    value: {
      botId: "b_1",
      messages,
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
      ...extra,
    } as unknown as ConversationSnapshot,
  }) as Record<string, unknown>;

const message = (bytes: number, id: string) => ({
  id,
  role: "assistant",
  state: "complete",
  createdAt: "2026-10-25T02:11:04.001Z",
  blocks: [{ type: "text", text: "x".repeat(bytes) }],
});

test("a frame that only violates the frame cap is refused", () => {
  // A delta has no page or single-message budget, so only the frame cap can refuse it.
  const changes = Array.from({ length: 9_000 }, () => ({
    kind: "text" as const,
    index: 0,
    append: "x".repeat(32),
  }));
  const frame = encodeServerEvent({
    type: "delta",
    rev: 1,
    trace,
    messageId: "p_a1",
    changes,
  }) as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  assert.ok(bytes > MAX_FRAME_BYTES, `frame must exceed the cap, got ${bytes}`);
  assert.throws(
    () => assertFrameBudget(frame),
    (error: Error & { reason?: string }) => error.reason === "limit_exceeded",
  );
});

test("a page that only violates the page budget is refused", () => {
  const per = Math.ceil(PAGE_MAX_BYTES / 3) + 100;
  assert.ok(per < MAX_MESSAGE_BYTES);
  const frame = snapshotOf([message(per, "e_1"), message(per, "e_2"), message(per, "e_3")]);
  assert.throws(
    () => assertFrameBudget(frame),
    (error: Error & { reason?: string }) => error.reason === "limit_exceeded",
  );
});

test("a message that only violates the message budget is refused", () => {
  const frame = snapshotOf([message(MAX_MESSAGE_BYTES + 100, "e_1")]);
  assert.throws(
    () => assertFrameBudget(frame),
    (error: Error & { reason?: string }) => error.reason === "limit_exceeded",
  );
});

test("every client fixture passes decode and validation", () => {
  for (const name of [
    "hello",
    "subscribe",
    "send",
    "abort",
    "recover",
    "resync",
    "history",
    "ping",
  ]) {
    validateCommand(decodeCommand(read(`${name}.client.json`)));
  }
});
