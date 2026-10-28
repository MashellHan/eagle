// Web search as a bot tool (docs/bots/EXTENSIONS-AND-TOOLS.md, "search"): the daemon supplies
// the client from the saved provider key, the group stays off unless selected, and each
// performed call is booked in the usage statistics.
import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import type { UsageEntry } from "../../src/tools/usage.ts";
import { assistant, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

const settle = async (events: RuntimeEvent[], what: string) =>
  waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    what,
    10_000,
  );

const toolResults = (events: RuntimeEvent[]) =>
  events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .flatMap((block) => (block.type === "toolResult" ? [block] : []));

test("the search group loads its deferred tools and books one call each", async () => {
  const queries: string[] = [];
  const bookings: UsageEntry[] = [];
  const bench = await createBench({
    search: () => ({
      search: async ({ query }) => {
        queries.push(query);
        return [{ title: "T", url: "https://e.com", snippet: "s", summary: "summary" }];
      },
      fetchPage: async ({ url }) => ({ url, title: "T", content: "body" }),
    }),
    usage: { record: (entry) => bookings.push(entry) },
  });
  try {
    bench.faux.setResponses([
      assistant([toolCall("tool_search", { query: "web" })], { stopReason: "toolUse" }),
      assistant([toolCall("web_search", { query: "DeepSeek" })], { stopReason: "toolUse" }),
      assistant("done"),
    ]);
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "search"] });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await handle.submit({
      requestId: "r_search_1",
      text: "搜一下 DeepSeek",
      whenBusy: "followUp",
      trace,
    });
    await settle(events, "the search run");
    const results = toolResults(events);
    const search = results.find((block) => block.name === "web_search");
    assert.ok(search, `web_search ran (${results.map((block) => block.name).join(",")})`);
    assert.equal(search.isError, false, search.text);
    assert.deepEqual(queries, ["DeepSeek"]);
    assert.deepEqual(bookings, [{ botId: "b_runtime", source: "search", calls: 1 }]);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("selecting search without a provider key offers neither the tools nor the loader", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "search"] });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      (context) =>
        assistant(JSON.stringify(getCurrentTools(context.messages).map((tool) => tool.name))),
    ]);
    await handle.submit({
      requestId: "r_search_2",
      text: "report available tools",
      whenBusy: "followUp",
      trace,
    });
    await settle(events, "the answer without a client");
    const block = toolResults(events);
    assert.deepEqual(block, [], "no tool ran");
    const answer = events
      .filter((event) => event.type === "append" && event.message.role === "assistant")
      .at(-1);
    assert.ok(answer?.type === "append");
    const text = answer.message.blocks[0];
    assert.ok(text?.type === "text");
    const offered = JSON.parse(text.text) as string[];
    assert.equal(offered.includes("tool_search"), false, "no loader without a client");
    assert.equal(offered.includes("web_search"), false);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
