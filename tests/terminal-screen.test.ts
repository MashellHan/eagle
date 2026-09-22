import assert from "node:assert/strict";
import { test } from "node:test";
import { redactScreen, terminalScreen } from "../agent/realtime.ts";
import { FrameSchema } from "../src/shared/realtime.ts";
import { restyleRedactedText } from "../src/shared/terminal.ts";

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
    `\u001b[1;32mPASS\u001b[0m\n\u001b[31m${secret.slice(0, 20)}\u001b[32m${secret.slice(20)}\u001b[0m\nPASSWORD=hunter2;\n\u001b[36mNEXT\u001b[0m`,
    [secret],
  );
  assert(!JSON.stringify(screen).includes("hunter2"));
  assert(!JSON.stringify(screen).includes(secret.slice(0, 20)));
  assert(
    screen.runs,
    "One redaction must not remove every color on the screen",
  );
  assert.deepEqual(
    screen.runs.find((run) => run.text === "PASS"),
    { text: "PASS", fg: 2, bold: true },
  );
  assert.deepEqual(screen.runs.at(-1), { text: "NEXT", fg: 6 });
  assert.equal(screen.runs.map((run) => run.text).join(""), screen.text);
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
  assert(dense.runs && dense.runs.length <= 512);
  assert.equal(dense.runs.map((run) => run.text).join(""), dense.text);
  assert.equal(dense.runs.at(-1)?.fg, 2);
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

test("restyling never reintroduces source text across repeated anchors or redaction markers", () => {
  const source = [
    { text: "secret prefix ", fg: 1 },
    { text: "safe", fg: 2 },
    { text: " secret suffix", fg: 3 },
  ];
  for (const safe of [
    "[REDACTED]safe[REDACTED]",
    "safe",
    "[REDACTED KEY]\n",
    "unmatched safe content",
    "**safe**safe",
  ]) {
    const runs = restyleRedactedText(source, safe);
    assert.equal(runs.map((run) => run.text).join(""), safe);
    assert(!JSON.stringify(runs).includes("secret"));
  }
});

test("unchanged literal asterisks and redaction labels keep their source style", () => {
  const original = [{ text: "*** [REDACTED]", fg: 2, bold: true as const }];
  assert.deepEqual(restyleRedactedText(original, original[0].text), original);
});

test("wrapped credentials and PEM redaction retain safe surrounding styles", () => {
  const secret = "fixture-private-abcdefghijklmnopqrstuvwxyz-987654321";
  for (const sensitive of [
    `${secret.slice(0, 23)}\n${secret.slice(23)}`,
    secret.slice(12, 32),
    "-----BEGIN PRIVATE KEY-----\n" +
      "A".repeat(64) +
      "\n-----END PRIVATE KEY-----",
    "API_KEY=hidden-value;",
  ]) {
    const plain = `READY\n${sensitive}\nDONE`;
    const frame = terminalScreen(
      `\u001b[32mREADY\u001b[0m\n${sensitive}\n\u001b[36mDONE\u001b[0m`,
      [secret],
    );
    assert.equal(frame.text, redactScreen(plain, [secret]));
    assert.equal(frame.runs?.map((run) => run.text).join(""), frame.text);
    assert(
      frame.runs?.some((run) => run.text.includes("READY") && run.fg === 2),
    );
    assert(
      frame.runs?.some((run) => run.text.includes("DONE") && run.fg === 6),
    );
    for (const value of [secret.slice(12, 32), "A".repeat(32), "hidden-value"])
      assert(!JSON.stringify(frame).includes(value));
  }
});

test("redundant ANSI runs are coalesced before the styling budget is applied", () => {
  const frame = terminalScreen(
    "\u001b[32m" +
      Array.from({ length: 700 }, () => "\u001b[32mhello ").join(""),
    [],
  );
  assert.equal(frame.runs?.length, 1);
  assert.equal(frame.runs?.[0].fg, 2);
  assert.equal(frame.runs?.[0].text, frame.text);
});

test("multibyte screens respect the byte budget even after keeping recent colors", () => {
  const frame = terminalScreen(`\u001b[32m${"测试内容".repeat(8000)}`, []);
  assert.equal(frame.text.length, 32000);
  assert.equal(
    frame.runs,
    undefined,
    "Plain fallback remains necessary if styled text alone exceeds budget",
  );
});
