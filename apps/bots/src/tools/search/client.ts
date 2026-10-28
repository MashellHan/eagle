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
  search(
    input: {
      readonly query: string;
      readonly count?: number;
      readonly needContent?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<readonly SearchResult[]>;
  fetchPage(input: { readonly url: string }, signal?: AbortSignal): Promise<FetchedPage>;
};

export type SearchClientOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
};

export const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const requestSearch = async (
  options: SearchClientOptions & { readonly baseUrl: string },
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await (options.fetch ?? fetch)(
      `${options.baseUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal:
          signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "the search provider refused the API key"
          : `the search provider answered ${response.status}`,
      );
    }
    const payload: unknown = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) {
        throw new Error("the search provider returned an invalid response");
      }
      throw error;
    });
    if (!isRecord(payload)) throw new Error("the search provider returned an invalid response");
    return payload;
  } finally {
    clearTimeout(timer);
  }
};
