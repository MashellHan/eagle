// The herdr tools (docs/bots/RUNTIME.md, "Herdr tools"): one space per bot, a controller
// it starts there, and nothing else in the session reachable. The client is faked here;
// the real CLI's response shapes are checked by the client's own contract test.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  type HerdrAgentInfo,
  type HerdrClient,
  HerdrCommandError,
  type HerdrCreation,
  type HerdrPaneInfo,
  type HerdrReadSource,
  type HerdrWorkspaceInfo,
} from "../../src/tools/herdr/client.ts";
import {
  agentPrefixOf,
  createHerdrTools,
  HERDR_TOOLS_EXTENSION,
  herdrSection,
  spaceLabelOf,
} from "../../src/tools/herdr/tools.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

type Call = { readonly method: string; readonly input: unknown };

class FakeHerdr implements HerdrClient {
  readonly calls: Call[] = [];
  readonly workspaces: HerdrWorkspaceInfo[] = [];
  readonly agents: HerdrAgentInfo[] = [];
  readonly panesBySpace = new Map<string, HerdrPaneInfo[]>();
  answer = "the answer";
  failWith: HerdrCommandError | undefined;
  getError: HerdrCommandError | undefined;
  createError: HerdrCommandError | undefined;
  closeError: HerdrCommandError | undefined;
  startError: HerdrCommandError | undefined;
  keepAgentOnStartError = false;
  readDelayMs = 0;
  nextId = 1;

  #record(method: string, input: unknown): void {
    this.calls.push({ method, input });
    if (this.failWith !== undefined) throw this.failWith;
  }

  async listWorkspaces(): Promise<readonly HerdrWorkspaceInfo[]> {
    this.#record("listWorkspaces", undefined);
    return this.workspaces;
  }

  async createWorkspace(input: { label: string; cwd: string }): Promise<HerdrCreation> {
    this.#record("createWorkspace", input);
    if (this.createError !== undefined) throw this.createError;
    const id = `w${this.nextId}`;
    this.nextId += 1;
    this.workspaces.push({ id, label: input.label });
    const rootPaneId = `${id}:p1`;
    this.panesBySpace.set(id, [{ paneId: rootPaneId, workspaceId: id }]);
    return { workspaceId: id, tabId: `${id}:t1`, rootPaneId };
  }

  async closeWorkspace(id: string): Promise<void> {
    this.#record("closeWorkspace", id);
    if (this.closeError !== undefined) throw this.closeError;
    const index = this.workspaces.findIndex((space) => space.id === id);
    if (index >= 0) this.workspaces.splice(index, 1);
    this.panesBySpace.delete(id);
  }

  async getWorkspace(id: string): Promise<HerdrWorkspaceInfo | undefined> {
    this.#record("getWorkspace", id);
    if (this.getError !== undefined) throw this.getError;
    return this.workspaces.find((space) => space.id === id);
  }

  async listAgents(): Promise<readonly HerdrAgentInfo[]> {
    this.#record("listAgents", undefined);
    return this.agents;
  }

  async listPanes(workspaceId: string): Promise<readonly HerdrPaneInfo[]> {
    this.#record("listPanes", workspaceId);
    return this.panesBySpace.get(workspaceId) ?? [];
  }

  async startAgent(input: {
    name: string;
    kind: string;
    paneId: string;
    args?: readonly string[];
  }): Promise<void> {
    this.#record("startAgent", input);
    if (this.startError !== undefined && !this.keepAgentOnStartError) throw this.startError;
    const space = [...this.panesBySpace.entries()].find(([, panes]) =>
      panes.some((pane) => pane.paneId === input.paneId),
    );
    this.agents.push({
      name: input.name,
      kind: input.kind,
      status: "idle",
      paneId: input.paneId,
      workspaceId: space?.[0] ?? "",
    });
    if (this.startError !== undefined) throw this.startError;
  }

  async prompt(input: { target: string; text: string; wait?: boolean }): Promise<string> {
    this.#record("prompt", input);
    return "idle";
  }

  async wait(input: { target: string; until?: readonly string[] }): Promise<string> {
    this.#record("wait", input);
    return "idle";
  }

  async read(input: { target: string; lines?: number; source?: HerdrReadSource }): Promise<string> {
    this.#record("read", input);
    if (this.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
    return this.answer;
  }

  async sendKeys(input: { target: string; keys: readonly string[] }): Promise<void> {
    this.#record("sendKeys", input);
    if (this.failWith !== undefined) throw this.failWith;
  }
}

