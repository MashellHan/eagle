// The herdr CLI client (docs/bots/RUNTIME.md, "Herdr tools"): one argv, JSON in, JSON out,
// a deadline that ends a hung call, and an abort that is not waited out. The binary is a
// script here, so the test is about this client, not about a live herdr server.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHerdrClient, HerdrCommandError } from "../../src/tools/herdr/client.ts";

const FAKE = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) appendFileSync(log, args.join(" ") + "\\n");
const out = (value) => { writeFileSync(1, JSON.stringify(value)); };
const first = args[0];
const second = args[1];
if (first === "workspace" && second === "create") {
  out({ result: { workspace: { workspace_id: "w7", label: process.env.FAKE_HERDR_LABEL ?? "bots-x" }, tab: { tab_id: "w7:t1" }, root_pane: { pane_id: "w7:p1" } } });
} else if (first === "workspace" && second === "list") {
  out({ result: { workspaces: [{ workspace_id: "w1", label: "one" }, { label: "no id" }] } });
} else if (first === "workspace" && second === "get") {
  out({ result: { workspace: { workspace_id: args[2], label: "bots-x" } } });
} else if (first === "workspace" && second === "close") {
  out({ result: { type: "ok" } });
} else if (first === "agent" && second === "list") {
  out({ result: { agents: [{ agent: "pi", agent_status: "idle", pane_id: "w7:p1", workspace_id: "w7", name: "bot-x" }, { agent: "codex" }] } });
} else if (first === "pane" && second === "list") {
  out({ result: { panes: [{ pane_id: "w7:p1", workspace_id: "w7" }] } });
} else if (first === "agent" && second === "read") {
  writeFileSync(1, "screen\\ntext\\n");
} else if (first === "agent" && second === "prompt") {
  if (process.env.FAKE_HERDR_ERROR === "1") {
    out({ error: { code: "agent_blocked", message: "waiting at a dialog" } });
    process.exitCode = 1;
  } else {
    out({ result: { state: "idle" } });
  }
} else if (first === "agent" && second === "start") {
  out({ result: { type: "ok" } });
} else if (first === "agent" && second === "wait") {
  setTimeout(() => out({ result: { state: "done" } }), 5000);
} else if (first === "agent" && second === "send-keys") {
  process.exitCode = 3;
  writeFileSync(2, process.env.FAKE_HERDR_ERROR === "1" ? JSON.stringify({ error: { code: "agent_blocked", message: "waiting at a dialog" } }) : "no such key");
} else if (first === "error" && second === "json") {
  out({ error: { code: "agent_blocked", message: "waiting at a dialog" } });
  process.exitCode = 1;
} else {
  writeFileSync(2, "unexpected " + args.join(" "));
  process.exitCode = 2;
}
`;

const bench = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-herdr-cli-"));
  const binary = join(dir, "fake-herdr");
  await writeFile(binary, FAKE, { mode: 0o700 });
  await chmod(binary, 0o700);
  const log = join(dir, "calls.log");
  const client = createHerdrClient({ binary, env: { FAKE_HERDR_LOG: log } });
  const failing = createHerdrClient({
    binary,
    env: { FAKE_HERDR_LOG: log, FAKE_HERDR_ERROR: "1" },
  });
  const calls = async (): Promise<string[]> =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { client, failing, calls, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

test("workspace and agent responses are parsed, not guessed", async () => {
  const bench_ = await bench();
  try {
    const created = await bench_.client.createWorkspace({ label: "bots-x", cwd: "/tmp" });
    assert.deepEqual(created, { workspaceId: "w7", tabId: "w7:t1", rootPaneId: "w7:p1" });
    const spaces = await bench_.client.listWorkspaces();
    assert.deepEqual(spaces, [{ id: "w1", label: "one" }]);
    const space = await bench_.client.getWorkspace("w7");
    assert.deepEqual(space, { id: "w7", label: "bots-x" });
    await bench_.client.closeWorkspace("w7");
    assert.equal(
      (await bench_.calls())[0],
      "workspace create --cwd /tmp --label bots-x --no-focus",
    );
    assert.equal((await bench_.calls()).at(-1), "workspace close w7");
  } finally {
    await bench_.cleanup();
  }
});

test("agents, panes and reads map the CLI's own fields", async () => {
  const bench_ = await bench();
  try {
    const agents = await bench_.client.listAgents();
    assert.deepEqual(agents, [
      { name: "bot-x", kind: "pi", status: "idle", paneId: "w7:p1", workspaceId: "w7" },
    ]);
    const panes = await bench_.client.listPanes("w7");
    assert.deepEqual(panes, [{ paneId: "w7:p1", workspaceId: "w7" }]);
    assert.equal(await bench_.client.read({ target: "bot-x", lines: 5 }), "screen\ntext");
    assert.equal(
      (await bench_.calls()).at(-1),
      "agent read bot-x --format text --source recent-unwrapped --lines 5",
    );
    await bench_.client.startAgent({
      name: "bot-x",
      kind: "pi",
      paneId: "w7:p1",
      args: ["-m", "x"],
    });
    assert.deepEqual(
      (await bench_.calls()).at(-1),
      "agent start bot-x --kind pi --pane w7:p1 -- -m x",
    );
    assert.equal(await bench_.client.prompt({ target: "bot-x", text: "hi", wait: true }), "idle");
    assert.deepEqual((await bench_.calls()).at(-1), "agent prompt bot-x hi --wait");
  } finally {
    await bench_.cleanup();
  }
});

test("a herdr JSON error becomes code and message", async () => {
  const bench_ = await bench();
  try {
    await assert.rejects(
      () => bench_.failing.prompt({ target: "x", text: "y" }),
      (error: unknown) =>
        error instanceof HerdrCommandError &&
        error.code === "agent_blocked" &&
        /waiting at a dialog/.test(error.message),
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a hung call ends at its deadline", async () => {
  const bench_ = await bench();
  try {
    const started = Date.now();
    await assert.rejects(
      () => bench_.client.wait({ target: "bot-x" }, { timeoutMs: 200 }),
      (error: unknown) => error instanceof HerdrCommandError && error.code === "timeout",
    );
    assert.ok(Date.now() - started < 1_500);
  } finally {
    await bench_.cleanup();
  }
});

test("an abort ends a hung call at once", async () => {
  const bench_ = await bench();
  try {
    const controller = new AbortController();
    const started = Date.now();
    const running = bench_.client.wait(
      { target: "bot-x" },
      { signal: controller.signal, timeoutMs: 60_000 },
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => running,
      (error: unknown) => error instanceof HerdrCommandError && error.code === "aborted",
    );
    assert.ok(Date.now() - started < 1_000);
  } finally {
    await bench_.cleanup();
  }
});

test("a JSON error on stderr keeps its code", async () => {
  const bench_ = await bench();
  try {
    await assert.rejects(
      () => bench_.failing.sendKeys({ target: "bot-x", keys: ["nope"] }),
      (error: unknown) =>
        error instanceof HerdrCommandError &&
        error.code === "agent_blocked" &&
        /waiting at a dialog/.test(error.message),
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a non-JSON failure reports the exit and the detail", async () => {
  const bench_ = await bench();
  try {
    await assert.rejects(
      () => bench_.client.sendKeys({ target: "bot-x", keys: ["nope"] }),
      (error: unknown) =>
        error instanceof HerdrCommandError &&
        error.code === "herdr_failed" &&
        /exit 3/.test(error.message) &&
        /no such key/.test(error.message),
    );
  } finally {
    await bench_.cleanup();
  }
});
