// Ladder row 42, catalogue half: the declared event names, the names the source actually
// uses and the table in the contract are one set (docs/bots/OBSERVABILITY.md).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EVENTS, OUTCOMES } from "../../src/log/events.ts";

const sourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
};

const usedEvents = async (): Promise<Set<string>> => {
  const used = new Set<string>();
  for (const file of await sourceFiles("src")) {
    const body = await readFile(file, "utf8");
    for (const match of body.matchAll(/declareEvent\("([^"]+)"\)/g)) {
      const name = match[1];
      if (name !== undefined) used.add(name);
    }
  }
  return used;
};

const documentedEvents = async (): Promise<Set<string>> => {
  const body = await readFile("../../docs/bots/OBSERVABILITY.md", "utf8");
  const documented = new Set<string>();
  for (const line of body.split("\n")) {
    // The layer tables are the ones that start with a layer name in the first cell.
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 3 || !/^(transport|protocol|core|runtime|pi)$/.test(cells[1] ?? "")) {
      continue;
    }
    for (const match of (cells[2] ?? "").matchAll(/`([a-z]+\.[A-Za-z.]+)`/g)) {
      const name = match[1];
      if (name !== undefined) documented.add(name);
    }
  }
  return documented;
};

const sorted = (values: Iterable<string>): string[] => [...values].sort();

test("the declared catalogue is exactly what the source uses", async () => {
  const used = await usedEvents();
  const declared = new Set(Object.keys(EVENTS));
  assert.deepEqual(sorted(declared), sorted(used), "an unused or undeclared event is a gap");
});

test("the declared catalogue is exactly the contract table", async () => {
  const documented = await documentedEvents();
  const declared = new Set(Object.keys(EVENTS));
  assert.ok(documented.size > 50, "the table was parsed, not skipped");
  assert.deepEqual(sorted(declared), sorted(documented), "code and contract disagree");
});

test("every start has one outcome partner in the same layer", () => {
  const names = new Set(Object.keys(EVENTS));
  for (const name of names) {
    if (!name.endsWith(".start")) continue;
    const stem = name.slice(0, -".start".length);
    const partners = [...OUTCOMES]
      .filter((outcome) => outcome !== "start")
      .map((outcome) => `${stem}.${outcome}`)
      .filter((candidate) => names.has(candidate));
    assert.ok(partners.length >= 1, `${name} has no declared outcome`);
  }
});
