// The adapter measures messages itself, so its budgets must stay the wire's budgets
// (docs/bots/PROTOCOL.md#limits). The adapter may not import the wire layer, so this test
// is the only thing holding the two numbers together.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MESSAGE_BYTES,
  MAX_NOTICE_BYTES,
  PAGE_MAX_MESSAGES,
} from "../../src/protocol/limits.ts";
import {
  MAX_MESSAGE_BYTES as ADAPTER_MESSAGE_BYTES,
  OVERSIZED_NOTICE,
  WINDOW_MESSAGES,
} from "../../src/runtime/pi/limits.ts";

test("the adapter's budgets are the wire's budgets", () => {
  assert.equal(ADAPTER_MESSAGE_BYTES, MAX_MESSAGE_BYTES);
  assert.equal(WINDOW_MESSAGES, PAGE_MAX_MESSAGES);
  const notice = new TextEncoder().encode(
    JSON.stringify({ type: "text", text: OVERSIZED_NOTICE }),
  ).length;
  assert.ok(notice <= MAX_NOTICE_BYTES, "the notice fits the notice budget");
  assert.equal(OVERSIZED_NOTICE, "回答超出传输上限", "PROTOCOL.md fixes the text");
});
