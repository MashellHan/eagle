import {
  isRecord,
  requestSearch,
  type SearchClient,
  type SearchClientOptions,
  text,
} from "./client.ts";

export const createTavilySearch = (options: SearchClientOptions): SearchClient => {
  const http = { ...options, baseUrl: options.baseUrl ?? "https://api.tavily.com" };
  return {
    async search(input, signal) {
      const payload = await requestSearch(
        http,
        "/search",
        {
          query: input.query,
          max_results: Math.min(input.count ?? 10, 20),
          search_depth: "basic",
          include_answer: false,
          include_raw_content: input.needContent === true ? "markdown" : false,
          auto_parameters: false,
        },
        signal,
      );
      if (!Array.isArray(payload.results))
        throw new Error("the search provider returned an invalid response");
      return payload.results.flatMap((item: unknown) => {
        if (!isRecord(item) || text(item.url).length === 0) return [];
        return [
          {
            title: text(item.title),
            url: text(item.url),
            snippet: text(item.content),
            summary: "",
            ...(text(item.raw_content) === "" ? {} : { content: text(item.raw_content) }),
            ...(typeof item.score === "number" ? { score: item.score } : {}),
          },
        ];
      });
    },
    async fetchPage(input, signal) {
      const payload = await requestSearch(
        http,
        "/extract",
        {
          urls: [input.url],
          extract_depth: "basic",
          format: "markdown",
        },
        signal,
      );
      const page: unknown = Array.isArray(payload.results) ? payload.results[0] : undefined;
      if (!isRecord(page) || typeof page.raw_content !== "string") {
        throw new Error("the search provider could not extract this page");
      }
      return {
        url: text(page.url) || input.url,
        title: text(page.title),
        content: page.raw_content,
      };
    },
  };
};
