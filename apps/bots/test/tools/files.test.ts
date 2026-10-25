// The file tools (docs/bots/RUNTIME.md, "Tools"): read/write/list inside one workspace,
// with the path confinement and the budget each tool promises.
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { listFilesTool, readFileTool, writeFileTool } from "../../src/tools/files.ts";
import { MAX_READ_LINES, MAX_WRITE_BYTES } from "../../src/tools/limits.ts";
import type { BotWorkspace } from "../../src/tools/types.ts";
import { ensureWorkspace, openWorkspace } from "../../src/tools/workspace.ts";

const bench = async (): Promise<{
  workspace: BotWorkspace;
  cleanup: () => Promise<void>;
}> => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-tools-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"), daemonRoot);
  return {
    workspace,
    cleanup: () => rm(daemonRoot, { recursive: true, force: true }),
  };
};

test("read_file returns a file, a page and a visible truncation note", async () => {
  const { workspace, cleanup } = await bench();
  try {
    await writeFile(join(workspace.root, "notes.txt"), "one\ntwo\nthree\n", { mode: 0o600 });
    const all = await readFileTool(workspace, { path: "notes.txt" });
    assert.deepEqual(all, { output: "one\ntwo\nthree" });

    const page = await readFileTool(workspace, { path: "notes.txt", offset: 2, limit: 1 });
    assert.equal(page.output, "two\n[lines 2-2 of 3]");

    const missing = await readFileTool(workspace, { path: "missing.txt" });
    assert.equal(missing.isError, true);
    assert.match(missing.output, /no such file/);

    const directory = await readFileTool(workspace, { path: "." });
    assert.equal(directory.isError, true);
    assert.match(directory.output, /not a regular file|could not be opened/);
  } finally {
    await cleanup();
  }
});

