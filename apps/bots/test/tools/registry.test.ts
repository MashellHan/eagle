// The tools a bot is born with (docs/bots/RUNTIME.md, "Tools"): one extension, four tools,
// bound to the bot's workspace and offered without an approval hook.
import assert from "node:assert/strict";
import test from "node:test";
import { BOTS_TOOLS_EXTENSION, createToolRegistry } from "../../src/tools/registry.ts";

test("the bots-tools extension installs the four tools and a workspace section", () => {
  const registry = createToolRegistry({
    workspaceRoot: "/tmp/workspace-of-a-bot",
    daemonRoot: "/tmp/daemons",
  });
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

  // Each tool's SDK budget matches the cap the tool already enforces, so the SDK never
  // cuts a result (and never a command's exit code) behind the tool's back.
  for (const { tool } of snapshot.tools()) {
    assert.ok(tool.outputLimits, `${tool.name} declares output limits`);
  }
  const command = snapshot.tools().find(({ tool }) => tool.name === "run_command");
  assert.equal(command?.tool.outputLimits?.retain, "tail");
});
