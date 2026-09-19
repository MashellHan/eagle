import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UploadRejectedError } from "../agent/collector.ts";
import { drainSpool } from "../agent/spool.ts";
import { report } from "./fixtures.ts";

test("a malformed or permanently rejected report is retained without blocking fresh inventory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eagle-spool-"));
  try {
    await writeFile(join(dir, "a.json"), "{broken");
    await writeFile(join(dir, "b.json"), JSON.stringify(report("rejected")));
    await writeFile(join(dir, "c.json"), JSON.stringify(report("current")));
    const sent: string[] = [];
    const result = await drainSpool(dir, "mac-one", async (value) => {
      if (value.reportId === "rejected") throw new UploadRejectedError(400);
      sent.push(value.reportId);
    });
    assert.deepEqual(sent, ["current"]);
    assert.equal(result.rejected, 2);
    assert.equal(
      await readFile(join(dir, "rejected/a.json"), "utf8"),
      "{broken",
    );
    assert(!(await readdir(dir)).includes("c.json"));
    await writeFile(join(dir, "d.json"), JSON.stringify(report("auth")));
    await assert.rejects(
      drainSpool(dir, "mac-one", async () => {
        throw new UploadRejectedError(401);
      }),
      /401/,
    );
    assert((await readdir(dir)).includes("d.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
