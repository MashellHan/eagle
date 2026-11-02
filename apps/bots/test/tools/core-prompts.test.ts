// The two core prompts (docs/bots/PRODUCT.md, "Core prompts"): the person's standing
// instruction and the machine's own instructions file, both ahead of every tool section so a
// bot knows who it is before it reads what it can do.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import {
  MACHINE_EXTENSION,
  MAX_MACHINE_PROMPT,
  machineExtension,
  readMachinePrompt,
} from "../../src/tools/machine/tools.ts";
import { PERSONA_EXTENSION, personaExtension } from "../../src/tools/persona/tools.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";

const rendered = (extension: Extension): string | undefined => {
  const entry = extension.sections?.[0];
  if (entry === undefined) return undefined;
  const value = entry.render({} as never, {} as never);
  return typeof value === "string" ? value : undefined;
};

const home = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-machine-prompt-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("the persona section is the person's text, and empty text renders nothing", () => {
  assert.equal(rendered(personaExtension(() => "  务实一点  ")), "务实一点");
  assert.equal(rendered(personaExtension(() => "   ")), undefined);
  assert.equal(rendered(personaExtension(() => undefined)), undefined);
});

test("the machine section renders whatever the reader returns", () => {
  assert.equal(
    rendered(machineExtension(() => ({ path: "/m/AGENTS.md", text: "机器说明" }))),
    "机器说明",
  );
  assert.equal(rendered(machineExtension(() => undefined)), undefined);
});

test("the machine prompt takes the shared entry point before any one tool's copy", async () => {
  const bench = await home();
  try {
    await mkdir(join(bench.root, ".pi/agent"), { recursive: true });
    await mkdir(join(bench.root, ".agents"), { recursive: true });
    await mkdir(join(bench.root, ".codex"), { recursive: true });
    await writeFile(join(bench.root, ".pi/agent/AGENTS.md"), "pi 的说明");
    await writeFile(join(bench.root, ".codex/AGENTS.md"), "codex 的说明");

    const pi = readMachinePrompt(bench.root);
    assert.equal(pi?.text, "pi 的说明");
    // The path is resolved through the link a setup tool leaves in the home directory.
    assert.equal(pi?.path.endsWith(".pi/agent/AGENTS.md"), true);

    await writeFile(join(bench.root, ".agents/AGENTS.md"), "共享的说明");
    assert.equal(readMachinePrompt(bench.root)?.text, "共享的说明");
  } finally {
    await bench.cleanup();
  }
});

test("an empty file is skipped, and no file at all means no section", async () => {
  const bench = await home();
  try {
    assert.equal(readMachinePrompt(bench.root), undefined);
    await mkdir(join(bench.root, ".agents"), { recursive: true });
    await writeFile(join(bench.root, ".agents/AGENTS.md"), "  \n ");
    assert.equal(readMachinePrompt(bench.root), undefined);
  } finally {
    await bench.cleanup();
  }
});

test("an absolute candidate is read as it is, which is how a second machine points at its file", async () => {
  const bench = await home();
  try {
    const path = join(bench.root, "custom.md");
    await writeFile(path, "自定义路径");
    assert.equal(readMachinePrompt(bench.root, [path])?.text, "自定义路径");
  } finally {
    await bench.cleanup();
  }
});

test("a long machine file is cut, and the cut says so", async () => {
  const bench = await home();
  try {
    const path = join(bench.root, "long.md");
    await writeFile(path, "字".repeat(MAX_MACHINE_PROMPT + 10));
    const prompt = readMachinePrompt(bench.root, [path]);
    assert.ok(prompt !== undefined);
    assert.ok(prompt.text.endsWith(`[truncated at ${MAX_MACHINE_PROMPT} characters]`));
    assert.equal(prompt.text.length < MAX_MACHINE_PROMPT + 100, true);
  } finally {
    await bench.cleanup();
  }
});

test("both core prompts are installed first, so their sections lead the system prompt", () => {
  const registry = createToolRegistry(
    { root: "/tmp" },
    { persona: () => "人格", machine: () => ({ path: "/m", text: "机器" }) },
  );
  const names = registry
    .snapshot()
    .installed()
    .map((extension) => extension.name);
  assert.deepEqual(names.slice(0, 2), [PERSONA_EXTENSION, MACHINE_EXTENSION]);
  assert.deepEqual(
    registry
      .snapshot()
      .sections()
      .slice(0, 2)
      .map(({ section: entry }) => entry.key),
    ["bots-persona", "bots-machine"],
  );
});

test("a registry without the readers installs neither core prompt", () => {
  const registry = createToolRegistry({ root: "/tmp" });
  const names = registry
    .snapshot()
    .installed()
    .map((extension) => extension.name);
  assert.equal(names.includes(PERSONA_EXTENSION), false);
  assert.equal(names.includes(MACHINE_EXTENSION), false);
});
