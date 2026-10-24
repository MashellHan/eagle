// Ladder rows 9-10: the catalog is atomic and a delete is finishable after a crash.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BotDirectory,
  DirectoryError,
  type DirectoryFs,
  nodeDirectoryFs,
} from "../../src/core/BotDirectory.ts";
import type { BotRecord } from "../../src/core/domain.ts";

const record = (id: string, title = id): BotRecord => ({
  id,
  title,
  createdAt: "2026-10-25T02:11:03.412Z",
  updatedAt: "2026-10-25T02:11:03.412Z",
  model: { provider: "magpie", modelId: "auto/gpt-6-luna" },
});

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-dir-"));
  return { root, dir: new BotDirectory(root, await nodeDirectoryFs()) };
};

test("a fresh root has an empty catalog", async () => {
  const { root, dir } = await workspace();
  try {
    assert.deepEqual(await dir.load(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create, rename and remove are visible to the next load", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.create(record("b_2"));
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1", "b_2"],
    );
    const renamed = await dir.rename("b_1", "研究员", "2026-10-25T03:00:00.000Z");
    assert.equal(renamed.title, "研究员");
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.title),
      ["研究员", "b_2"],
    );
    await dir.remove("b_2");
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a duplicate id is refused and the catalog is unchanged", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await assert.rejects(dir.create(record("b_1")), DirectoryError);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted write leaves the previous catalog readable", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const before = await readFile(join(root, "catalog.json"), "utf8");

    // A crash between writing the temp file and renaming it.
    const real = await nodeDirectoryFs();
    const failing: DirectoryFs = {
      ...real,
      rename: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const interrupted = new BotDirectory(root, failing);
    await assert.rejects(interrupted.create(record("b_2")), DirectoryError);
    assert.equal(await readFile(join(root, "catalog.json"), "utf8"), before);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );

    // The temp file is cleaned up rather than left to look like a catalog.
    const leftovers = (await real.readdir(root)).filter((entry) => entry.name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt catalog is reported, never silently treated as empty", async () => {
  const { root, dir } = await workspace();
  try {
    await writeFile(join(root, "catalog.json"), "{ not json", { mode: 0o600 });
    await assert.rejects(dir.load(), /not JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile finishes a delete that was interrupted after the move", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.create(record("b_2"));
    // Simulate a crash between the rename and the catalog write: trash exists, the
    // bot directory has already moved, and the catalog still lists it.
    const real = await nodeDirectoryFs();
    await real.mkdir(join(root, "trash"), { recursive: true });
    await real.rename(join(root, "bots", "b_2"), join(root, "trash", "b_2"));

    const result = await dir.reconcile();
    assert.deepEqual(result.finishedDeletes, ["b_2"]);
    assert.deepEqual(result.orphanedTrash, []);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile leaves an unknown trash directory alone", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const real = await nodeDirectoryFs();
    await real.mkdir(join(root, "trash", "b_gone"), { recursive: true });
    const result = await dir.reconcile();
    assert.deepEqual(result.finishedDeletes, []);
    assert.deepEqual(result.orphanedTrash, ["b_gone"]);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
