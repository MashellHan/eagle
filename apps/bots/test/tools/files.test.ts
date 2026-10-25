// The file tools (docs/bots/RUNTIME.md, "Tools"): read/write/list inside one workspace,
// with the path confinement and the budget each tool promises.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listFilesTool, readFileTool, writeFileTool } from "../../src/tools/files.ts";
import { MAX_READ_LINES, MAX_WRITE_BYTES } from "../../src/tools/limits.ts";
import { ensureWorkspace } from "../../src/tools/workspace.ts";

const workspace = async (): Promise<{ root: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "bots-tools-"));
  await ensureWorkspace(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("read_file returns a file, a page and a visible truncation note", async () => {
  const ws = await workspace();
  try {
    await writeFile(join(ws.root, "notes.txt"), "one\ntwo\nthree\n", { mode: 0o600 });
    const all = await readFileTool({ root: ws.root }, { path: "notes.txt" });
    assert.deepEqual(all, { output: "one\ntwo\nthree" });

    const page = await readFileTool({ root: ws.root }, { path: "notes.txt", offset: 2, limit: 1 });
    assert.equal(page.output, "two\n[lines 2-2 of 3]");

    const missing = await readFileTool({ root: ws.root }, { path: "missing.txt" });
    assert.equal(missing.isError, true);
    assert.match(missing.output, /no such file/);

    const directory = await readFileTool({ root: ws.root }, { path: "." });
    assert.equal(directory.isError, true);
    assert.match(directory.output, /is a directory/);
  } finally {
    await ws.cleanup();
  }
});

test("read_file refuses a binary file and an oversized page", async () => {
  const ws = await workspace();
  try {
    await writeFile(join(ws.root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const binary = await readFileTool({ root: ws.root }, { path: "binary.bin" });
    assert.equal(binary.isError, true);
    assert.match(binary.output, /not a text file/);

    await writeFile(
      join(ws.root, "many.txt"),
      Array.from({ length: MAX_READ_LINES + 10 }, (_, index) => `line ${index}`).join("\n"),
    );
    const page = await readFileTool({ root: ws.root }, { path: "many.txt", limit: 5 });
    assert.match(page.output, /\[lines 1-5 of \d+\]/);
  } finally {
    await ws.cleanup();
  }
});

test("write_file creates parents, writes owner-only and refuses the budgets", async () => {
  const ws = await workspace();
  try {
    const written = await writeFileTool({ root: ws.root }, { path: "a/b/c.txt", content: "hello" });
    assert.match(written.output, /wrote 5 bytes to a\/b\/c\.txt/);
    assert.equal(await readFile(join(ws.root, "a/b/c.txt"), "utf8"), "hello");
    assert.equal((await stat(join(ws.root, "a/b/c.txt"))).mode & 0o777, 0o600);

    const tooBig = await writeFileTool(
      { root: ws.root },
      { path: "big.txt", content: "x".repeat(MAX_WRITE_BYTES + 1) },
    );
    assert.equal(tooBig.isError, true);
    assert.match(tooBig.output, /exceeds/);
  } finally {
    await ws.cleanup();
  }
});

test("list_files walks the workspace, skips dependencies and stops at the limit", async () => {
  const ws = await workspace();
  try {
    await mkdir(join(ws.root, "src"), { recursive: true });
    await mkdir(join(ws.root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(ws.root, "src/index.ts"), "export {};\n");
    await writeFile(join(ws.root, "README.md"), "# hi\n");
    await writeFile(join(ws.root, "node_modules/pkg/index.js"), "");

    const listed = await listFilesTool({ root: ws.root }, {});
    assert.deepEqual(listed.output.split("\n"), [
      "node_modules/",
      "README.md",
      "src/",
      "src/index.ts",
    ]);

    const limited = await listFilesTool({ root: ws.root }, { limit: 2 });
    assert.match(limited.output, /truncated: showing the first 2 entries/);
  } finally {
    await ws.cleanup();
  }
});

test("every tool refuses a path outside the workspace, including through a symlink", async () => {
  const ws = await workspace();
  try {
    await symlink("/etc", join(ws.root, "escape"));
    for (const path of ["../outside.txt", "/etc/hosts", "escape/hosts"]) {
      const read = await readFileTool({ root: ws.root }, { path });
      assert.equal(read.isError, true, `${path} must be refused`);
      assert.match(read.output, /outside the workspace|leaves the workspace/);
    }
    const write = await writeFileTool({ root: ws.root }, { path: "../outside.txt", content: "x" });
    assert.equal(write.isError, true);
    const list = await listFilesTool({ root: ws.root }, { path: "escape" });
    assert.equal(list.isError, true);
  } finally {
    await ws.cleanup();
  }
});
