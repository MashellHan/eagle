// DeepSeek search and fetch (https://api-docs.deepseek.com/guides/search/): raw JSON over
// bearer auth. Search finds pages, fetch reads one; neither launches a browser.
import type { ToolOutcome } from "../types.ts";

export type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly summary: string;
  readonly content?: string;
  readonly siteName?: string;
  readonly publishedAt?: string;
  readonly score?: number;
};

export type FetchedPage = {
  readonly url: string;
  readonly title: string;
  readonly content: string;
};

export type SearchClient = {
  /** Up to `count` results for one query, best first. */
  search(input: {
    readonly query: string;
    readonly count?: number;
    readonly needContent?: boolean;
    readonly originalQuestion?: string;
  }): Promise<readonly SearchResult[]>;
  /** One page as Markdown. */
  fetchPage(input: { readonly url: string }): Promise<FetchedPage>;
};

export type DeepSeekOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected for tests; the real client uses the platform fetch. */
  readonly fetch?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 30_000;

const request = async (options: DeepSeekOptions, path: string, body: unknown): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(
      `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "the search provider refused the API key"
          : `the search provider answered ${response.status}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const createDeepSeekSearch = (options: DeepSeekOptions): SearchClient => ({
  async search(input) {
    const body: Record<string, unknown> = { query: input.query };
    if (input.count !== undefined) body.count = input.count;
    body.need_content = input.needContent === true;
    if (input.originalQuestion !== undefined) body.ori_question = input.originalQuestion;
    const payload = (await request(options, "/v1/tools/search", body)) as {
      results?: unknown;
    };
    if (!Array.isArray(payload.results)) return [];
    return payload.results.flatMap((item) => {
      const result = item as Record<string, unknown>;
      const url = text(result.url);
      if (url.length === 0) return [];
      return [
        {
          title: text(result.title),
          url,
          snippet: text(result.snippet),
          summary: text(result.summary),
          ...(optionalText(result.content) === undefined
            ? {}
            : { content: optionalText(result.content) as string }),
          ...(optionalText(result.site_name) === undefined
            ? {}
            : { siteName: optionalText(result.site_name) as string }),
          ...(optionalText(result.date) === undefined
            ? {}
            : { publishedAt: optionalText(result.date) as string }),
          ...(typeof result.rerank_score === "number" ? { score: result.rerank_score } : {}),
        },
      ];
    });
  },

  async fetchPage(input) {
    const payload = (await request(options, "/v1/tools/fetch", { url: input.url })) as {
      title?: unknown;
      content?: unknown;
      url?: unknown;
    };
    return {
      url: optionalText(payload.url) ?? input.url,
      title: text(payload.title),
      content: text(payload.content),
    };
  },
});

export const searchFailure = (error: unknown): ToolOutcome => ({
  output: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
