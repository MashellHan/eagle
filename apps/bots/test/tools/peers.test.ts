// The peer tools' model-facing surface (docs/bots/EXTENSIONS-AND-TOOLS.md §6.4): three tools, a
// bounded result, and a prompt that states the budget and the stopping rule.
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INVOCATION_TEXT } from "../../src/core/Invocation.ts";
import {
  createPeerTools,
  PEERS_TOOLS_EXTENSION,
  peersSection,
} from "../../src/tools/peers/tools.ts";
import type { PeerToolHost } from "../../src/tools/types.ts";

type Call = {
  readonly name: string;
  readonly parameters: unknown;
  execute: (
    args: unknown,
    api: unknown,
    context: unknown,
  ) => Promise<{ output: readonly { type: "text"; text: string }[]; isError?: boolean }>;
};

const api = (taskId = "t_42") => ({ taskId }) as never;
const context = {} as never;

type Outcome = { output: string; isError?: boolean };

const run = async (tool: Call, args: unknown, taskId?: string): Promise<Outcome> => {
  const value = await tool.execute(args, api(taskId), context);
  return {
    output: value.output.map((item) => item.text).join("\n"),
    ...(value.isError === true ? { isError: true as const } : {}),
  };
};

const bench = (overrides: Partial<PeerToolHost> = {}) => {
  const calls: Array<{ toBotId?: string; message?: string }> = [];
  const host: PeerToolHost = {
    botId: "b_self",
    maxMessage: MAX_INVOCATION_TEXT,
    list: async () => ({
      items: [
        { botId: "b_target", title: "VPS管家", availability: "idle" },
        { botId: "b_other", title: "发布管家", availability: "working" },
      ],
    }),
    send: async (input) => {
      calls.push({ toBotId: input.toBotId, message: input.message });
      return {
        toBotId: input.toBotId,
        requestId: "pr_0123456789abcdef",
        status: "queued",
        exchangeId: "x_0123456789ab",
        sent: 3,
        remaining: 7,
        exchangeStatus: "open",
      };
    },
    read: async (input) => ({
      requestId: input.requestId,
      toBotId: "b_target",
      status: "done",
      answer: "收到，已经在修了。",
    }),
    receipts: async () => [
      {
        requestId: "pr_0123456789abcdef",
        toBotId: "b_target",
        at: "2026-10-29T00:00:00.000Z",
        status: "done",
      },
    ],
    ...overrides,
  };
  const tools = createPeerTools(host) as unknown as readonly Call[];
  const byName = (name: string): Call => {
    const found = tools.find((tool) => tool.name === name);
    assert.ok(found, `${name} is registered`);
    return found;
  };
  return { host, tools, byName, calls };
};

test("the extension registers exactly the three peer tools", () => {
  const { tools } = bench();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["peer_list", "peer_send", "peer_read"],
  );
  assert.equal(PEERS_TOOLS_EXTENSION, "bots-peers");
});

test("peer_list renders one line per bot and says so when there is nobody", async () => {
  const listed = await run(bench().byName("peer_list"), {});
  assert.equal(listed.isError, undefined);
  assert.match(listed.output, /b_target · VPS管家 · idle/);
  assert.match(listed.output, /b_other · 发布管家 · working/);

  const empty = bench({ list: async () => ({ items: [] }) });
  const none = await run(empty.byName("peer_list"), {});
  assert.match(none.output, /no other bots to message/);
});

test("peer_send reports admission and the remaining budget, never an answer", async () => {
  const subject = bench();
  const sent = await run(subject.byName("peer_send"), {
    botId: "b_target",
    message: "看一下 us2 的构建",
  });
  assert.equal(sent.isError, undefined);
  assert.match(sent.output, /admitted · to=b_target/);
  assert.match(sent.output, /pr_0123456789abcdef · queued/);
  assert.match(sent.output, /7 more message\(s\) allowed/);
  assert.equal(subject.calls.at(-1)?.message, "看一下 us2 的构建");
});

test("a spent side is told to stop, and a refused host is a readable error", async () => {
  const spent = bench({
    send: async (input) => ({
      toBotId: input.toBotId,
      requestId: "pr_0123456789abcdef",
      status: "queued",
      exchangeId: "x_0123456789ab",
      sent: 10,
      remaining: 0,
      exchangeStatus: "open",
    }),
  });
  const last = await run(spent.byName("peer_send"), { botId: "b_target", message: "again" });
  assert.match(last.output, /this side of the exchange is now spent/);

  const refused = bench({
    send: async () => {
      throw new Error("you have already sent 10 messages in this exchange; it is time to stop");
    },
  });
  const failure = await run(refused.byName("peer_send"), { botId: "b_target", message: "again" });
  assert.equal(failure.isError, true);
  assert.match(failure.output, /already sent 10 messages/);
});

test("an over-long message is refused before it reaches the daemon", async () => {
  const subject = bench();
  const failure = await run(subject.byName("peer_send"), {
    botId: "b_target",
    message: "x".repeat(MAX_INVOCATION_TEXT + 1),
  });
  assert.equal(failure.isError, true);
  assert.match(failure.output, /at most 8000/);
  assert.equal(subject.calls.length, 0);
});

test("peer_read reads one answer, or lists this bot's own receipts", async () => {
  const subject = bench();
  const one = await run(subject.byName("peer_read"), { requestId: "pr_0123456789abcdef" });
  assert.match(one.output, /pr_0123456789abcdef · to=b_target · done/);
  assert.match(one.output, /收到，已经在修了。/);

  const list = await run(subject.byName("peer_read"), {});
  assert.match(list.output, /pr_0123456789abcdef · to=b_target · done/);

  const empty = bench({ receipts: async () => [] });
  const none = await run(empty.byName("peer_read"), {});
  assert.match(none.output, /no messages sent yet/);
});

test("the prompt states the budget, the stop rule and that a send is not an answer", () => {
  const prompt = peersSection("b_self");
  assert.match(prompt, /at most 10 messages/);
  assert.match(prompt, /peer_send is refused/);
  assert.match(prompt, /Stop when the exchange stops making progress/);
  assert.match(prompt, /admission, not an answer/);
  assert.match(prompt, /queued or placed/);
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /b_self/);
});
