import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { HerdrClient } from "../../src/tools/herdr/client.ts";
import { HERDR_TOOLS_EXTENSION } from "../../src/tools/herdr/tools.ts";
import {
  BOTS_TOOLS_EXTENSION,
  createToolRegistry,
  selectToolExtensions,
} from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

test("core supplies list and coding installs the original native extension without aliases", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-native-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const registry = createToolRegistry(workspace);
    const snapshot = registry.snapshot();
    assert.equal(snapshot.extension("coding-tools"), CodingTools);
    assert.deepEqual(
      selectToolExtensions(registry, [])
        .flatMap((extension) => extension.tools ?? [])
        .map((tool) => tool.name)
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
  const registry = createToolRegistry(workspace);
  const snapshot = registry.snapshot();
  assert.deepEqual(
    selectToolExtensions(registry, [])
      .flatMap((extension) => (extension.tools ?? []).map((tool) => [extension.name, tool.name]))
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

test("a bot's tool groups select from every registered built-in extension", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const herdr = { client: {} as HerdrClient, stateDir: join(daemonRoot, "bots", "a"), botId: "a" };
  const registry = createToolRegistry(workspace, { herdr });
  const coreOnly = selectToolExtensions(registry, []);
  assert.deepEqual(
    coreOnly.map((extension) => extension.name),
    [BOTS_TOOLS_EXTENSION, "coding-tools"],
  );
  assert.equal(coreOnly.flatMap((extension) => extension.tools ?? []).length, 5);
  const both = selectToolExtensions(registry, ["herdr"]);
  assert.ok(both.some((extension) => extension.name === HERDR_TOOLS_EXTENSION));
  assert.ok(both.some((extension) => extension.name === "tool-search"));
  assert.ok(registry.snapshot().extension("bots-agents"), "unselected built-ins remain registered");
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
  const snapshot = createToolRegistry(workspace, { herdr }).snapshot();
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
  const coreOnly = createToolRegistry(workspace).snapshot();
  assert.equal(
    coreOnly.tools().some(({ tool }) => tool.name === "tool_search"),
    false,
    "nothing is deferred, so no loader is offered",
  );
  await rm(daemonRoot, { recursive: true, force: true });
});

test("selection reads native registry replacement and removal rather than a startup snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-live-registry-"));
  try {
    const registry = createToolRegistry(await openWorkspace(join(root, "workspace")));
    const previous = registry.snapshot();
    const replacement = defineExtension({ name: "bots-agents", tools: [] });
    registry.install(replacement);
    assert.equal(
      selectToolExtensions(registry, ["agents"]).find(
        (extension) => extension.name === "bots-agents",
      ),
      replacement,
    );
    assert.notEqual(previous.extension("bots-agents"), replacement);
    registry.uninstall(replacement);
    assert.deepEqual(
      selectToolExtensions(registry, ["agents"]).map((extension) => extension.name),
      [BOTS_TOOLS_EXTENSION, "coding-tools"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
