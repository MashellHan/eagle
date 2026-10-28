// The model gateway settings (docs/bots/PROTOCOL.md, "Gateway settings"): one local
// endpoint, one key and one model, stored beside the token so a person can configure the
// app instead of editing a dotenv. The key never leaves the daemon except in a request
// that already carries the bearer token; the public shape only says whether it is set.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_THINKING_LEVEL,
  DEFAULT_TOOL_GROUPS,
  isThinkingLevel,
  resolveToolGroups,
  type ThinkingLevel,
  type ToolGroup,
} from "../core/domain.ts";

export type GatewayConfig = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly thinkingLevel: ThinkingLevel;
  /** The tool groups every bot is given; `core` is always included. */
  readonly toolGroups: readonly ToolGroup[];
};

export type PublicGateway = {
  readonly configured: boolean;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasApiKey: boolean;
  readonly thinkingLevel: ThinkingLevel;
  readonly toolGroups: readonly ToolGroup[];
};

export type GatewayTest = {
  readonly ok: boolean;
  readonly status?: number;
  readonly message: string;
  readonly latencyMs: number;
  readonly models?: number;
};

export type GatewayInput = {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly thinkingLevel?: string;
  readonly toolGroups?: readonly string[];
};

const FILE = "gateway.json";
const DEFAULT_PROVIDER = "magpie";
const TEST_TIMEOUT_MS = 8_000;

export const gatewayPath = (root: string): string => join(root, FILE);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads the stored settings; a malformed file is "not configured", never a crash. */
export const readGateway = async (root: string): Promise<GatewayConfig | undefined> => {
  const text = await readFile(gatewayPath(root), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObject(raw)) return undefined;
    const baseUrl = raw.baseUrl;
    const model = raw.model;
    const apiKey = raw.apiKey;
    if (typeof baseUrl !== "string" || typeof model !== "string" || typeof apiKey !== "string") {
      return undefined;
    }
    return {
      provider:
        typeof raw.provider === "string" && raw.provider.length > 0
          ? raw.provider
          : DEFAULT_PROVIDER,
      baseUrl,
      model,
      apiKey,
      thinkingLevel: isThinkingLevel(raw.thinkingLevel)
        ? raw.thinkingLevel
        : DEFAULT_THINKING_LEVEL,
      toolGroups:
        raw.toolGroups === undefined
          ? DEFAULT_TOOL_GROUPS
          : resolveToolGroups(
              Array.isArray(raw.toolGroups)
                ? raw.toolGroups.filter((name): name is string => typeof name === "string")
                : [],
            ),
    };
  } catch {
    return undefined;
  }
};

/** Writes the settings atomically with 0600: the key is a secret like the token. */
export const writeGateway = async (root: string, config: GatewayConfig): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${gatewayPath(root)}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, gatewayPath(root));
};

/** The dotenv values a fresh checkout still uses; the file wins when both exist. */
export const gatewayFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): GatewayConfig | undefined => {
  const baseUrl = env.BOTS_BASE_URL?.trim() ?? "";
  const apiKey = env.BOTS_API_KEY?.trim() ?? "";
  const model = env.BOTS_MODEL?.trim() ?? "";
  if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) return undefined;
  const provider = env.BOTS_PROVIDER?.trim() ?? "";
  const level = env.BOTS_THINKING_LEVEL?.trim();
  return {
    provider: provider.length > 0 ? provider : DEFAULT_PROVIDER,
    baseUrl,
    model,
    apiKey,
    thinkingLevel: isThinkingLevel(level) ? level : DEFAULT_THINKING_LEVEL,
    toolGroups:
      env.BOTS_TOOL_GROUPS === undefined
        ? DEFAULT_TOOL_GROUPS
        : resolveToolGroups(env.BOTS_TOOL_GROUPS.split(",").map((name) => name.trim())),
  };
};

export const publicGateway = (config: GatewayConfig | undefined): PublicGateway => ({
  configured:
    config !== undefined &&
    config.baseUrl.length > 0 &&
    config.model.length > 0 &&
    config.apiKey.length > 0,
  provider: config?.provider ?? DEFAULT_PROVIDER,
  baseUrl: config?.baseUrl ?? "",
  model: config?.model ?? "",
  hasApiKey: (config?.apiKey.length ?? 0) > 0,
  thinkingLevel: config?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  toolGroups: config?.toolGroups ?? DEFAULT_TOOL_GROUPS,
});

/** A gateway URL is http(s) and has no trailing slash, so `/models` appends cleanly. */
export const normalizeBaseUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

/** The model ids the gateway offers, in its own order; empty when it cannot be asked. */
export const listGatewayModels = async (
  config: Pick<GatewayConfig, "baseUrl" | "apiKey">,
  options: { readonly timeoutMs?: number } = {},
): Promise<readonly string[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
    if (!Array.isArray(body?.data)) return [];
    return body.data.flatMap((item) => {
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? [id] : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Proves the app can reach the gateway and that the key is accepted. It asks for the
 * model list, which the OpenAI-compatible endpoint implements, instead of spending a
 * generation; a 401 is an auth problem, a timeout is a reachability problem.
 */
export const testGateway = async (
  config: Pick<GatewayConfig, "provider" | "baseUrl" | "model" | "apiKey">,
  options: { readonly timeoutMs?: number } = {},
): Promise<GatewayTest> => {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 401 ? "API Key 被拒绝" : `网关返回 ${response.status}`,
        latencyMs,
      };
    }
    const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
    const models = Array.isArray(body?.data) ? body.data.length : undefined;
    return {
      ok: true,
      status: response.status,
      message: models === undefined ? "连接成功" : `连接成功，网关报告 ${models} 个模型`,
      latencyMs,
      ...(models === undefined ? {} : { models }),
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      message: aborted ? "连接超时" : "无法连接网关",
      latencyMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
};

export type GatewayApi = {
  readonly public: () => PublicGateway;
  readonly save: (
    input: GatewayInput,
  ) => Promise<{ readonly settings: PublicGateway; readonly error?: string }>;
  readonly test: (input: GatewayInput) => Promise<GatewayTest>;
};
