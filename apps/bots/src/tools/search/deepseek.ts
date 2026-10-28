import {
  isRecord,
  requestSearch,
  type SearchClient,
  type SearchClientOptions,
  text,
} from "./client.ts";

export const createDeepSeekSearch = (options: SearchClientOptions): SearchClient => {
  const http = { ...options, baseUrl: options.baseUrl ?? "https://api.deepseek.com" };
  return {
    async search(input, signal) {
      const body: Record<string, unknown> = {
        query: input.query,
        need_content: input.needContent === true,
      };
      if (input.count !== undefined) body.count = input.count;
      const payload = await requestSearch(http, "/v1/tools/search", body, signal);
      if (!Array.isArray(payload.results))
        throw new Error("the search provider returned an invalid response");
      return payload.results.flatMap((item: unknown) => {
        if (!isRecord(item) || text(item.url).length === 0) return [];
        return [
          {
            title: text(item.title),
            url: text(item.url),
            snippet: text(item.snippet),
            summary: text(item.summary),
            ...(text(item.content) === "" ? {} : { content: text(item.content) }),
            ...(text(item.site_name) === "" ? {} : { siteName: text(item.site_name) }),
            ...(text(item.date) === "" ? {} : { publishedAt: text(item.date) }),
            ...(typeof item.rerank_score === "number" ? { score: item.rerank_score } : {}),
          },
        ];
      });
    },
    async fetchPage(input, signal) {
      const payload = await requestSearch(http, "/v1/tools/fetch", { url: input.url }, signal);
      if (typeof payload.content !== "string")
        throw new Error("the search provider returned an invalid response");
      return {
        url: text(payload.url) || input.url,
        title: text(payload.title),
        content: payload.content,
      };
    },
  };
};
