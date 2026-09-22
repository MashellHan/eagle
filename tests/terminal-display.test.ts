import assert from "node:assert/strict";
import { test } from "node:test";
import { compactTerminalText } from "../src/shared/terminal-display.ts";

test("compact only the trailing idle Codex prompt and keep model plus directory", () => {
  const text =
    "First output\n\nSecond output\n\n› Ask Codex to do anything      \n     \n  gpt-6-astra max · ~/workspace/demo · Main [default] \n\n";
  assert.equal(
    compactTerminalText(text),
    "First output\n\nSecond output\ngpt-6-astra max · ~/workspace/demo",
  );
});

test("do not remove typed input, prompt-like output, or an unrecognized footer", () => {
  for (const text of [
    "result\n› fix the bug\n  gpt-6-astra max · ~/workspace/demo · Main [default]",
    "› Ask Codex to do anything\nactual output after prompt\ngpt-6-astra max · ~/workspace/demo · Main [default]",
    "result\n› Ask Codex to do anything\nunknown footer",
    "some output\n\nmore output\n\n",
  ])
    assert.equal(compactTerminalText(text), text);
});

test("compact Windows and spaced paths without changing interior output formatting", () => {
  const text =
    "    indented code\r\n\r\n› Ask Codex to do anything\r\n\r\n  gpt-6-astra high · C:\\Work Folder\\repo · Main [default]\r\n";
  assert.equal(
    compactTerminalText(text),
    "    indented code\ngpt-6-astra high · C:\\Work Folder\\repo",
  );
});
