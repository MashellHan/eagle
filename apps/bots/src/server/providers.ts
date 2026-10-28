// Third-party providers a bot's tools may call (docs/bots/PROTOCOL.md, "Providers"): the
// catalogue is code (id, title, endpoint, docs), the secret is stored under the user's home
// config with 0600, and the public shape only says whether a key is set. Adding a second
// provider is a definition here, not a new store.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ProviderDefinition = {
  readonly id: string;
  readonly title: string;
  readonly kind: "deepseek-search";
  readonly baseUrl: string;
  readonly docsUrl: string;
  /** What the key field asks for, in the person's words. */
  readonly keyLabel: string;
};

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "deepseek-search",
    title: "DeepSeek 搜索",
    kind: "deepseek-search",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/guides/search/",
    keyLabel: "DeepSeek API Key",
  },
];

export type ProviderConfig = {
  readonly apiKey: string;
  readonly enabled: boolean;
};

export type PublicProvider = {
  readonly id: string;
  readonly title: string;
  readonly kind: ProviderDefinition["kind"];
  readonly baseUrl: string;
  readonly docsUrl: string;
  readonly keyLabel: string;
  readonly hasApiKey: boolean;
  readonly enabled: boolean;
};

export type ProviderInput = {
  readonly apiKey?: string;
  readonly enabled?: boolean;
};

/** The file lives in the user's own config, not beside this machine's daemon state. */
export const providersPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "eagle-bots", "providers.json");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A malformed file is "nothing configured", never a crash. */
export const readProviders = async (
  path: string = providersPath(),
): Promise<Readonly<Record<string, ProviderConfig>>> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObject(raw) || !isObject(raw.providers)) return {};
    const out: Record<string, ProviderConfig> = {};
    for (const [id, value] of Object.entries(raw.providers)) {
      if (!isObject(value) || typeof value.apiKey !== "string") continue;
      out[id] = { apiKey: value.apiKey, enabled: value.enabled !== false };
    }
    return out;
  } catch {
    return {};
  }
};

export const writeProviders = async (
  configs: Readonly<Record<string, ProviderConfig>>,
  path: string = providersPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, providers: configs }, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export const publicProviders = (
  configs: Readonly<Record<string, ProviderConfig>>,
): readonly PublicProvider[] =>
  PROVIDERS.map((provider) => {
    const config = configs[provider.id];
    return {
      id: provider.id,
      title: provider.title,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      docsUrl: provider.docsUrl,
      keyLabel: provider.keyLabel,
      hasApiKey: (config?.apiKey.length ?? 0) > 0,
      enabled: config?.enabled ?? false,
    };
  });

export const providerDefinition = (id: string): ProviderDefinition | undefined =>
  PROVIDERS.find((provider) => provider.id === id);

export type ProviderProbe = {
  readonly ok: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly results?: number;
};

/** What the HTTP layer may ask of the provider settings. */
export type ProviderApi = {
  public(): readonly PublicProvider[];
  save(id: string, input: ProviderInput): Promise<{ provider?: PublicProvider; error?: string }>;
  test(id: string): Promise<ProviderProbe>;
};
