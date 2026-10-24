// Ladder row 6: log shape. Every record names its layer and event, failures carry a
// failure identity and are logged at error only by the originating layer, undeclared
// events cannot be emitted, and nothing sensitive reaches the sink.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EVENTS, isEventName, LAYERS, OUTCOMES } from "../../src/log/events.ts";
import { captureLog } from "../../src/log/log.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const failure = { id: "f_7", kind: "storage_failed" as const, layer: "core" as const };
const at = () => new Date("2026-10-25T02:11:03.412Z");

test("every declared event follows layer.subject.outcome", () => {
  for (const name of Object.keys(EVENTS)) {
    const parts = name.split(".");
    // `pi.*` mirrors upstream report names, so it carries no outcome of ours
    // (docs/bots/OBSERVABILITY.md, pi layer).
    if (parts[0] === "pi") {
      assert.ok(parts.length >= 2, `${name} is not pi.<subject>`);
      continue;
    }
    assert.ok(parts.length >= 3, `${name} is not layer.subject.outcome`);
    assert.ok((LAYERS as readonly string[]).includes(parts[0] ?? ""), `${name} has no known layer`);
    assert.ok(
      (OUTCOMES as readonly string[]).includes(parts.at(-1) ?? ""),
      `${name} has no known outcome`,
    );
  }
});

test("a record carries the documented fields", () => {
  const { log, records } = captureLog(at);
  const record = log.emit("info", "core", "core.submit.start", {
    trace,
    botId: "b_1",
    reqId: "r_1",
  });
  assert.deepEqual(record, {
    ts: "2026-10-25T02:11:03.412Z",
    level: "info",
    layer: "core",
    evt: "core.submit.start",
    trace,
    botId: "b_1",
    reqId: "r_1",
  });
  assert.equal(records.length, 1);
});

test("an undeclared event name is refused", () => {
  const { log } = captureLog(at);
  assert.equal(isEventName("core.submit.start"), true);
  assert.throws(
    () => log.emit("info", "core", "core.not.declared" as never, { trace }),
    /undeclared/,
  );
});

test("an event must belong to the layer that logs it", () => {
  const { log } = captureLog(at);
  assert.throws(() => log.emit("info", "core", "runtime.open.ok", { trace }), /does not belong/);
  // The pi layer is a layer like any other: an upstream report name cannot be
  // borrowed by core.
  assert.throws(() => log.emit("info", "core", "pi.report", { trace }), /does not belong/);
  assert.equal(
    log.emit("warn", "pi", "pi.report", { trace, failure, propagated: true }).layer,
    "pi",
  );
});

test("a failure event requires a failure identity", () => {
  const { log } = captureLog(at);
  assert.throws(
    () => log.emit("warn", "core", "core.submit.fail", { trace }),
    /requires a failure/,
  );
  const record = log.emit("warn", "core", "core.submit.fail", { trace, failure, propagated: true });
  assert.deepEqual(record.err, { kind: "storage_failed", failure: "f_7" });
  assert.equal(record.detail?.propagated, true);
});

test("only the originating layer logs at error", () => {
  const { log } = captureLog(at);
  assert.throws(
    () => log.emit("error", "core", "core.submit.fail", { trace, failure }),
    /only the originating layer/,
  );
  const record = log.emit("error", "core", "core.submit.fail", { trace, failure, origin: true });
  assert.deepEqual(record.err, { kind: "storage_failed", failure: "f_7", origin: true });
});

test("an error record must originate at the emitting layer", () => {
  const { log } = captureLog(at);
  const foreign = { id: "f_8", kind: "storage_failed" as const, layer: "runtime" as const };
  assert.throws(
    () => log.emit("error", "core", "core.submit.fail", { trace, failure: foreign, origin: true }),
    /must come from runtime/,
  );
});

