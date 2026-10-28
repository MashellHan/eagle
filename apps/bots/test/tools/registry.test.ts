import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { HerdrClient } from "../../src/tools/herdr/client.ts";
import { HERDR_TOOLS_EXTENSION } from "../../src/tools/herdr/tools.ts";
import { BOTS_TOOLS_EXTENSION, createToolRegistry } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

test("core supplies list and coding installs the original native extension without aliases", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-native-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const snapshot = createToolRegistry(workspace, { groups: [] }).snapshot();
    assert.equal(snapshot.extension("coding-tools"), CodingTools);
    assert.deepEqual(
      snapshot
        .tools()
        .map(({ tool }) => tool.name)
        .sort(),
      ["bash", "edit", "list", "read", "write"],
    );
    assert.deepEqual(
      snapshot.extension(BOTS_TOOLS_EXTENSION)?.tools?.map((tool) => tool.name),
      ["list"],
    );
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("core and coding install five tools and a working-directory section", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const registry = createToolRegistry(workspace, { groups: ["core"] });
  const snapshot = registry.snapshot();
  assert.deepEqual(
    snapshot
      .tools()
      .map(({ extension, tool }) => [extension.name, tool.name])
      .sort(),
    [
      [BOTS_TOOLS_EXTENSION, "list"],
      ["coding-tools", "bash"],
      ["coding-tools", "edit"],
      ["coding-tools", "read"],
      ["coding-tools", "write"],
    ],
  );
  assert.equal(snapshot.extension(BOTS_TOOLS_EXTENSION)?.hooks, undefined);
  const section = snapshot.sections().find(({ section }) => section.key === "bots-tools");
  assert.ok(section, "the model is told where its workspace is");

  const command = snapshot.tools().find(({ tool }) => tool.name === "bash");
  assert.equal(command?.tool.outputLimits?.retain, "tail");
  await rm(daemonRoot, { recursive: true, force: true });
});

test("a bot's tool groups decide which extensions are installed", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const herdr = { client: {} as HerdrClient, stateDir: join(daemonRoot, "bots", "a"), botId: "a" };
  const coreOnly = createToolRegistry(workspace, { groups: ["core"], herdr }).snapshot();
  assert.equal(
    coreOnly.extension(HERDR_TOOLS_EXTENSION),
    undefined,
    "core alone installs no herdr",
  );
  assert.equal(coreOnly.tools().length, 5, "core and coding are mandatory");
  const both = createToolRegistry(workspace, { groups: ["core", "herdr"], herdr }).snapshot();
  assert.ok(both.extension(HERDR_TOOLS_EXTENSION), "the herdr group adds its extension");
  await rm(daemonRoot, { recursive: true, force: true });
});

test("the herdr extension is installed only when a client is given", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
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

test("herdr tools are deferred and the loader is installed with them", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const herdr = { client: {} as HerdrClient, stateDir: join(daemonRoot, "bots", "a"), botId: "a" };
  const snapshot = createToolRegistry(workspace, { groups: ["core", "herdr"], herdr }).snapshot();
  const tools = snapshot.tools().map(({ tool }) => tool);
  const herdrTools = tools.filter((tool) => tool.name.startsWith("herdr_"));
  assert.equal(herdrTools.length, 8, "every terminal tool is registered");
  assert.deepEqual(
    herdrTools.filter((tool) => tool.deferred !== true).map((tool) => tool.name),
    [],
    "all of them load on demand",
  );
  assert.ok(
    tools.some((tool) => tool.name === "tool_search"),
    "the loader that enables deferred tools is installed",
  );
  const coreOnly = createToolRegistry(workspace, { groups: ["core"] }).snapshot();
  assert.equal(
    coreOnly.tools().some(({ tool }) => tool.name === "tool_search"),
    false,
    "nothing is deferred, so no loader is offered",
  );
  await rm(daemonRoot, { recursive: true, force: true });
});
