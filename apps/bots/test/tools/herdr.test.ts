// The herdr tools (docs/bots/RUNTIME.md, "Herdr tools"): one space per bot, a controller
// it starts there, and nothing else in the session reachable. The client is faked here;
// the real CLI's response shapes are checked by the client's own contract test.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
    const id = `w${this.nextId}`;
    this.nextId += 1;
    this.workspaces.push({ id, label: input.label });
    const rootPaneId = `${id}:p1`;
    this.panesBySpace.set(id, [{ paneId: rootPaneId, workspaceId: id }]);
    return { workspaceId: id, tabId: `${id}:t1`, rootPaneId };
  }

  async closeWorkspace(id: string): Promise<void> {
    this.#record("closeWorkspace", id);
    const index = this.workspaces.findIndex((space) => space.id === id);
    if (index >= 0) this.workspaces.splice(index, 1);
    this.panesBySpace.delete(id);
  }

  async getWorkspace(id: string): Promise<HerdrWorkspaceInfo | undefined> {
    this.#record("getWorkspace", id);
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
    assert.match(first.text, new RegExp(`space w1 \\(${spaceLabelOf("a-bot")}\\)`));
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
    assert.match(sent.text, new RegExp(`sent to ${agentPrefixOf("a-bot")}-pi: idle`));
    const prompt = bench_.client.calls.find((call) => call.method === "prompt");
    assert.deepEqual(prompt?.input, {
      target: `${agentPrefixOf("a-bot")}-pi`,
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
      target: `${agentPrefixOf("a-bot")}-pi`,
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
    assert.match(sent.text, /waiting at a dialog/);
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
