import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalScreen } from "../agent/realtime.ts";
import { FrameSchema } from "../src/shared/realtime.ts";

test("terminal snapshots preserve safe SGR colors and emphasis alongside plain text", () => {
  const screen = terminalScreen(
    "\u001b[1;32mPASS\u001b[0m plain\n\u001b[38;2;120;80;200mRGB\u001b[0m",
    [],
  );
  assert.equal(screen.text, "PASS plain\nRGB");
  assert.deepEqual(screen.runs?.[0], { text: "PASS", bold: true, fg: 2 });
  assert.deepEqual(screen.runs?.at(-1), { text: "RGB", fg: [120, 80, 200] });
  assert.equal(screen.runs?.map((r) => r.text).join(""), screen.text);
});

test("redaction crosses color boundaries and never retains secrets in styled runs", () => {
  const secret = "fixture-machine-credential-abcdefghijklmnopqrstuvwxyz";
  const screen = terminalScreen(
    `\u001b[31m${secret.slice(0, 20)}\u001b[32m${secret.slice(20)}\u001b[0m\nPASSWORD=hunter2`,
    [secret],
  );
  assert(!JSON.stringify(screen).includes("hunter2"));
  assert(!JSON.stringify(screen).includes(secret.slice(0, 20)));
  assert.equal(
    screen.runs,
    undefined,
    "Redacted screens fall back to plain text",
  );
});

test("terminal styling strips OSC links, clipboard commands, controls and never produces HTML", () => {
  const screen = terminalScreen(
    "\u001b]8;;https://untrusted.test\u0007<label>\u001b]8;;\u0007\u001b]52;c;secret\u0007\u001b[2J\u001b[31mred\u001b[0m",
    [],
  );
  assert.equal(screen.text, "<label>red");
  assert(!JSON.stringify(screen).includes("untrusted.test"));
  assert(!JSON.stringify(screen).includes("secret"));
  assert.equal(screen.runs?.map((r) => r.text).join(""), screen.text);
});

test("styled snapshots remain bounded and preserve the last visible output", () => {
  const screen = terminalScreen(
    `\u001b[32m${"a".repeat(40000)}TAIL\u001b[0m`,
    [],
  );
  assert.equal(screen.text.length, 32000);
  assert(screen.text.endsWith("TAIL"));
  assert.equal(screen.runs?.map((r) => r.text).join(""), screen.text);
  const dense = terminalScreen(
    Array.from({ length: 1000 }, (_, i) => `\u001b[${31 + (i % 2)}mX`).join(""),
    [],
  );
  assert.equal(dense.runs, undefined);
  assert.equal(dense.text.length, 1000);
});

test("concealed text is not revealed and style metadata cannot carry different content", () => {
  const hidden = terminalScreen("before \u001b[8mhidden\u001b[28m after", []);
  assert.equal(hidden.text, "before •••••• after");
  const frame = {
    type: "frame",
    spaceId: "s",
    subscriptionId: "sub",
    paneId: "p",
    terminalId: "t",
    revision: 1,
    observedAt: new Date().toISOString(),
    text: "safe",
  };
  assert(
    FrameSchema.safeParse({ ...frame, runs: [{ text: "safe", fg: 2 }] })
      .success,
  );
  assert(
    !FrameSchema.safeParse({ ...frame, runs: [{ text: "different" }] }).success,
  );
  assert(
    !FrameSchema.safeParse({
      ...frame,
      runs: [{ text: "safe", fg: "url(https://untrusted.test)" }],
    }).success,
  );
  assert(
    !FrameSchema.safeParse({
      ...frame,
      runs: [{ text: "safe", fg: [0, 0, 256] }],
    }).success,
  );
});
