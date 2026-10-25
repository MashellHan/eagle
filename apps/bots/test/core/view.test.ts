// The projected view's trimming rule (docs/bots/PROTOCOL.md, "snapshot.messages page"):
// a page that drops a message must not leave a pointer to it behind.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, Message } from "../../src/core/domain.ts";
import { trimWindow } from "../../src/core/view.ts";

const message = (id: string, state: Message["state"] = "complete"): Message => ({
  id,
  role: state === "streaming" ? "assistant" : "user",
  state,
  createdAt: "x",
  blocks: [{ type: "text", text: id }],
});

const view = (messages: Message[], streaming: string | null): ConversationSnapshot => ({
  botId: "b_1",
  messages,
  streaming,
  pending: [],
  inbox: [],
  running: true,
});

const measure = () => 10;

test("a trimmed page clears a streaming pointer whose message fell out", () => {
  const narrow = trimWindow(
    view([message("p_a1", "streaming"), message("e_2")], "p_a1"),
    1,
    measure,
  );
  assert.deepEqual(
    narrow.messages.map((item) => item.id),
    ["e_2"],
  );
  assert.equal(narrow.streaming, null, "streaming must name a message the page still holds");

  const kept = trimWindow(view([message("p_a1", "streaming"), message("e_2")], "p_a1"), 2, measure);
  assert.equal(kept.streaming, "p_a1");

  const older = trimWindow(
    view([message("e_1"), message("p_a1", "streaming")], "p_a1"),
    1,
    measure,
  );
  assert.deepEqual(
    older.messages.map((item) => item.id),
    ["p_a1"],
  );
  assert.equal(older.streaming, "p_a1", "dropping an older message leaves the pointer alone");
});

test("the byte budget trims the same way as the count", () => {
  const trimmed = trimWindow(
    view([message("p_a1", "streaming"), message("e_2"), message("e_3")], "p_a1"),
    10,
    measure,
    25,
  );
  assert.deepEqual(
    trimmed.messages.map((item) => item.id),
    ["e_2", "e_3"],
  );
  assert.equal(trimmed.streaming, null);
  assert.equal(trimmed.truncatedBefore, undefined, "a dropped provisional is not a paging cursor");
});
