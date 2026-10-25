// The tools a bot is born with (docs/bots/RUNTIME.md, "Tools"): one extension, four tools,
// bound to the bot's workspace and offered without an approval hook.
import assert from "node:assert/strict";
import test from "node:test";
import { BOTS_TOOLS_EXTENSION, createToolRegistry } from "../../src/tools/registry.ts";

test("the bots-tools extension installs the four tools and a workspace section", () => {
  const registry = createToolRegistry("/tmp/workspace-of-a-bot");
  const snapshot = registry.snapshot();
  assert.deepEqual(
    snapshot
      .tools()
      .map(({ extension, tool }) => [extension.name, tool.name])
      .sort(),
    [
      [BOTS_TOOLS_EXTENSION, "list_files"],
      [BOTS_TOOLS_EXTENSION, "read_file"],
      [BOTS_TOOLS_EXTENSION, "run_command"],
      [BOTS_TOOLS_EXTENSION, "write_file"],
    ],
  );
  assert.equal(snapshot.extension(BOTS_TOOLS_EXTENSION)?.hooks, undefined);
  const section = snapshot.sections().find(({ section }) => section.key === "bots-tools");
  assert.ok(section, "the model is told where its workspace is");
});
