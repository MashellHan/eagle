// Web search (docs/bots/EXTENSIONS-AND-TOOLS.md, "search"): the DeepSeek client speaks the
// documented JSON, the tools stay deferred, and each performed call is booked for usage.
import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeekSearch } from "../../src/tools/search/deepseek.ts";
import {
  createSearchTools,
  SEARCH_TOOLS_EXTENSION,
  searchSection,
} from "../../src/tools/search/tools.ts";
import type { UsageEntry } from "../../src/tools/usage.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("the client posts the documented search body and reads the results", async () => {
  const seen: { url: string; body: unknown; auth: string | null }[] = [];
  const client = createDeepSeekSearch({
    apiKey: "sk-test",
    fetch: (async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return json({
        results: [
          {
            title: "DeepSeek V4",
            url: "https://example.com/a",
            snippet: "短摘要",
            summary: "长摘要",
            content: "正文",
            site_name: "Example",
            date: "2026-06-01T00:00:00+00:00",
            rerank_score: 2.4,
          },
          { title: "no url" },
        ],
      });
    }) as unknown as typeof fetch,
  });
  const results = await client.search({ query: "DeepSeek V4", count: 5, needContent: true });
  assert.equal(seen[0]?.url, "https://api.deepseek.com/v1/tools/search");
  assert.deepEqual(seen[0]?.body, { query: "DeepSeek V4", count: 5, need_content: true });
  assert.equal(seen[0]?.auth, "Bearer sk-test");
  assert.equal(results.length, 1, "a result without a URL is dropped");
  assert.equal(results[0]?.siteName, "Example");
  assert.equal(results[0]?.score, 2.4);
});

test("a refused key and a bad status are reported, not swallowed", async () => {
  const refused = createDeepSeekSearch({
    apiKey: "bad",
    fetch: (async () => json({}, 401)) as unknown as typeof fetch,
  });
  await assert.rejects(() => refused.search({ query: "x" }), /refused the API key/);
  const broken = createDeepSeekSearch({
    apiKey: "k",
    fetch: (async () => json({}, 500)) as unknown as typeof fetch,
  });
  await assert.rejects(() => broken.search({ query: "x" }), /answered 500/);
});

test("the tools are deferred, count their calls, and refuse a bad query", async () => {
  const bookings: UsageEntry[] = [];
  const tools = createSearchTools({
    client: {
      search: async () => [{ title: "T", url: "https://e.com", snippet: "s", summary: "summary" }],
      fetchPage: async ({ url }) => ({ url, title: "T", content: "body" }),
    },
    botId: "b_1",
    meter: { record: (entry) => bookings.push(entry) },
    now: () => new Date("2026-10-28T00:00:00Z"),
  });
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.deferred === true]),
    [
      ["web_search", true],
      ["web_fetch", true],
    ],
    "both search tools load on demand",
  );
  const search = tools.find((tool) => tool.name === "web_search");
  assert.ok(search);
  const result = await search.execute({ query: "DeepSeek" } as never, {} as never, {} as never);
  const text = ((result.output?.[0] ?? {}) as { text?: string }).text ?? "";
  assert.match(text, /example|e\.com|T/);
  assert.deepEqual(bookings, [{ botId: "b_1", source: "search", calls: 1 }]);
  const empty = await search.execute({ query: "   " } as never, {} as never, {} as never);
  assert.equal(empty.isError, true, "a blank query is a refusal, not a request");
  assert.equal(bookings.length, 1, "and nothing is booked for it");
});

test("the section names the tools and how to load them", () => {
  assert.match(searchSection(), /tool_search/);
  assert.equal(SEARCH_TOOLS_EXTENSION, "bots-search");
});

test("web_fetch books its call, clips a huge page and refuses a non-http url", async () => {
  const bookings: UsageEntry[] = [];
  const tools = createSearchTools({
    client: {
      search: async () => [],
      fetchPage: async ({ url }) => ({ url, title: "T", content: "字".repeat(40_000) }),
    },
    botId: "b_1",
    meter: { record: (entry) => bookings.push(entry) },
  });
  const fetch = tools.find((tool) => tool.name === "web_fetch");
  assert.ok(fetch);
  const page = await fetch.execute({ url: "https://e.com/a" } as never, {} as never, {} as never);
  const text = ((page.output?.[0] ?? {}) as { text?: string }).text ?? "";
  assert.equal(page.isError, undefined);
  assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024, "the page is clipped to 50 KiB");
  assert.equal((page.details as { truncated?: boolean }).truncated, true);
  assert.deepEqual(bookings, [{ botId: "b_1", source: "search", calls: 1 }]);

  const refused = await fetch.execute(
    { url: "file:///etc/passwd" } as never,
    {} as never,
    {} as never,
  );
  assert.equal(refused.isError, true);
  assert.equal(bookings.length, 1, "a refused url spends nothing");
});

test("a provider failure becomes an error result the model can read", async () => {
  const bookings: UsageEntry[] = [];
  const tools = createSearchTools({
    client: {
      search: async () => {
        throw new Error("the search provider refused the API key");
      },
      fetchPage: async () => {
        throw new Error("the search provider answered 500");
      },
    },
    botId: "b_1",
    meter: { record: (entry) => bookings.push(entry) },
  });
  const search = tools.find((tool) => tool.name === "web_search");
  assert.ok(search);
  const failed = await search.execute({ query: "x" } as never, {} as never, {} as never);
  assert.equal(failed.isError, true);
  const text = ((failed.output?.[0] ?? {}) as { text?: string }).text ?? "";
  assert.match(text, /refused the API key/);
  assert.deepEqual(bookings, [], "a failed call is not booked");
});
