import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createListTool } from "../../src/tools/list.ts";

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-list-"));
  const env = new NodeExecutionEnv({ cwd: root });
  const api: Pick<ToolExecutionApi, "env"> = { env };
  const tool = createListTool();
  return {
    root,
    env,
    run: (args: { path?: string; limit?: number } = {}) =>
      tool.execute(args, api as ToolExecutionApi, BACKGROUND_CONTEXT),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("list walks in stable order and does not traverse links or generated directories", async () => {
  const bench = await fixture();
  try {
    await mkdir(join(bench.root, "src"));
    await mkdir(join(bench.root, "node_modules"));
    await writeFile(join(bench.root, "z.txt"), "last");
    await writeFile(join(bench.root, "src", "a.ts"), "source");
    await writeFile(join(bench.root, "node_modules", "hidden"), "dependency");
    await symlink(bench.root, join(bench.root, "loop"));
    const result = await bench.run();
    assert.deepEqual(result.output, [
      { type: "text", text: "loop\nnode_modules/\nsrc/\nsrc/a.ts\nz.txt" },
    ]);
    assert.equal(result.isError, undefined);
    assert.equal(result.diagnostics, undefined);
  } finally {
    await bench.cleanup();
  }
});

test("list accepts absolute paths and reports paths relative to the requested directory", async () => {
  const bench = await fixture();
  try {
    await mkdir(join(bench.root, "child"));
    await writeFile(join(bench.root, "child", "file.txt"), "content");
    assert.deepEqual((await bench.run({ path: join(bench.root, "child") })).output, [
      { type: "text", text: "file.txt" },
    ]);
    assert.deepEqual((await bench.run({ path: "child" })).output, [
      { type: "text", text: "file.txt" },
    ]);
  } finally {
    await bench.cleanup();
  }
});

test("list bounds entries and reports truncation through native diagnostics", async () => {
  const bench = await fixture();
  try {
    await writeFile(join(bench.root, "a"), "a");
    await writeFile(join(bench.root, "b"), "b");
    const result = await bench.run({ limit: 1 });
    assert.deepEqual(result.output, [{ type: "text", text: "a" }]);
    assert.match(result.diagnostics?.[0]?.message ?? "", /truncated/i);
    assert.equal((await bench.run({ limit: 2 })).diagnostics, undefined);
    await assert.rejects(bench.run({ limit: 0 }), /limit/);
    await assert.rejects(bench.run({ limit: 1.5 }), /limit/);
    await assert.rejects(bench.run({ limit: 2001 }), /limit/);
  } finally {
    await bench.cleanup();
  }
});

test("list reports an empty directory and propagates filesystem and cancellation failures", async () => {
  const bench = await fixture();
  try {
    assert.deepEqual((await bench.run()).output, [{ type: "text", text: "(empty directory)" }]);
    await assert.rejects(bench.run({ path: "missing" }), FileError);
    await writeFile(join(bench.root, "file"), "content");
    await assert.rejects(bench.run({ path: "file" }), FileError);
    await assert.rejects(
      createListTool().execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT),
      /No execution environment/,
    );
    const original = bench.env.listDir.bind(bench.env);
    bench.env.listDir = async (...args) => {
      const result = await original(...args);
      return result.ok ? { ok: false, error: new FileError("aborted", "cancelled") } : result;
    };
    await assert.rejects(bench.run(), /cancelled/);
  } finally {
    await bench.cleanup();
  }
});

test("list caps bytes before the entry limit and propagates nested traversal failures", async () => {
  const bench = await fixture();
  try {
    await mkdir(join(bench.root, "large"));
    await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        writeFile(
          join(bench.root, "large", `${String(index).padStart(3, "0")}-${"x".repeat(240)}`),
          "",
        ),
      ),
    );
    const result = await bench.run();
    const text = result.output?.[0];
    assert.ok(text?.type === "text");
    assert.ok(Buffer.byteLength(text.text) <= 50 * 1024);
    assert.ok(text.text.split("\n").length < 221);
    assert.equal(result.diagnostics?.[0]?.code, "truncated");
    const original = bench.env.listDir.bind(bench.env);
    bench.env.listDir = (path, context) =>
      path.endsWith("large")
        ? Promise.resolve({
            ok: false,
            error: new FileError("permission_denied", "cannot list child"),
          })
        : original(path, context);
    await assert.rejects(bench.run(), /cannot list child/);
  } finally {
    await bench.cleanup();
  }
});
