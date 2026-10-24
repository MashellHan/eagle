// Ladder row 7: content never reaches a log record. The wire may carry message text,
// bot titles and provider details; a log record may carry none of them, and every
// credential the process knows is scrubbed.
import assert from "node:assert/strict";
import test from "node:test";
import { declareEvent } from "../../src/log/events.ts";
import { captureLog } from "../../src/log/log.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const failure = { id: "f_7", kind: "storage_failed" as const, layer: "core" as const };
const at = () => new Date("2026-10-25T02:11:03.412Z");

const promptSentinel = "PROMPT-SENTINEL-42";
const providerSentinel = "PROVIDER-SENTINEL-42";
const titleSentinel = "TITLE-SENTINEL-42";
const tokenSentinel = "tok-live-0123456789abcdef";

test("the daemon token is scrubbed from every field, not only from the API key", () => {
  const { log, records } = captureLog(at, { secrets: () => [tokenSentinel] });
  log.emit("info", "core", declareEvent("core.hub.publish.ok"), {
    trace: `${trace}-${tokenSentinel}`,
    botId: tokenSentinel,
    detail: { messageId: tokenSentinel },
  });
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(tokenSentinel), false);
  assert.equal(records[0]?.detail?.messageId, "[redacted]");
});

test("message text, a prompt and a bot title have no field to travel in", () => {
  const { log, records } = captureLog(at);
  log.emit("info", "core", declareEvent("core.hub.publish.ok"), {
    trace,
    detail: { messageId: "e_1" },
  });
  const serialized = JSON.stringify(records);
  for (const sentinel of [promptSentinel, titleSentinel, providerSentinel]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  // There is no detail key for free text, so an attempt is a shape error.
  for (const key of ["text", "title", "providerMessage", "instructions"]) {
    assert.throws(
      () =>
        log.emit("info", "core", declareEvent("core.hub.publish.ok"), {
          trace,
          detail: { [key]: promptSentinel },
        }),
      /not declared/,
    );
  }
});

test("a provider error is reduced to a code, never to its text", () => {
  const { log, records } = captureLog(at);
  const record = log.emit("warn", "runtime", declareEvent("runtime.submit.fail"), {
    trace,
    failure: { ...failure, layer: "runtime", kind: "model_error" },
    detail: { providerCode: "rate_limited" },
  });
  assert.deepEqual(record.detail, { providerCode: "rate_limited" });
  assert.equal(JSON.stringify(records).includes(providerSentinel), false);
  assert.throws(
    () =>
      log.emit("warn", "runtime", declareEvent("runtime.submit.fail"), {
        trace,
        failure: { ...failure, layer: "runtime" },
        detail: { message: `${providerSentinel} echoed ${promptSentinel}` },
      }),
    /not declared for runtime.submit.fail/,
  );
});

test("a bot title on the wire stays out of the log even when a caller passes it", () => {
  const { log, records } = captureLog(at);
  // The title is user content: the id is the only thing a log may carry.
  log.emit("info", "core", declareEvent("core.submit.ok"), {
    trace,
    botId: "b_1",
    detail: { queued: false },
  });
  assert.equal(JSON.stringify(records).includes(titleSentinel), false);
});
