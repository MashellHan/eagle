// Ladder rows 53b and R4: a delete killed after the rename is finished by the next start,
// and a killed process cannot log its own failure (docs/bots/OBSERVABILITY.md, R4).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a delete killed after its rename reconciles on the next start", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-crash-delete-"));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(process.cwd(), "test/crash/support/rename-child.ts"),
      root,
      "b_crash",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    for (let index = 0; index < 300 && !output.includes("renamed"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(output, /renamed/, "the child reached the interrupted state");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    // The state a killed delete leaves: trash/<id> present, the catalog still naming it.
    const before = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
      bots: { id: string }[];
    };
    assert.deepEqual(
      before.bots.map((bot) => bot.id),
      ["b_crash"],
      "the kill landed between the two steps",
    );
    await access(join(root, "trash", "b_crash"));
  } finally {
    child.kill("SIGKILL");
  }

  const daemon = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(process.cwd(), "src/main.ts"),
      "--root",
      root,
      "--port",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    let output = "";
    daemon.stdout?.setEncoding("utf8");
    daemon.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    for (let index = 0; index < 600 && !output.includes('"daemon.start"'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(output, /"daemon.start"/, "the daemon started over the interrupted delete");
    const after = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
      bots: { id: string }[];
    };
    assert.deepEqual(after.bots, [], "startup reconciliation finished the delete");
    await access(join(root, "trash", "b_crash"));

    const logs = (await readdir(join(root, "logs"))).filter((name) => name.endsWith(".jsonl"));
    const records = (
      await Promise.all(logs.map((name) => readFile(join(root, "logs", name), "utf8")))
    )
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { evt: string; trace: string; botId?: string });
    const reconciled = records.filter((record) => record.evt === "core.reconcile.ok");
    assert.ok(reconciled.length > 0, "the restart records what it finished");
    assert.ok(
      records.every((record) => record.evt !== "core.delete.fail"),
      "a killed process cannot log a failure it never saw",
    );
  } finally {
    daemon.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
