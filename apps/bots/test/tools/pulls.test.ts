// The pull-request tools (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group): the model reports a
// link, a title and one of the closed states, and a refusal is a result it can read.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPullTools,
  PULLS_TOOLS_EXTENSION,
  pullSection,
} from "../../src/tools/pulls/tools.ts";
import { PULL_STATUSES, type PullToolHost, type PullView } from "../../src/tools/types.ts";

type Call = {
  readonly name: string;
  execute(
    args: unknown,
    api: unknown,
    context: unknown,
  ): Promise<{ output: readonly { type: "text"; text: string }[]; isError?: boolean }>;
};

const api = (taskId = "t_42") => ({ taskId }) as never;
const context = {} as never;

const run = async (tool: Call, args: unknown, taskId?: string) => {
  const value = await tool.execute(args, api(taskId), context);
  return {
    output: value.output.map((block) => block.text).join("\n"),
    isError: value.isError === true,
  };
};

const pull = (overrides: Partial<PullView> = {}): PullView => ({
  url: "https://github.com/nocoo/eagle/pull/490",
  title: "v3.1.1 补丁版",
  status: "open",
  host: "github.com",
  updatedAt: "2026-10-30T10:00:00.000Z",
  ...overrides,
});

const bench = (overrides: Partial<PullToolHost> = {}) => {
  const calls: Array<{ url?: string; title?: string; status?: string; opId?: string }> = [];
  const host: PullToolHost = {
    botId: "b_self",
    register: async (input) => {
      calls.push(input);
      return { pull: pull({ status: input.status, title: input.title }), created: true };
    },
    list: async () => [pull()],
    ...overrides,
  };
  const tools = createPullTools(host) as unknown as readonly Call[];
  const byName = (name: string): Call => {
    const found = tools.find((tool) => tool.name === name);
    assert.ok(found, `${name} is registered`);
    return found;
  };
  return { host, tools, byName, calls };
};

test("the coding group carries exactly the two report tools", () => {
  const { tools } = bench();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["pr_register", "pr_list"],
  );
  assert.equal(PULLS_TOOLS_EXTENSION, "bots-pulls");
});

test("pr_register stores the report and answers with what it stored", async () => {
  const subject = bench();
  const result = await run(subject.byName("pr_register"), {
    url: "https://github.com/nocoo/eagle/pull/490",
    title: "v3.1.1 补丁版",
    status: "merged",
  });
  assert.equal(result.isError, false);
  assert.match(result.output, /^registered: merged · v3\.1\.1 补丁版/);
  assert.equal(subject.calls[0]?.status, "merged");
});

test("every closed state is accepted, and anything else is refused before the store", async () => {
  for (const status of PULL_STATUSES) {
    const subject = bench();
    const result = await run(subject.byName("pr_register"), {
      url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12",
      title: "fix",
      status,
    });
    assert.equal(result.isError, false, `${status} is a state`);
  }
  const refused = bench();
  const result = await run(refused.byName("pr_register"), {
    url: "https://github.com/nocoo/eagle/pull/490",
    title: "fix",
    status: "reopened",
  });
  assert.equal(result.isError, true);
  assert.match(result.output, /status must be one of/);
  assert.equal(refused.calls.length, 0);
});

test("a store refusal reaches the model as a readable result", async () => {
  const refused = bench({
    register: async () => {
      throw new Error('"not-a-link" is not a link');
    },
  });
  const result = await run(refused.byName("pr_register"), {
    url: "not-a-link",
    title: "fix",
    status: "open",
  });
  assert.equal(result.isError, true);
  assert.match(result.output, /is not a link/);
});

test("pr_list shows what was reported, and says so when nothing was", async () => {
  const listed = await run(bench().byName("pr_list"), {});
  assert.match(listed.output, /open · v3\.1\.1 补丁版 · https:\/\/github\.com/);

  const empty = bench({ list: async () => [] });
  const none = await run(empty.byName("pr_list"), {});
  assert.match(none.output, /no pull requests registered/);
});

test("the prompt says reports are the only source, and every change must be reported", () => {
  const prompt = pullSection("b_self");
  assert.match(prompt, /never queries the forge/);
  assert.match(prompt, /Report every state change/);
  assert.match(prompt, /b_self/);
});
