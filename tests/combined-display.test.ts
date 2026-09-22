import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveFrame } from "../src/shared/realtime.ts";
import { compactRenderedFrame } from "../src/shared/terminal-display.ts";

test("compact display hides idle chrome without losing body or footer colors", () => {
  const runs = [
    { text: "PASS\n", fg: 2 },
    { text: "\n› Ask Codex to do anything\n\n" },
    { text: "  gpt-6-astra max", fg: 6 },
    { text: " · ~/workspace/demo", fg: 4 },
    { text: " · Main [default]\n\n", fg: 8 },
  ];
  const frame: LiveFrame = {
    type: "frame",
    spaceId: "s",
    subscriptionId: "sub",
    paneId: "p",
    terminalId: "t",
    revision: 1,
    observedAt: new Date().toISOString(),
    text: runs.map((r) => r.text).join(""),
    runs,
  };
  const display = compactRenderedFrame(frame);
  assert.equal(display.text, "PASS\n\ngpt-6-astra max · ~/workspace/demo");
  assert.equal(display.runs?.map((r) => r.text).join(""), display.text);
  assert(display.runs?.some((r) => r.text === "PASS" && r.fg === 2));
  assert(display.runs?.some((r) => r.text === "gpt-6-astra max" && r.fg === 6));
  assert(
    display.runs?.some((r) => r.text === " · ~/workspace/demo" && r.fg === 4),
  );
  assert(frame.text.includes("Ask Codex"), "Source frame must remain intact");
});