test("read_file refuses a binary file and a FIFO", async () => {
  const { workspace, cleanup } = await bench();
  try {
    await writeFile(join(workspace.root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const binary = await readFileTool(workspace, { path: "binary.bin" });
    assert.equal(binary.isError, true);
    assert.match(binary.output, /not a text file/);

    // A FIFO would block a plain read or write forever; only a regular file is touched.
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile("mkfifo", [join(workspace.root, "pipe")], (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    assert.equal((await lstat(join(workspace.root, "pipe"))).isFIFO(), true);
    const fifo = await readFileTool(workspace, { path: "pipe" });
    assert.equal(fifo.isError, true, "a FIFO is refused instead of blocking the run");

    // A write into a FIFO with no reader must neither block nor create a file.
    const started = Date.now();
    const fifoWrite = await writeFileTool(workspace, { path: "pipe", content: "x" });
    assert.equal(fifoWrite.isError, true, "a FIFO is not a file to write");
    assert.ok(Date.now() - started < 1_000, "the write returns instead of blocking");

    await writeFile(
      join(workspace.root, "many.txt"),
      Array.from({ length: MAX_READ_LINES + 10 }, (_, index) => `line ${index}`).join("\n"),
    );
    const page = await readFileTool(workspace, { path: "many.txt", limit: 5 });
    assert.match(page.output, /\[lines 1-5 of 2010\]/);

    // A big file still answers a small page: the whole file is never read.
    const big = `${"first line\n"}${"x".repeat(530_000)}`;
    await writeFile(join(workspace.root, "big.txt"), big);
    const small = await readFileTool(workspace, { path: "big.txt", limit: 1 });
    assert.equal(small.isError, undefined);
    assert.match(small.output, /^first line/);
  } finally {
    await cleanup();
  }
});

test("write_file creates parents and tightens the mode on every write", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const written = await writeFileTool(workspace, { path: "a/b/c.txt", content: "hello" });
    assert.match(written.output, /wrote 5 bytes to a\/b\/c\.txt/);
    assert.equal(await readFile(join(workspace.root, "a/b/c.txt"), "utf8"), "hello");
    assert.equal((await stat(join(workspace.root, "a/b/c.txt"))).mode & 0o777, 0o600);

    // An overwrite of a loosened file is tightened, not left at the old mode.
    await chmod(join(workspace.root, "a/b/c.txt"), 0o644);
    await writeFileTool(workspace, { path: "a/b/c.txt", content: "again" });
    assert.equal((await stat(join(workspace.root, "a/b/c.txt"))).mode & 0o777, 0o600);

    const tooBig = await writeFileTool(workspace, {
      path: "big.txt",
      content: "x".repeat(MAX_WRITE_BYTES + 1),
    });
    assert.equal(tooBig.isError, true);
    assert.match(tooBig.output, /exceeds/);
  } finally {
    await cleanup();
  }
});

test("list_files walks the workspace, skips dependencies and stops at the limit", async () => {
  const { workspace, cleanup } = await bench();
  try {
    await mkdir(join(workspace.root, "src"), { recursive: true });
    await mkdir(join(workspace.root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(workspace.root, "src/index.ts"), "export {};\n");
    await writeFile(join(workspace.root, "README.md"), "# hi\n");
    await writeFile(join(workspace.root, "node_modules/pkg/index.js"), "");

    const listed = await listFilesTool(workspace, {});
    assert.deepEqual(listed.output.split("\n"), [
      "node_modules/",
      "README.md",
      "src/",
      "src/index.ts",
    ]);

    const limited = await listFilesTool(workspace, { limit: 2 });
    assert.match(limited.output, /truncated: showing the first 2 entries/);
  } finally {
    await cleanup();
  }
});

test("a directory that cannot be listed is reported, never rendered empty", async () => {
  const { workspace, cleanup } = await bench();
  try {
    await mkdir(join(workspace.root, "locked"), { recursive: true });
    await writeFile(join(workspace.root, "locked/file.txt"), "x");
    await chmod(join(workspace.root, "locked"), 0o000);
    const listed = await listFilesTool(workspace, {});
    assert.equal(listed.isError, true, "an unreadable directory is an error result");
    assert.match(listed.output, /could not be listed/);
  } finally {
    await chmod(join(workspace.root, "locked"), 0o700).catch(() => undefined);
    await cleanup();
  }
});

test("every tool refuses a path outside the workspace, including a dangling link", async () => {
  const { workspace, cleanup } = await bench();
  try {
    await symlink("/etc", join(workspace.root, "escape"));
    await symlink("/etc/hosts", join(workspace.root, "outside-file"));
    // A link to a file that does not exist yet is still a link: writing through it would
    // create the file outside the workspace.
    await symlink(
      join(dirname(workspace.root), "not-created-yet.txt"),
      join(workspace.root, "dangling"),
    );
    for (const path of ["../outside.txt", "/etc/hosts", "escape/hosts", "dangling"]) {
      const read = await readFileTool(workspace, { path });
      assert.equal(read.isError, true, `${path} must be refused`);
      assert.match(read.output, /outside the workspace|leaves the workspace|is a link/);
    }
    const write = await writeFileTool(workspace, { path: "../outside.txt", content: "x" });
    assert.equal(write.isError, true);
    const danglingWrite = await writeFileTool(workspace, { path: "dangling", content: "x" });
    assert.equal(danglingWrite.isError, true, "a dangling link is not a new file");
    const list = await listFilesTool(workspace, { path: "escape" });
    assert.equal(list.isError, true);
  } finally {
    await cleanup();
  }
});

test("a workspace root replaced after open is refused by every tool", async () => {
  const { workspace, cleanup } = await bench();
  try {
    const { rename, symlink } = await import("node:fs/promises");
    await rename(workspace.root, `${workspace.root}-moved`);
    // The replaced root points at the daemon root: nothing may be read or written.
    await symlink(workspace.daemonRoot, workspace.root);
    const read = await readFileTool(workspace, { path: "token" });
    assert.equal(read.isError, true);
    assert.match(read.output, /replaced/);
    const write = await writeFileTool(workspace, { path: "token", content: "x" });
    assert.equal(write.isError, true);
    assert.match(write.output, /replaced/);
    const list = await listFilesTool(workspace, {});
    assert.equal(list.isError, true);
    assert.match(list.output, /replaced/);
    const { runCommandTool } = await import("../../src/tools/shell.ts");
    const run = await runCommandTool(workspace, { command: "pwd" });
    assert.equal(run.isError, true);
    assert.match(run.output, /replaced/);
  } finally {
    await rm(workspace.root, { force: true });
    await cleanup();
  }
});

test("ensureWorkspace refuses a workspace that is itself a link", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bots-tools-root-"));
  try {
    const real = join(parent, "real");
    await mkdir(real, { mode: 0o700 });
    const link = join(parent, "link");
    await symlink(real, link);
    await assert.rejects(() => ensureWorkspace(link), /is a link/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
