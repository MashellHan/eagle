import assert from "node:assert/strict";
import { test } from "node:test";
import { redactScreen, terminalScreen } from "../agent/realtime.ts";

test("screen redaction preserves status labels instead of joining words into secret names", () => {
  for (const label of [
    "Token usage",
    "Token\tusage",
    "Token\u00a0usage",
    "Token usage\n  ",
    "Secret scanning",
    "Password policy",
    "API_KEY status",
    "Credential count",
  ]) {
    const text = `${label}: 42\nContext window: 96% left\nReady for the next task.`;
    assert.equal(redactScreen(text, []), text, label);
  }
});

test("Codex status text and following output retain their terminal colors", () => {
  const text =
    "│ Token usage: 55.4K total (47.9K input + 7.43K output) │\n" +
    "│ Context window: 96% left (48.7K used / 950K)          │\n" +
    "Hello! Ready when you are.";
  const frame = terminalScreen(
    `\u001b[36m${text.split("\n").slice(0, 2).join("\n")}\u001b[0m\n` +
      "\u001b[32mHello! Ready when you are.\u001b[0m",
    [],
  );
  assert.equal(frame.text, text);
  assert.equal(frame.runs?.map((run) => run.text).join(""), text);
  assert.equal(frame.runs?.[0].fg, 6);
  assert.deepEqual(frame.runs?.at(-1), {
    text: "Hello! Ready when you are.",
    fg: 2,
  });
});

test("ordinary status labels do not consume later wrapped token or assignment matches", () => {
  const prefix = "Token usage: 42 total\nNext output:\n";
  for (const sensitive of [
    "sk-proj-1234\nabcdefghijklmnopqrstuv;",
    "eag1.fixtureheader.fixturepayload.\nfixturesignature;",
    "API_\nKEY=private-fixture-value;",
    "API_\n  KEY=private-fixture-value;",
    "API_\r\n\tKEY=private-fixture-value;",
    "TOK\n  EN=private-fixture-value;",
    "TOKEN\n_NAME=private-fixture-value;",
    "TOKEN_\n\tNAME=private-fixture-value;",
  ]) {
    const frame = terminalScreen(`${prefix}${sensitive}\nDone.`, []);
    assert(frame.text.startsWith(prefix), sensitive);
    assert(frame.text.endsWith("\nDone."), sensitive);
    assert.equal(
      frame.runs?.map((run) => run.text).join("") ?? frame.text,
      frame.text,
    );
    for (const value of [
      "abcdefghijklmnopqrstuv",
      "fixturesignature",
      "private-fixture-value",
    ]) {
      assert(!JSON.stringify(frame).includes(value), sensitive);
    }
  }
});

test("known wrapped credentials remain hidden next to a safe status label", () => {
  const secret = "fixture-machine-credential-abcdefghijklmnopqrstuvwxyz";
  const prefix = "Token usage: 42 total\n";
  const frame = terminalScreen(
    `${prefix}${secret.slice(0, 23)}\n${secret.slice(23)}\nDone.`,
    [secret],
  );
  assert(frame.text.startsWith(prefix));
  assert(frame.text.endsWith("\nDone."));
  assert(!JSON.stringify(frame).includes(secret.slice(23)));
});
