import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { redact } from "../agent/collector.ts";
import { redactScreen } from "../agent/realtime.ts";

function medianRuntime(input: string, redactor = redactScreen) {
  redactor(input, []);
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    redactor(input, []);
    return performance.now() - start;
  });
  return samples.sort((left, right) => left - right)[2];
}

for (const [name, whitespace] of [
  ["spaces", " "],
  ["tabs", "\t"],
] as const) {
  test(`redaction scales linearly across long horizontal ${name}`, (context) => {
    const timings = [8192, 16384, 32768, 65536].map((length) => {
      const input = `Token${whitespace.repeat(length)}usage: 42;`;
      assert.equal(redactScreen(input, []), input);
      return medianRuntime(input);
    });
    context.diagnostic(
      `${name} 8k/16k/32k/64k ms: ${timings.map((time) => time.toFixed(2)).join(" / ")}`,
    );
    assert(timings[3] < 400, `64k ${name}: ${timings[3]}ms`);
    assert(
      timings[3] < Math.max(60, timings[2] * 3),
      `doubling ratio: ${timings[3] / timings[2]}`,
    );
  });
}

test("redaction scales across large full-screen frames", (context) => {
  const row =
    "Token usage: 42 total | Context window: 96% left | Ready for the next task.\n";
  const timings = [512, 1024].map((rows) => medianRuntime(row.repeat(rows)));
  context.diagnostic(
    `full-screen ${row.length * 512}/${row.length * 1024} characters ms: ${timings.map((time) => time.toFixed(2)).join(" / ")}`,
  );
  assert(timings[1] < 400, `large frame: ${timings[1]}ms`);
  assert(
    timings[1] < Math.max(60, timings[0] * 3),
    `doubling ratio: ${timings[1] / timings[0]}`,
  );
});

test("shared redaction handles repeated key words without an assignment", (context) => {
  const input = `${"TOKEN".repeat(410)}!`;
  const start = performance.now();
  assert.equal(redact(input, []), input);
  const elapsed = performance.now() - start;
  context.diagnostic(`repeated identifier 2k ms: ${elapsed.toFixed(2)}`);
  assert(elapsed < 400, `repeated identifier: ${elapsed}ms`);
});

test("shared redaction scans unterminated base64 line runs once", (context) => {
  const input = `${"Q".repeat(64)}\n`.repeat(4096);
  assert.equal(redact(input, []), input);
  const elapsed = medianRuntime(input, redact);
  context.diagnostic(`base64 lines 260k ms: ${elapsed.toFixed(2)}`);
  assert(elapsed < 400, `base64 lines: ${elapsed}ms`);
});
