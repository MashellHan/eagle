import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { sendReport, UploadRejectedError } from "../agent/collector.ts";
import { drainSpool } from "../agent/spool.ts";
import { report } from "./fixtures.ts";

test("reconnect sends the newest queued snapshot before older backlog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eagle-latest-"));
  try {
    await writeFile(
      join(dir, "2026-09-19T01-00-00-old.json"),
      JSON.stringify(report("old")),
    );
    await writeFile(
      join(dir, "2026-09-19T02-00-00-new.json"),
      JSON.stringify(report("new")),
    );
    const sent: string[] = [];
    await drainSpool(dir, "mac-one", async (value) => {
      sent.push(value.reportId);
    });
    assert.deepEqual(sent, ["new", "old"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed or permanently rejected report is retained without blocking fresh inventory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eagle-spool-"));
  try {
    await writeFile(join(dir, "a.json"), "{broken");
    await writeFile(join(dir, "b.json"), JSON.stringify(report("rejected")));
    await writeFile(join(dir, "c.json"), JSON.stringify(report("current")));
    const sent: string[] = [];
    const result = await drainSpool(dir, "mac-one", (value) =>
      sendReport(
        "https://eagle.test",
        "test-token",
        value,
        async () => {
          if (value.reportId === "rejected")
            return new Response("{}", { status: 400 });
          sent.push(value.reportId);
          return Response.json(
            { accepted: true, duplicate: false, seq: 1 },
            { status: 201 },
          );
        },
        0,
      ),
    );
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

test("a malformed successful acknowledgement keeps the valid report pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eagle-ack-"));
  try {
    await writeFile(join(dir, "report.json"), JSON.stringify(report()));
    for (const body of ["not-json", "{}", "null", '{"accepted":false}']) {
      await assert.rejects(
        drainSpool(dir, "mac-one", (value) =>
          sendReport(
            "https://eagle.test",
            "test-token",
            value,
            async () => new Response(body, { status: 200 }),
            0,
          ),
        ),
        /acknowledgement/,
      );
      assert((await readdir(dir)).includes("report.json"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full queue drains before attempting a fresh capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eagle-full-"));
  try {
    const spool = join(dir, "spool");
    await mkdir(spool);
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        writeFile(join(spool, `${i}.json`), "{broken"),
      ),
    );
    const config = join(dir, "agent.json");
    await writeFile(
      config,
      JSON.stringify({
        url: "http://127.0.0.1:1",
        token: "test-token".repeat(4),
        machineId: "mac-one",
        machineName: "Test machine",
        spoolDir: spool,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, ["agent/cli.ts", "once"], {
        env: { ...process.env, PATH: "/nonexistent", EAGLE_CONFIG: config },
      }),
      /Collection failed; previous complete inventory preserved/,
    );
    assert.equal((await readdir(join(spool, "rejected"))).length, 1000);
    assert.equal(
      (await readdir(spool)).filter((f) => f.endsWith(".json")).length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
