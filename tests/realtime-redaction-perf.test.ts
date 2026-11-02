import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { type TestContext, test } from "node:test";
import { redact } from "../packages/agent/collector.ts";
import { redactScreen, terminalScreen } from "../packages/agent/realtime.ts";

function medianRuntimes(
  inputs: string[],
  context: TestContext,
  redactor: (input: string, secrets: string[]) => unknown = redactScreen,
) {
  for (const input of inputs) redactor(input, []);
  const samples: number[][] = inputs.map(() => []);
  const orders: number[][] = [];
  for (let round = 0; round < 5; round++) {
    const order = inputs.map((_, index) => index);
    if (round % 2) order.reverse();
    orders.push(order);
    for (const index of order) {
      const start = performance.now();
      redactor(inputs[index], []);
      samples[index].push(performance.now() - start);
    }
  }
  context.diagnostic(JSON.stringify({ orders, wallSamplesMs: samples }));
  return samples.map((values) => values.sort((left, right) => left - right)[2]);
}

for (const [name, whitespace] of [
  ["spaces", " "],
  ["tabs", "\t"],
] as const) {
  test(`redaction scales linearly across long horizontal ${name}`, (context) => {
    const inputs = [8192, 16384, 32768, 65536].map(
      (length) => `Token${whitespace.repeat(length)}usage: 42;`,
    );
    for (const input of inputs) assert.equal(redactScreen(input, []), input);
    const timings = medianRuntimes(inputs, context);
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
  const timings = medianRuntimes(
    [512, 1024].map((rows) => row.repeat(rows)),
    context,
  );
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
  const elapsed = medianRuntimes([input], context, redact)[0];
  context.diagnostic(`base64 lines 260k ms: ${elapsed.toFixed(2)}`);
  assert(elapsed < 400, `base64 lines: ${elapsed}ms`);
});

test("styled redaction scales across repeated lowercase bearer prefixes", (context) => {
  const timings = medianRuntimes(
    [8192, 16384].map(
      (rows) => `\u001b[32m${"bearer fixture;\n".repeat(rows)}`,
    ),
    context,
    terminalScreen,
  );
  context.diagnostic(
    `styled bearer 128k/256k ms: ${timings.map((time) => time.toFixed(2)).join(" / ")}`,
  );
  assert(timings[1] < 400, `large styled frame: ${timings[1]}ms`);
  assert(
    timings[1] < Math.max(60, timings[0] * 3),
    `doubling ratio: ${timings[1] / timings[0]}`,
  );
});
