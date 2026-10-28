import assert from "node:assert/strict";
import test from "node:test";
import { createTavilySearch } from "../../src/tools/search/tavily.ts";

test("Tavily maps the unchanged search contract to its native API", async () => {
  const requests: { url: string; body: unknown; auth: string | null }[] = [];
  const client = createTavilySearch({
    apiKey: "tvly-fixture",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        results: [
          {
            title: "Page",
            url: "https://example.com/page",
            content: "Excerpt",
            raw_content: "Markdown",
            score: 0.8,
          },
          null,
          { title: "Missing URL" },
        ],
      });
    },
  });
  const results = await client.search({ query: "query", count: 50, needContent: true });
  assert.deepEqual(requests[0], {
    url: "https://api.tavily.com/search",
    auth: "Bearer tvly-fixture",
    body: {
      query: "query",
      max_results: 20,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: "markdown",
      auto_parameters: false,
    },
  });
  assert.deepEqual(results, [
    {
      title: "Page",
      url: "https://example.com/page",
      snippet: "Excerpt",
      summary: "",
      content: "Markdown",
      score: 0.8,
    },
  ]);
  await client.search({ query: "short" });
  const second = requests[1];
  assert.ok(second);
  assert.equal((second.body as { max_results: number }).max_results, 10);
  assert.equal((second.body as { include_raw_content: boolean }).include_raw_content, false);
});

test("Tavily extracts exactly one URL and reports per-page failure even on HTTP 200", async () => {
  const url = "https://example.com/page";
  const client = createTavilySearch({
    apiKey: "fixture",
    fetch: async (target, init) => {
      assert.equal(String(target), "https://api.tavily.com/extract");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        urls: [url],
        extract_depth: "basic",
        format: "markdown",
      });
      return Response.json({ results: [{ url, raw_content: "# Page\nBody" }], failed_results: [] });
    },
  });
  assert.deepEqual(await client.fetchPage({ url }), { url, title: "", content: "# Page\nBody" });
  const failed = createTavilySearch({
    apiKey: "fixture",
    fetch: async () =>
      Response.json({ results: [], failed_results: [{ url, error: "private upstream detail" }] }),
  });
  await assert.rejects(failed.fetchPage({ url }), /could not extract/);
});

test("Tavily errors never become empty results or expose upstream secrets", async () => {
  for (const payload of [null, {}, { results: null }]) {
    const client = createTavilySearch({
      apiKey: "secret",
      fetch: async () => Response.json(payload),
    });
    await assert.rejects(client.search({ query: "x" }), /invalid response/);
  }
  for (const status of [401, 429, 500]) {
    const client = createTavilySearch({
      apiKey: "secret",
      fetch: async () => new Response("secret upstream body", { status }),
    });
    await assert.rejects(client.search({ query: "x" }), (error: Error) => {
      assert.doesNotMatch(error.message, /secret/);
      assert.match(
        error.message,
        status === 401 ? /refused the API key/ : new RegExp(String(status)),
      );
      return true;
    });
  }
});

test("Tavily forwards caller cancellation and its own deadline", async () => {
  const client = createTavilySearch({
    apiKey: "fixture",
    timeoutMs: 5,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  await assert.rejects(client.search({ query: "x" }), /abort|timeout/i);
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(
    client.fetchPage({ url: "https://example.com" }, controller.signal),
    /caller cancelled/,
  );
});

test("malformed JSON does not echo provider response contents", async () => {
  const client = createTavilySearch({
    apiKey: "fixture",
    fetch: async () => new Response("not json: sensitive-provider-response"),
  });
  await assert.rejects(client.search({ query: "x" }), (error: Error) => {
    assert.match(error.message, /invalid response/);
    assert.doesNotMatch(error.message, /sensitive-provider-response/);
    return true;
  });
});

test("provider body read failures remain failures rather than empty results", async () => {
  const client = createTavilySearch({
    apiKey: "fixture",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("response interrupted"));
          },
        }),
      ),
  });
  await assert.rejects(client.search({ query: "x" }), /response interrupted/);
});
