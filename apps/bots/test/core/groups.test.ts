// Tool groups (docs/bots/PROTOCOL.md, "Gateway settings"): the core group is mandatory, a
// stored selection is normalized, and an unknown name never survives.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOL_GROUPS, resolveToolGroups } from "../../src/core/domain.ts";

test("the core group cannot be turned off and unknown names are dropped", () => {
  assert.deepEqual(resolveToolGroups([]), ["core"]);
  assert.deepEqual(resolveToolGroups(["herdr"]), ["core", "herdr"]);
  assert.deepEqual(resolveToolGroups(["core"]), ["core"]);
  assert.deepEqual(resolveToolGroups(["herdr", "web"]), ["core", "herdr"]);
  assert.deepEqual(resolveToolGroups(undefined), ["core"]);
  assert.deepEqual(DEFAULT_TOOL_GROUPS, ["core", "herdr"]);
});