test("classification and error records require a non-empty failure", () => {
  const { log } = captureLog(at);
  assert.throws(
    () => log.emit("info", "runtime", "runtime.failure.classify", { trace }),
    /requires a failure/,
  );
  assert.throws(
    () => log.emit("error", "core", "core.submit.start", { trace, origin: true }),
    /requires a failure/,
  );
  const empty = { id: "  ", kind: "internal" as const, layer: "core" as const };
  assert.throws(
    () => log.emit("warn", "core", "core.submit.fail", { trace, failure: empty }),
    /non-empty failure identity/,
  );
  assert.equal(
    log.emit("info", "runtime", "runtime.failure.classify", {
      trace,
      failure: { ...failure, layer: "runtime" },
      origin: true,
    }).level,
    "info",
  );
  // A non-error record cannot claim a foreign origin either.
  assert.throws(
    () => log.emit("info", "runtime", "runtime.failure.classify", { trace, failure, origin: true }),
    /must come from core/,
  );
});

test("detail keys are declared per event", () => {
  const { log } = captureLog(at);
  assert.throws(
    () => log.emit("info", "core", "core.hub.publish.ok", { trace, detail: { surprise: 1 } }),
    /not declared for core\.hub\.publish\.ok/,
  );
  // A key declared for another event is not available here.
  assert.throws(
    () => log.emit("info", "core", "core.hub.publish.ok", { trace, detail: { providerCode: "x" } }),
    /not declared/,
  );
  assert.throws(
    () => log.emit("info", "core", "core.hub.publish.ok", { trace, detail: { count: "text" } }),
    /must be a number/,
  );
  assert.throws(
    () => log.emit("info", "core", "core.hub.publish.ok", { trace, detail: { count: Number.NaN } }),
    /finite number/,
  );
  assert.throws(
    () => log.emit("info", "core", "core.hub.publish.ok", { trace, detail: { count: -1 } }),
    /non-negative integer/,
  );
  const record = log.emit("warn", "runtime", "runtime.submit.fail", {
    trace,
    failure,
    propagated: true,
    detail: { providerCode: "rate_limited", reason: "upstream" },
  });
  assert.deepEqual(record.detail, {
    providerCode: "rate_limited",
    reason: "upstream",
    propagated: true,
  });
});

test("secrets and home paths never reach a record", () => {
  const { log, records } = captureLog(at);
  process.env.BOTS_API_KEY = "sk-live-abcdefghijklmnop";
  try {
    log.emit("warn", "runtime", "runtime.watch.end.ok", {
      trace,
      detail: { reason: `failed for ${process.env.HOME}/bots with sk-live-abcdefghijklmnop` },
    });
    log.emit("info", "core", "core.hub.publish.ok", { trace, detail: { messageId: "hello" } });
  } finally {
    delete process.env.BOTS_API_KEY;
  }
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("sk-live-abcdefghijklmnop"), false);
  assert.equal(serialized.includes(process.env.HOME ?? "unlikely-home"), false);
  assert.equal(serialized.includes("hello"), true, "declared string details survive redaction");
  assert.equal(records[0]?.detail?.reason, "failed for ~/bots with [redacted]");
});

// Scan a source file for an emit call that passes a literal instead of an Events.*
// constant. Dotted strings that are not emit arguments (an entry kind such as
// "pi.user") are none of this test's business.
const literalEmitIn = (source: string): string[] => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const matches: string[] = [];
  const call = /\.emit\(([\s\S]{0,240}?)\)/g;
  for (const match of code.matchAll(call)) {
    const args = match[1] ?? "";
    if (/["'`](transport|protocol|core|runtime|pi)\.[a-z0-9_.]+["'`]/.test(args)) {
      matches.push(args.trim());
    }
  }
  return matches;
};

test("no emit call passes a literal event name", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  for (const file of walk("src")) {
    if (file.endsWith("log/events.ts")) continue;
    const offenders = literalEmitIn(readFileSync(file, "utf8"));
    assert.deepEqual(offenders, [], `${file} passes an event literal; use Events.* constants`);
  }
});

test("the scan accepts a dotted non-log string and rejects a literal emit", () => {
  assert.deepEqual(literalEmitIn('const kind = "pi.user";'), []);
  assert.deepEqual(
    literalEmitIn(
      'export const emit = (log: Log) => log.emit("info", "core", "core.submit.typo", { trace });',
    ).length,
    1,
  );
});
