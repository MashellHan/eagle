// The tools a bot is born with (docs/bots/RUNTIME.md, "Tools"): one extension, four tools,
// bound to the bot's workspace and offered without an approval hook.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrClient } from "../../src/tools/herdr/client.ts";
import { HERDR_TOOLS_EXTENSION } from "../../src/tools/herdr/tools.ts";
import { BOTS_TOOLS_EXTENSION, createToolRegistry } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

test("the bots-tools extension installs the four tools and a workspace section", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"), daemonRoot);
  const registry = createToolRegistry(workspace);
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
  await rm(daemonRoot, { recursive: true, force: true });
});

test("a bot's tool groups decide which extensions are installed", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"), daemonRoot);
  const herdr = { client: {} as HerdrClient, stateDir: join(daemonRoot, "bots", "a"), botId: "a" };
  const coreOnly = createToolRegistry(workspace, { groups: ["core"], herdr }).snapshot();
  assert.equal(
    coreOnly.extension(HERDR_TOOLS_EXTENSION),
    undefined,
    "core alone installs no herdr",
  );
  assert.equal(coreOnly.tools().length, 4, "the core extension keeps its four workspace tools");
  const both = createToolRegistry(workspace, { groups: ["core", "herdr"], herdr }).snapshot();
  assert.ok(both.extension(HERDR_TOOLS_EXTENSION), "the herdr group adds its extension");
  await rm(daemonRoot, { recursive: true, force: true });
});

test("the herdr extension is installed only when a client is given", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"), daemonRoot);
  const without = createToolRegistry(workspace).snapshot();
  assert.equal(without.extension(HERDR_TOOLS_EXTENSION), undefined);

  // The tools are registered even though the fake client is never called here: this is
  // the wiring contract the runtime depends on.
  const client = {} as HerdrClient;
  const withHerdr = createToolRegistry(workspace, {
    herdr: { client, stateDir: join(daemonRoot, "bots", "a"), botId: "a" },
  }).snapshot();
  const names = withHerdr
    .tools()
    .filter(({ extension }) => extension.name === HERDR_TOOLS_EXTENSION)
    .map(({ tool }) => tool.name)
    .sort();
  assert.deepEqual(names, [
    "herdr_close_space",
    "herdr_keys",
    "herdr_list",
    "herdr_open_space",
    "herdr_read",
    "herdr_send",
    "herdr_start_controller",
    "herdr_wait",
  ]);
  assert.equal(withHerdr.extension(HERDR_TOOLS_EXTENSION)?.hooks, undefined);
  assert.ok(withHerdr.sections().some(({ section }) => section.key === "bots-herdr"));
  await rm(daemonRoot, { recursive: true, force: true });
});
