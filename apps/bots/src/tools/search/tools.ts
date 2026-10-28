// Web search and fetch as bot tools (docs/bots/EXTENSIONS-AND-TOOLS.md, "search"): the tools
// are deferred, so a bot that never searches never carries them, and each call is booked in
// the usage statistics through the meter the daemon passes in.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { UsageMeter } from "../usage.ts";
import type { SearchClient } from "./client.ts";

export const SEARCH_TOOLS_EXTENSION = "bots-search";

const MAX_QUERY_CHARS = 128;
const MAX_RESULTS = 50;
const MAX_OUTPUT_BYTES = 50 * 1024;

export type SearchToolOptions = {
  readonly client: SearchClient;
  readonly botId: string;
  /** Where a performed search is counted; absent in a test build. */
  readonly meter?: UsageMeter;
  readonly now?: () => Date;
};

const clip = (text: string): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  let clipped = text;
  while (Buffer.byteLength(clipped, "utf8") > MAX_OUTPUT_BYTES) {
    clipped = clipped.slice(0, Math.floor(clipped.length * 0.9));
  }
  return { text: clipped, truncated: true };
};

const formatResults = (
  results: readonly {
    title: string;
    url: string;
    snippet: string;
    summary: string;
    content?: string;
    siteName?: string;
    publishedAt?: string;
  }[],
  retrievedAt: string,
): string => {
  if (results.length === 0) return "没有找到结果。";
  const blocks = results.map((result, index) => {
    const meta = [result.siteName, result.publishedAt].filter(Boolean).join(" · ");
    return [
      `${index + 1}. ${result.title}`,
      result.url,
      meta.length === 0 ? "" : meta,
      result.summary.length > 0 ? result.summary : result.snippet,
      result.content === undefined ? "" : `内容：\n${result.content}`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  });
  return [`检索于 ${retrievedAt}`, ...blocks].join("\n\n");
};

export const createSearchTools = (options: SearchToolOptions): readonly ToolRegistration[] => [
  defineTool({
    name: "web_search",
    description: "Search the live web and return ranked pages (title, URL, snippet, summary).",
    parameters: Type.Object({
      query: Type.String({ description: "The search query, 1-128 characters" }),
      count: Type.Optional(Type.Number({ description: "How many results, 1-50 (default 10)" })),
      needContent: Type.Optional(
        Type.Boolean({ description: "Also return page content; slower and larger" }),
      ),
    }),
    replay: "unsafe",
    deferred: true,
    outputLimits: { maxBytes: 256 * 1024, maxLines: 100_000, retain: "head" },
    execute: async (args, _api, context) => {
      const query = args.query.trim();
      if (query.length === 0 || [...query].length > MAX_QUERY_CHARS) {
        return {
          output: [{ type: "text" as const, text: "查询需要 1-128 个字符。" }],
          isError: true,
        };
      }
      const count = Math.min(Math.max(Math.round(args.count ?? 10), 1), MAX_RESULTS);
      try {
        const results = await options.client.search(
          {
            query,
            count,
            ...(args.needContent === undefined ? {} : { needContent: args.needContent }),
          },
          context.abortSignal,
        );
        options.meter?.record({ botId: options.botId, source: "search", calls: 1 });
        const retrievedAt = (options.now?.() ?? new Date()).toISOString();
        const clipped = clip(formatResults(results, retrievedAt));
        return {
          output: [{ type: "text" as const, text: clipped.text }],
          details: { count: results.length, truncated: clipped.truncated },
        };
      } catch (error) {
        return searchFailure(error);
      }
    },
  }),
  defineTool({
    name: "web_fetch",
    description: "Fetch one web page and return its title and content as Markdown.",
    parameters: Type.Object({
      url: Type.String({ description: "An http or https URL" }),
    }),
    replay: "safe",
    deferred: true,
    outputLimits: { maxBytes: 256 * 1024, maxLines: 100_000, retain: "head" },
    execute: async (args, _api, context) => {
      if (!/^https?:\/\//i.test(args.url)) {
        return {
          output: [{ type: "text" as const, text: "只支持 http(s) 链接。" }],
          isError: true,
        };
      }
      try {
        const page = await options.client.fetchPage({ url: args.url }, context.abortSignal);
        options.meter?.record({ botId: options.botId, source: "search", calls: 1 });
        const clipped = clip(
          [page.title ? `# ${page.title}` : "", page.url, page.content]
            .filter(Boolean)
            .join("\n\n"),
        );
        return {
          output: [{ type: "text" as const, text: clipped.text }],
          details: { url: page.url, truncated: clipped.truncated },
        };
      } catch (error) {
        return searchFailure(error);
      }
    },
  }),
];

const searchFailure = (error: unknown) => ({
  output: [
    {
      type: "text" as const,
      text: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

export const searchSection = (): string =>
  [
    "You can search the live web with web_search and read one page with web_fetch.",
    'Neither is loaded yet: call tool_search with a query like "web" to enable them.',
    "web_search finds URLs; web_fetch reads one page. Cite the URL when you use a result.",
  ].join("\n");

export const searchExtension = (options: SearchToolOptions) =>
  defineExtension({
    name: SEARCH_TOOLS_EXTENSION,
    tools: createSearchTools(options),
    sections: [section("bots-search", () => searchSection())],
  });