const bench = async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-herdr-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a-bot", "workspace"), daemonRoot);
  const stateDir = join(daemonRoot, "bots", "a-bot");
  const client = new FakeHerdr();
  const tools = createHerdrTools({ client, workspace, stateDir, botId: "a-bot" });
  const call = async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} is installed`);
    const context = { abortSignal: new AbortController().signal } as never;
    const outcome = (await (tool as ToolRegistration).execute(
      args as never,
      {} as never,
      context,
    )) as { output: { text: string }[]; isError?: boolean };
    return {
      text: outcome.output.map((part) => part.text).join(""),
      isError: outcome.isError === true,
    };
  };
  return {
    client,
    tools,
    call,
    statePath: join(stateDir, "herdr.json"),
    cleanup: () => rm(daemonRoot, { recursive: true, force: true }),
  };
};

test("open_space creates one labelled space and reuses it", async () => {
  const bench_ = await bench();
  try {
    const first = await bench_.call("herdr_open_space", {});
    assert.equal(first.isError, false);
    assert.match(first.text, new RegExp(`space w1 \\(${spaceLabelOf("a-bot")}-[a-z0-9]{4}\\)`));
    assert.match(first.text, /root pane w1:p1/);
    assert.equal(bench_.client.calls.filter((call) => call.method === "createWorkspace").length, 1);
    assert.equal((await stat(bench_.statePath)).mode & 0o777, 0o600);

    const second = await bench_.call("herdr_open_space", {});
    assert.match(second.text, /is open/);
    assert.equal(bench_.client.calls.filter((call) => call.method === "createWorkspace").length, 1);
  } finally {
    await bench_.cleanup();
  }
});

test("start_controller validates the kind, the name and the space", async () => {
  const bench_ = await bench();
  try {
    const withoutSpace = await bench_.call("herdr_start_controller", { kind: "codex" });
    assert.equal(withoutSpace.isError, true);
    assert.match(withoutSpace.text, /open_space/);

    await bench_.call("herdr_open_space", {});
    const badKind = await bench_.call("herdr_start_controller", { kind: "nope" });
    assert.equal(badKind.isError, true);
    const badName = await bench_.call("herdr_start_controller", {
      kind: "codex",
      name: "Bad Name",
    });
    assert.equal(badName.isError, true);

    const started = await bench_.call("herdr_start_controller", {
      kind: "codex",
      args: ["-m", "group/auto-gpt-6-astra"],
    });
    assert.equal(started.isError, false);
    assert.match(
      started.text,
      new RegExp(`started codex as ${agentPrefixOf("a-bot")}-codex in w1:p1`),
    );
    const startCall = bench_.client.calls.find((call) => call.method === "startAgent");
    assert.deepEqual(startCall?.input, {
      name: `${agentPrefixOf("a-bot")}-codex`,
      kind: "codex",
      paneId: "w1:p1",
      args: ["-m", "group/auto-gpt-6-astra"],
    });

    const again = await bench_.call("herdr_start_controller", { kind: "codex" });
    assert.match(again.text, /already running/);
  } finally {
    await bench_.cleanup();
  }
});

test("list shows only this bot's space", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_start_controller", { kind: "pi" });
    bench_.client.agents.push({
      name: "foreign",
      kind: "codex",
      status: "idle",
      paneId: "w9:pE",
      workspaceId: "w9",
    });
    const listed = await bench_.call("herdr_list", {});
    assert.match(listed.text, /w1:p1 controller: pi /);
    assert.equal(listed.text.includes("foreign"), false);
  } finally {
    await bench_.cleanup();
  }
});

test("send defaults to the controller and refuses a foreign target", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    const noController = await bench_.call("herdr_send", { text: "hi" });
    assert.equal(noController.isError, true);

    await bench_.call("herdr_start_controller", { kind: "pi" });
    const sent = await bench_.call("herdr_send", { text: "do the work" });
    assert.equal(sent.isError, false);
    assert.match(sent.text, /sent to w1:p1: idle/);
    const prompt = bench_.client.calls.find((call) => call.method === "prompt");
    assert.deepEqual(prompt?.input, {
      target: "w1:p1",
      text: "do the work",
      wait: true,
    });

    bench_.client.agents.push({
      name: "foreign",
      kind: "codex",
      status: "idle",
      paneId: "w9:pE",
      workspaceId: "w9",
    });
    const foreign = await bench_.call("herdr_send", { target: "foreign", text: "hi" });
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, /no agent foreign/);
  } finally {
    await bench_.cleanup();
  }
});

test("read keeps the newest text and caps it", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_start_controller", { kind: "pi" });
    const short = await bench_.call("herdr_read", {});
    assert.equal(short.text, "the answer");
    const read = bench_.client.calls.find((call) => call.method === "read");
    assert.deepEqual(read?.input, {
      target: "w1:p1",
      lines: 200,
      source: "recent-unwrapped",
    });

    bench_.client.answer = `${"a".repeat(70 * 1024)}TAIL`;
    const big = await bench_.call("herdr_read", { lines: 10 });
    assert.match(big.text, /^\[showing the last \d+ bytes\]/);
    assert.ok(big.text.endsWith("TAIL"));
    assert.ok(Buffer.byteLength(big.text) < 65_600);
  } finally {
    await bench_.cleanup();
  }
});

test("wait, keys and close validate their inputs and the space", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_start_controller", { kind: "pi" });
    assert.equal((await bench_.call("herdr_wait", { until: ["nope"] })).isError, true);
    assert.equal((await bench_.call("herdr_keys", { keys: [] })).isError, true);
    assert.equal((await bench_.call("herdr_keys", { keys: ["ctrl+c"] })).isError, false);
    assert.equal((await bench_.call("herdr_read", { source: "nope" })).isError, true);
    assert.equal((await bench_.call("herdr_read", { lines: 0 })).isError, true);

    const closed = await bench_.call("herdr_close_space", {});
    assert.match(closed.text, /closed space w1/);
    assert.equal(
      await stat(bench_.statePath).then(
        () => true,
        () => false,
      ),
      false,
    );
    const again = await bench_.call("herdr_close_space", {});
    assert.match(again.text, /no herdr space is open/);
  } finally {
    await bench_.cleanup();
  }
});

test("a recorded space with another label is never touched", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    // The fake renames the space out from under the bot.
    bench_.client.workspaces[0] = { id: "w1", label: "someone-else" };
    const read = await bench_.call("herdr_read", {});
    assert.equal(read.isError, true);
    assert.match(read.text, /not this bot's own space/);
    const close = await bench_.call("herdr_close_space", {});
    assert.equal(close.isError, true);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "closeWorkspace"),
      false,
    );

    // A stale id (the space is gone) says how to recover.
    bench_.client.workspaces.length = 0;
    const gone = await bench_.call("herdr_read", {});
    assert.equal(gone.isError, true);
    assert.match(gone.text, /open_space again/);
  } finally {
    await bench_.cleanup();
  }
});

test("a herdr failure is a result the model can read", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_start_controller", { kind: "pi" });
    bench_.client.failWith = new HerdrCommandError(
      "agent_blocked",
      "the agent is waiting at a dialog",
    );
    const sent = await bench_.call("herdr_send", { text: "hi" });
    assert.equal(sent.isError, true);
    assert.match(sent.text, /agent_blocked: the agent is waiting at a dialog/);
  } finally {
    await bench_.cleanup();
  }
});

test("the extension name, label and section are the contract", async () => {
  assert.equal(HERDR_TOOLS_EXTENSION, "bots-herdr");
  assert.equal(spaceLabelOf("9F1C2E7A-0000"), "bots-9f1c2e7a");
  assert.equal(spaceLabelOf("a-bot"), "bots-abot");
  assert.equal(agentPrefixOf("9F1C2E7A-0000"), "bot-9f1c2e7a");
  const section = herdrSection("a-bot");
  assert.match(section, /bots-abot/);
  assert.match(section, /Only agents and panes inside that space/);
});

test("a recorded root pane outside the space is refused, not started", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    const state = JSON.parse(await readFile(bench_.statePath, "utf8")) as Record<string, unknown>;
    // A tampered state file points the root pane at a user's pane.
    bench_.client.panesBySpace.set("w9", [{ paneId: "w9:p1", workspaceId: "w9" }]);
    await writeFile(bench_.statePath, JSON.stringify({ ...state, rootPaneId: "w9:p1" }));
    const started = await bench_.call("herdr_start_controller", { kind: "pi" });
    assert.equal(started.isError, true);
    assert.match(started.text, /not this bot's own space/);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "startAgent"),
      false,
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a replacement with the same id and label is refused, and open starts over", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    const state = JSON.parse(await readFile(bench_.statePath, "utf8")) as { spaceLabel: string };
    // A user workspace takes the id and the label but has a different pane.
    bench_.client.panesBySpace.set("w1", [{ paneId: "w1:p9", workspaceId: "w1" }]);
    const read = await bench_.call("herdr_read", {});
    assert.equal(read.isError, true);
    assert.match(read.text, /not this bot's own space/);
    const close = await bench_.call("herdr_close_space", {});
    assert.equal(close.isError, true);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "closeWorkspace"),
      false,
    );

    const opened = await bench_.call("herdr_open_space", {});
    assert.match(opened.text, /opened space w2/);
    const saved = JSON.parse(await readFile(bench_.statePath, "utf8")) as {
      spaceId: string;
      spaceLabel: string;
    };
    assert.equal(saved.spaceId, "w2");
    assert.notEqual(saved.spaceLabel, state.spaceLabel);
    assert.equal(bench_.client.calls.filter((call) => call.method === "createWorkspace").length, 2);
  } finally {
    await bench_.cleanup();
  }
});

test("a queued call cancelled by the run's abort has no side effect", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_start_controller", { kind: "pi" });
    bench_.client.readDelayMs = 80;
    const controller = new AbortController();
    const context = { abortSignal: controller.signal } as never;
    const readTool = bench_.tools.find((tool) => tool.name === "herdr_read");
    const sendTool = bench_.tools.find((tool) => tool.name === "herdr_send");
    assert.ok(readTool !== undefined && sendTool !== undefined);
    const invoke = (tool: ToolRegistration, args: unknown) =>
      tool.execute?.(args as never, {} as never, context);
    assert.ok(invoke !== undefined);
    const reading = invoke(readTool, {});
    const sending = invoke(sendTool, { text: "should not run" });
    setTimeout(() => controller.abort(), 10);
    await reading;
    const sent = (await sending) as { output: { text: string }[]; isError?: boolean };
    assert.equal(sent.isError, true);
    assert.match(sent.output.map((part) => part.text).join(""), /aborted/);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "prompt"),
      false,
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a stale space id is replaced by a fresh space", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    bench_.client.workspaces.length = 0;
    bench_.client.getError = new HerdrCommandError("workspace_not_found", "no such workspace");
    const reopened = await bench_.call("herdr_open_space", {});
    assert.equal(reopened.isError, false);
    assert.match(reopened.text, /opened space w2/);
  } finally {
    await bench_.cleanup();
  }
});

test("a corrupt state adopts the one matching space instead of leaking a second", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    await writeFile(bench_.statePath, "{ half");
    const reopened = await bench_.call("herdr_open_space", {});
    assert.match(reopened.text, /reopened space w1/);
    assert.equal(bench_.client.calls.filter((call) => call.method === "createWorkspace").length, 1);
    const saved = JSON.parse(await readFile(bench_.statePath, "utf8")) as { spaceId: string };
    assert.equal(saved.spaceId, "w1");
  } finally {
    await bench_.cleanup();
  }
});

test("a space whose state cannot be saved is closed again", async () => {
  const bench_ = await bench();
  try {
    const stateDir = bench_.statePath.replace(/\/herdr\.json$/, "");
    await chmod(stateDir, 0o500);
    const opened = await bench_.call("herdr_open_space", {});
    assert.equal(opened.isError, true);
    assert.match(opened.text, /state could not be saved/);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "closeWorkspace"),
      true,
    );
  } finally {
    await chmod(bench_.statePath.replace(/\/herdr\.json$/, ""), 0o700).catch(() => undefined);
    await bench_.cleanup();
  }
});

test("a not-ready start still records the controller for the next call", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    bench_.client.startError = new HerdrCommandError("agent_not_ready", "the agent is starting");
    bench_.client.keepAgentOnStartError = true;
    const started = await bench_.call("herdr_start_controller", { kind: "pi" });
    assert.match(started.text, /agent_not_ready: the agent is starting \(recorded/);
    bench_.client.startError = undefined;
    const again = await bench_.call("herdr_start_controller", { kind: "pi" });
    assert.match(again.text, /already running/);
    const sent = await bench_.call("herdr_send", { text: "hello" });
    assert.equal(sent.isError, false);
  } finally {
    await bench_.cleanup();
  }
});

test("a record copied from another bot is refused and never adopted", async () => {
  const bench_ = await bench();
  try {
    // Bot B's space and B's full state file, copied into bot A's directory.
    bench_.client.nextId = 3;
    bench_.client.workspaces.push({ id: "w2", label: "bots-bbeta-b7oe" });
    bench_.client.panesBySpace.set("w2", [{ paneId: "w2:p1", workspaceId: "w2" }]);
    await writeFile(
      bench_.statePath,
      JSON.stringify({
        owner: "b-bot",
        spaceId: "w2",
        spaceLabel: "bots-bbeta-b7oe",
        rootPaneId: "w2:p1",
      }),
    );
    const read = await bench_.call("herdr_read", {});
    assert.equal(read.isError, true);
    assert.match(read.text, /not this bot's own space/);
    const close = await bench_.call("herdr_close_space", {});
    assert.equal(close.text.includes("not this bot's own space"), true);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "closeWorkspace"),
      false,
    );

    const opened = await bench_.call("herdr_open_space", {});
    assert.match(opened.text, /opened space w3/);
    const saved = JSON.parse(await readFile(bench_.statePath, "utf8")) as {
      owner: string;
      spaceId: string;
    };
    assert.equal(saved.owner, "a-bot");
    assert.equal(saved.spaceId, "w3");
  } finally {
    await bench_.cleanup();
  }
});

test("a refused replacement is not adopted even after a failed create", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    // The user takes over w1 with the same id and label but a different pane.
    bench_.client.panesBySpace.set("w1", [{ paneId: "w1:p9", workspaceId: "w1" }]);
    bench_.client.createError = new HerdrCommandError("create_failed", "cannot create");
    const refused = await bench_.call("herdr_open_space", {});
    assert.equal(refused.isError, true);
    const record = JSON.parse(await readFile(bench_.statePath, "utf8")) as { revoked: boolean };
    assert.equal(record.revoked, true);

    bench_.client.createError = undefined;
    const opened = await bench_.call("herdr_open_space", {});
    assert.match(opened.text, /opened space w2/);
    const saved = JSON.parse(await readFile(bench_.statePath, "utf8")) as { spaceId: string };
    assert.notEqual(saved.spaceId, "w1");
    assert.equal(bench_.client.calls.filter((call) => call.method === "closeWorkspace").length, 0);

    // Closing the new space must not resurrect the refused replacement either.
    await bench_.call("herdr_close_space", {});
    const again = await bench_.call("herdr_open_space", {});
    assert.match(again.text, /opened space w3/);
    const after = JSON.parse(await readFile(bench_.statePath, "utf8")) as { spaceId: string };
    assert.notEqual(after.spaceId, "w1");
  } finally {
    await bench_.cleanup();
  }
});

test("a failed rollback reports the space it left behind", async () => {
  const bench_ = await bench();
  try {
    const stateDir = bench_.statePath.replace(/\/herdr\.json$/, "");
    await chmod(stateDir, 0o500);
    bench_.client.closeError = new HerdrCommandError("close_failed", "cannot close");
    const opened = await bench_.call("herdr_open_space", {});
    assert.equal(opened.isError, true);
    assert.match(opened.text, /could not be closed \(close_failed: cannot close\)/);
    assert.match(opened.text, /close it manually/);
  } finally {
    await chmod(bench_.statePath.replace(/\/herdr\.json$/, ""), 0o700).catch(() => undefined);
    await bench_.cleanup();
  }
});

const tombstonePathOf = (statePath: string): string =>
  statePath.replace(/herdr\.json$/, "herdr.revoked.json");

test("a long tombstone list never evicts a still-live refused space", async () => {
  const bench_ = await bench();
  try {
    const spaces = Array.from({ length: 25 }, (_, index) => ({
      spaceId: `w${index + 1}`,
      spaceLabel: `bots-abot-x${String(index).padStart(3, "0")}`,
    }));
    for (const space of spaces) {
      bench_.client.workspaces.push({ id: space.spaceId, label: space.spaceLabel });
      bench_.client.panesBySpace.set(space.spaceId, [
        { paneId: `${space.spaceId}:p1`, workspaceId: space.spaceId },
      ]);
    }
    bench_.client.nextId = 26;
    await writeFile(tombstonePathOf(bench_.statePath), JSON.stringify({ owner: "a-bot", spaces }));
    const opened = await bench_.call("herdr_open_space", {});
    assert.match(opened.text, /opened space w26/);
    const calledCreate = bench_.client.calls.filter((call) => call.method === "createWorkspace");
    assert.equal(calledCreate.length, 1);
    const record = JSON.parse(await readFile(tombstonePathOf(bench_.statePath), "utf8")) as {
      spaces: { spaceId: string }[];
    };
    assert.equal(
      record.spaces.some((space) => space.spaceId === "w1"),
      true,
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a failed tombstone write blocks the replacement instead of proceeding", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    bench_.client.panesBySpace.set("w1", [{ paneId: "w1:p9", workspaceId: "w1" }]);
    const { mkdir: makeDir } = await import("node:fs/promises");
    await makeDir(`${tombstonePathOf(bench_.statePath)}.tmp`, { recursive: true });
    const before = bench_.client.calls.filter((call) => call.method === "createWorkspace").length;
    const refused = await bench_.call("herdr_open_space", {});
    assert.equal(refused.isError, true);
    assert.match(refused.text, /could not be recorded/);
    assert.equal(
      bench_.client.calls.filter((call) => call.method === "createWorkspace").length,
      before,
    );
    assert.equal(
      bench_.client.calls.some((call) => call.method === "closeWorkspace"),
      false,
    );
  } finally {
    const { rm: remove } = await import("node:fs/promises");
    await remove(`${tombstonePathOf(bench_.statePath)}.tmp`, { recursive: true, force: true });
    await bench_.cleanup();
  }
});

test("a foreign tombstone is never trusted as an empty list", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    bench_.client.panesBySpace.set("w1", [{ paneId: "w1:p9", workspaceId: "w1" }]);
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_close_space", {});
    const record = JSON.parse(await readFile(tombstonePathOf(bench_.statePath), "utf8")) as {
      owner: string;
      spaces: { spaceId: string }[];
    };
    // Another owner's tombstone file still names w1: adoption must not proceed.
    await writeFile(
      tombstonePathOf(bench_.statePath),
      JSON.stringify({ owner: "b-bot", spaces: record.spaces }),
    );
    const reopened = await bench_.call("herdr_open_space", {});
    assert.match(reopened.text, /opened space w3/);
    assert.equal(
      bench_.client.calls.some((call) => call.method === "closeWorkspace"),
      true,
    );
    assert.equal(bench_.client.panesBySpace.get("w1")?.[0]?.paneId, "w1:p9");
  } finally {
    await bench_.cleanup();
  }
});

test("with both records removed, adoption resumes as documented", async () => {
  const bench_ = await bench();
  try {
    await bench_.call("herdr_open_space", {});
    bench_.client.panesBySpace.set("w1", [{ paneId: "w1:p9", workspaceId: "w1" }]);
    await bench_.call("herdr_open_space", {});
    await bench_.call("herdr_close_space", {});
    // Only a person can remove both files (the bot's own directory is not writable by the
    // model): with no memory left, the single matching label is adopted again.
    await rm(bench_.statePath, { force: true });
    await rm(tombstonePathOf(bench_.statePath), { force: true });
    const reopened = await bench_.call("herdr_open_space", {});
    assert.match(reopened.text, /reopened space w1/);
  } finally {
    await bench_.cleanup();
  }
});
