// Ladder row 7: content never reaches a log record. The wire may carry message text,
// bot titles and provider details; a log record may carry none of them, and every
// credential the process knows is scrubbed.
import assert from "node:assert/strict";
import test from "node:test";
import { declareEvent } from "../../src/log/events.ts";
import { captureLog } from "../../src/log/log.ts";
import { startStack } from "../support/server.ts";

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
  // The two string details that are not ids accept codes only, so echoed content
  // cannot smuggle itself in through a declared key.
  for (const detail of [
    { reason: `provider echoed ${providerSentinel}` },
    { providerCode: `provider rejected ${providerSentinel}` },
  ]) {
    assert.throws(
      () =>
        log.emit("warn", "runtime", declareEvent("runtime.submit.fail"), {
          trace,
          failure: { ...failure, layer: "runtime" },
          detail,
        }),
      /must be a (known code|short code)/,
    );
  }
});

test("a bot title reaches the wire and stays out of every log record", async () => {
  // The real path: create and rename over HTTP with a title sentinel, then look at every
  // record the daemon wrote while the title crossed it.
  const stack = await startStack();
  try {
    const before = stack.records.length;
    const created = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: titleSentinel, label: `${titleSentinel} 标签` }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { bot: { id: string; title: string } };
    assert.equal(body.bot.title, titleSentinel, "the title is carried on the wire");
    const renamed = await fetch(`http://127.0.0.1:${stack.port}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: `${titleSentinel} 2` }),
    });
    assert.equal(renamed.status, 200);
    const records = stack.records.slice(before);
    assert.ok(records.length > 0, "the requests were recorded");
    assert.equal(
      JSON.stringify(records).includes(titleSentinel),
      false,
      "a title is user content, so only ids, counts and enums reach a log",
    );
  } finally {
    await stack.close();
  }
});
