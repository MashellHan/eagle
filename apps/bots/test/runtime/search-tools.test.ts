// Web search as a bot tool (docs/bots/EXTENSIONS-AND-TOOLS.md, "search"): the daemon supplies
// the client from the saved provider key, the group stays off unless selected, and each
// performed call is booked in the usage statistics.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { createProviderService } from "../../src/main.ts";
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

test("a runtime without a host search client offers neither the tools nor the loader", async () => {
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

test("a warm bot keeps identical search schemas across provider changes and missing configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-warm-search-"));
  const requests: string[] = [];
  const bookings: UsageEntry[] = [];
  const providers = await createProviderService({
    path: join(root, "providers.json"),
    fetch: async (target) => {
      const url = new URL(String(target));
      requests.push(`${url.host}${url.pathname}`);
      if (url.pathname.endsWith("search"))
        return Response.json({
          results: [
            {
              title: "Same page",
              url: "https://example.com/page",
              summary: "Same excerpt",
              snippet: "Same excerpt",
              content: "Same excerpt",
            },
          ],
        });
      return url.hostname === "api.tavily.com"
        ? Response.json({
            results: [{ url: "https://example.com/page", raw_content: "Same body" }],
          })
        : Response.json({ url: "https://example.com/page", content: "Same body" });
    },
  });
  const bench = await createBench({
    search: () => providers.client,
    usage: { record: (entry) => bookings.push(entry) },
  });
  try {
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["search"] });
    const events: RuntimeEvent[] = [];
    const schemas: unknown[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    for (const provider of [undefined, "deepseek-search", "tavily-search"]) {
      if (provider !== undefined)
        await providers.save(provider, { apiKey: "fixture", enabled: true });
      bench.faux.setResponses([
        ...(provider === undefined
          ? [assistant([toolCall("tool_search", { query: "web" })], { stopReason: "toolUse" })]
          : []),
        (context) => {
          schemas.push(
            getCurrentTools(context.messages).filter((tool) => tool.name.startsWith("web_")),
          );
          return assistant([toolCall("web_search", { query: "same query", count: 3 })], {
            stopReason: "toolUse",
          });
        },
        assistant([toolCall("web_fetch", { url: "https://example.com/page" })], {
          stopReason: "toolUse",
        }),
        assistant("done"),
      ]);
      const requestId = `r_provider_${provider ?? "none"}`;
      await handle.submit({ requestId, text: "search", whenBusy: "followUp", trace });
      await waitFor(
        async () => (await handle.submission({ requestId }))?.status === "done",
        "provider turn settles",
      );
      if (provider === undefined) {
        assert.deepEqual(requests, []);
        assert.equal(
          toolResults(events)
            .filter((block) => block.name.startsWith("web_"))
            .every((block) => block.isError),
          true,
        );
      }
    }
    assert.deepEqual(schemas[0], schemas[1]);
    assert.deepEqual(schemas[1], schemas[2]);
    assert.doesNotMatch(JSON.stringify(schemas), /deepseek|tavily|providerId/i);
    assert.deepEqual(requests, [
      "api.deepseek.com/v1/tools/search",
      "api.deepseek.com/v1/tools/fetch",
      "api.tavily.com/search",
      "api.tavily.com/extract",
    ]);
    assert.equal(bookings.length, 4);
    const successful = toolResults(events).filter(
      (block) => block.name.startsWith("web_") && !block.isError,
    );
    assert.equal(successful.length, 4);
    assert.equal(successful[1]?.text, successful[3]?.text);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
