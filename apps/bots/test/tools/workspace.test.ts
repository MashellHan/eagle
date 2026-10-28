import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openWorkspace, resolveInside } from "../../src/tools/workspace.ts";

test("the default workspace is created once and native tools may use its canonical path", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-workspace-"));
  try {
    const path = join(root, "workspace");
    const first = await openWorkspace(path);
    assert.equal(first.root, await realpath(path));
    assert.deepEqual(await openWorkspace(path), first);
    await symlink(path, join(root, "linked-workspace"));
    assert.deepEqual(await openWorkspace(join(root, "linked-workspace")), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Herdr-owned working-directory resolution retains its own path validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-herdr-path-"));
  try {
    const workspace = await openWorkspace(join(root, "workspace"));
    assert.equal(await resolveInside(workspace.root, "."), workspace.root);
    assert.equal(await resolveInside(workspace.root, workspace.root), workspace.root);
    assert.equal(
      await resolveInside(workspace.root, "new/child"),
      join(workspace.root, "new/child"),
    );
    await assert.rejects(resolveInside(workspace.root, ""), /required/);
    await assert.rejects(resolveInside(workspace.root, "x".repeat(4097)), /too long/);
    await assert.rejects(resolveInside(workspace.root, "bad\0path"), /null byte/);
    await assert.rejects(resolveInside(workspace.root, ".."), /outside/);
    await symlink(root, join(workspace.root, "outside"));
    await assert.rejects(resolveInside(workspace.root, "outside/child"), /link/);
    await openWorkspace(join(workspace.root, "real-child"));
    assert.equal(
      await resolveInside(workspace.root, "real-child"),
      join(workspace.root, "real-child"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
