// Ladder row 3: command validation. A frame that reaches core must carry what the
// contract requires; everything else is refused before dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeCommand } from "../../src/protocol/frames.ts";
import { validateCommand } from "../../src/protocol/validate.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const refuses = (wire: Record<string, unknown>, reason: string) => {
  assert.throws(
    () => validateCommand(decodeCommand(wire)),
    (error: Error & { reason?: string }) => {
      assert.equal(error.reason, reason);
      return true;
    },
  );
};

test("accepts a well-formed send", () => {
  const command = decodeCommand({ type: "send", requestId, text: "hi", trace });
  assert.equal(validateCommand(command).type, "send");
});

test("refuses a send without a requestId", () => {
  refuses({ type: "send", text: "hi", trace }, "invalid_command");
});

test("refuses a send without a trace", () => {
  refuses({ type: "send", requestId, text: "hi" }, "invalid_command");
});

test("refuses a malformed requestId and trace", () => {
  refuses({ type: "send", requestId: "short", text: "hi", trace }, "invalid_command");
  refuses({ type: "send", requestId, text: "hi", trace: "has space" }, "invalid_command");
  refuses({ type: "send", requestId: "r".repeat(65), text: "hi", trace }, "invalid_command");
});

test("refuses an unknown or malformed botId", () => {
  refuses({ type: "subscribe", botId: "", trace }, "invalid_command");
  refuses({ type: "subscribe", botId: "b/1", trace }, "invalid_command");
});

test("refuses a history request outside the page limits", () => {
  refuses({ type: "history", before: "e_1", limit: 0, trace }, "invalid_command");
  refuses({ type: "history", before: "e_1", limit: 201, trace }, "invalid_command");
});

test("refuses an unknown command without pretending it was valid", () => {
  refuses({ type: "nope", trace }, "invalid_command");
});

test("hello and ping need no trace but hello needs a supported version", () => {
  assert.equal(
    validateCommand(decodeCommand({ type: "hello", protocolVersion: 1, client: "x" })).type,
    "hello",
  );
  assert.equal(validateCommand(decodeCommand({ type: "ping" })).type, "ping");
  refuses({ type: "hello", protocolVersion: 2, client: "x" }, "version_mismatch");
});
