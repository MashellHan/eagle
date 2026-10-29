// The daemon entry point (docs/bots/ARCHITECTURE.md "Process model"): one root, one lock,
// one token, one log, one registry and one server. Everything here is composition; the
// behaviour lives in the modules it wires.
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonConfig } from "./config.ts";
import { BotDirectory, nodeDirectoryFs } from "./core/BotDirectory.ts";
import { BotRegistry } from "./core/BotRegistry.ts";
import { ConversationService } from "./core/ConversationService.ts";
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  isToolGroup,
  resolveToolGroups,
} from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import type { RuntimeEvent } from "./core/RuntimePort.ts";
import { declareEvent } from "./log/events.ts";
import { Log } from "./log/log.ts";
import { FileLogSink } from "./log/sink.ts";
import { encodeServerEvent } from "./protocol/encode.ts";
import { createDaemonModels } from "./runtime/pi/models.ts";
import { PiDurableRuntime, type PiSettings } from "./runtime/pi/PiDurableRuntime.ts";
import { loadToken } from "./server/auth.ts";
import {
  type GatewayApi,
  type GatewayConfig,
  gatewayFromEnv,
  listGatewayModels,
  normalizeBaseUrl,
  publicGateway,
  readGateway,
  testGateway,
  writeGateway,
} from "./server/gateway.ts";
import { type Daemon, startServer } from "./server/http.ts";
import {
  PROVIDERS,
  type ProviderApi,
  type ProviderDefinition,
  type PublicProvider,
  providerDefinition,
  providersPath,
  publicProviders,
  readProviders,
  selectedProvider,
  writeProviders,
} from "./server/providers.ts";
import { acquireLock, LockError } from "./server/singleton.ts";
import { toServerEvent } from "./server/socket.ts";
import { UsageStore } from "./server/usage.ts";
import type { SearchClient } from "./tools/search/client.ts";
import { createDeepSeekSearch } from "./tools/search/deepseek.ts";
import { createTavilySearch } from "./tools/search/tavily.ts";

export type DaemonHandle = {
  readonly config: DaemonConfig;
  readonly port: number;
  readonly token: string;
  readonly daemon: Daemon;
  readonly registry: BotRegistry;
  close(): Promise<void>;
};

const packageVersion = (): string => {
  try {
    const body = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

/** Encoded bytes of one event, measured on the frame the wire layer would write. */
const StartupEvents = {
  singletonStart: declareEvent("core.singleton.start"),
  singletonOk: declareEvent("core.singleton.ok"),
  singletonFail: declareEvent("core.singleton.fail"),
} as const;

export const measureEvent = (event: RuntimeEvent): number =>
  Buffer.byteLength(JSON.stringify(encodeServerEvent(toServerEvent({ ...event, rev: 0 }))));

/** A positive integer from the environment, else the default. */
const positiveNumber = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/**
 * The compaction policy the daemon runs with: on by default, with thresholds expressed in
 * tokens of the declared window, so a small window compacts early and a large one late.
 */
export const compactionFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  windowTokens: number,
): PiSettings["compaction"] => {
  if (env.BOTS_COMPACTION === "off") return { enabled: false };
  return {
    enabled: true,
    reserveTokens: Math.min(
      positiveNumber(env.BOTS_COMPACTION_RESERVE_TOKENS, 16_384),
      windowTokens / 2,
    ),
    keepRecentTokens: positiveNumber(env.BOTS_COMPACTION_KEEP_RECENT_TOKENS, 8_192),
    backgroundTokens: Math.min(
      positiveNumber(env.BOTS_COMPACTION_BACKGROUND_TOKENS, 32_768),
      windowTokens / 4,
    ),
  };
};

export const startDaemon = async (config: DaemonConfig): Promise<DaemonHandle> => {
  // The lock port is derived from the canonical root, so the root has to exist before the
  // hash is computed: a path that resolves differently on the next start would give the
  // same directory a second lock port (ARCHITECTURE.md, "Singleton lock").
  await mkdir(config.root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const root = await realpath(config.root).catch((error: unknown) => {
    process.stderr.write(`bots: cannot resolve the root ${config.root}: ${String(error)}\n`);
    process.exit(1);
  });
  const canonical: DaemonConfig = { ...config, root };
  const token = await loadToken(root);
  const providers = await createProviderService();
  let gateway: GatewayConfig | undefined;
  // The log exists before the lock so a refused second start is on record, and it holds
  // the token as a secret for redaction from its first record.
  const sink = new FileLogSink({ root, minimum: canonical.logLevel });
  const log = new Log(sink.sink, undefined, {
    secrets: () => [token, gateway?.apiKey ?? "", ...providers.secrets()],
  });
  const startup = "tr_boot_1";
  log.emit("info", "core", StartupEvents.singletonStart, { trace: startup });
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock({ root });
  } catch (error) {
    if (error instanceof LockError) {
      log.emit("error", "core", StartupEvents.singletonFail, {
        trace: startup,
        failure: newFailure("internal", "core"),
        origin: true,
        detail: { reason: "startup" },
      });
      await sink.close();
      process.stderr.write(`bots: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  log.emit("info", "core", StartupEvents.singletonOk, { trace: startup });
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  // The stored gateway wins over the dotenv; without either, the registry is empty and a
  // run settles `no_model` until a person configures it in the app.
  gateway = (await readGateway(root)) ?? gatewayFromEnv(process.env);
  const windowTokens = positiveNumber(process.env.BOTS_CONTEXT_WINDOW, 200_000);
  let models = createDaemonModels(
    gateway === undefined
      ? undefined
      : {
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          provider: gateway.provider,
          modelId: gateway.model,
          contextWindow: windowTokens,
          ...(process.env.BOTS_MAX_TOKENS === undefined
            ? {}
            : { maxTokens: positiveNumber(process.env.BOTS_MAX_TOKENS, 8_192) }),
        },
  );
  const compaction = compactionFromEnv(process.env, windowTokens);
  const usageStore = new UsageStore(join(root, "usage.sqlite"));
  const runtime = new PiDurableRuntime({
    ...(canonical.deviceSocket === undefined ? {} : { deviceSocket: canonical.deviceSocket }),
    models: () => models,
    log,
    compaction,
    usage: usageStore,
    search: () => providers.client,
  });
  const defaultModel =
    gateway === undefined
      ? canonical.model
      : { provider: gateway.provider, modelId: gateway.model };
  const registry = new BotRegistry({
    directory,
    openRuntime: (spec) => runtime.open(spec),
    model: defaultModel,
    ...(gateway === undefined
      ? {}
      : { thinkingLevel: gateway.thinkingLevel, toolGroups: gateway.toolGroups }),
    log,
    idleCloseMs: canonical.idleCloseMs,
    quarantineRetryMs: canonical.quarantineRetryMs,
    closeDeadlineMs: canonical.closeDeadlineMs,
  });
  await registry.start();
  // The daemon exists after the service that has to broadcast through it.
  let broadcast: (() => void) | undefined;
  const service = new ConversationService({
    open: (botId, trace) => registry.open(botId, trace),
    handleOf: (botId) => registry.handleOf(botId),
    settlingOf: (botId) => registry.settling(botId),
    measure: measureEvent,
    log,
    onRunning: (botId, running) => {
      if (registry.markRunning(botId, running)) broadcast?.();
    },
    onSessionFailed: (botId, reason, message, dropHandle) => {
      if (registry.markUnavailable(botId, reason, message, { dropHandle })) broadcast?.();
    },
    onUsage: (botId, usage) => {
      try {
        usageStore.recordModelUsage(botId, usage);
      } catch {
        // Statistics are a side channel: a full disk must not fail the conversation.
      }
    },
    onRecovered: (botId, running) => {
      // Always push: the client that showed `unavailable` has to see the recovery even
      // when the registry's own state already moved on.
      registry.markRecovered(botId, running);
      broadcast?.();
    },
  });
  const capabilities = {
    agent: true,
    tools: true,
    tasks: true,
    entries: false,
    usage: true,
    peers: false,
  };
  let modelCache: { at: number; ids: readonly string[] } | undefined;
  const settings: GatewayApi = {
    public: () => publicGateway(gateway),
    save: async (input) => {
      const baseUrl =
        input.baseUrl === undefined
          ? (gateway?.baseUrl ?? "")
          : (normalizeBaseUrl(input.baseUrl) ?? "");
      const model = (input.model ?? gateway?.model ?? "").trim();
      const apiKey =
        input.apiKey !== undefined && input.apiKey.trim().length > 0
          ? input.apiKey.trim()
          : (gateway?.apiKey ?? "");
      const provider = (input.provider ?? gateway?.provider ?? "magpie").trim() || "magpie";
      const thinkingLevel =
        input.thinkingLevel === undefined
          ? (gateway?.thinkingLevel ?? DEFAULT_THINKING_LEVEL)
          : input.thinkingLevel.trim();
      if (!isThinkingLevel(thinkingLevel)) {
        return {
          settings: publicGateway(gateway),
          error: "思考等级必须是 off、minimal、low、medium、high、xhigh 或 max",
        };
      }
      if (baseUrl.length === 0) {
        return { settings: publicGateway(gateway), error: "网关地址必须是 http(s) URL" };
      }
      if (model.length === 0) {
        return { settings: publicGateway(gateway), error: "模型不能为空" };
      }
      if (apiKey.length === 0) {
        return { settings: publicGateway(gateway), error: "API Key 不能为空" };
      }
      const requestedGroups = input.toolGroups;
      if (requestedGroups !== undefined) {
        const unknown = requestedGroups.filter((name) => !isToolGroup(name));
        if (unknown.length > 0) {
          return {
            settings: publicGateway(gateway),
            error: `未知的工具组：${unknown.join("、")}`,
          };
        }
      }
      const toolGroups = resolveToolGroups(requestedGroups ?? gateway?.toolGroups);
      const next: GatewayConfig = { provider, baseUrl, model, apiKey, thinkingLevel, toolGroups };
      await writeGateway(root, next);
      gateway = next;
      models = createDaemonModels({
        baseUrl,
        apiKey,
        provider,
        modelId: model,
      });
      await registry.applyModel({ provider, modelId: model }, "tr_http_settings");
      await registry.applyThinkingLevel(thinkingLevel, "tr_http_settings");
      await registry.applyToolGroups(toolGroups, "tr_http_settings");
      return { settings: publicGateway(next) };
    },
    test: async (input) => {
      const baseUrl =
        input.baseUrl === undefined
          ? (gateway?.baseUrl ?? "")
          : (normalizeBaseUrl(input.baseUrl) ?? "");
      const apiKey =
        input.apiKey !== undefined && input.apiKey.trim().length > 0
          ? input.apiKey.trim()
          : (gateway?.apiKey ?? "");
      if (baseUrl.length === 0 || apiKey.length === 0) {
        return { ok: false, message: "请填写有效的网关地址和 API Key", latencyMs: 0 };
      }
      return testGateway({
        provider: input.provider ?? gateway?.provider ?? "magpie",
        baseUrl,
        model: (input.model ?? gateway?.model ?? "").trim(),
        apiKey,
      });
    },
  };
  const daemon = await startServer({
    token,
    log,
    registry,
    service,
    settings,
    version: packageVersion(),
    instance: `i_${process.pid}`,
    capabilities,
    port: canonical.port,
    gatewayProvider: () => gateway?.provider ?? "magpie",
    providers,
    usage: async (days: number) => {
      const report = usageStore.report(days);
      const titles = new Map(registry.summaries().map((bot) => [bot.id, bot.title]));
      return {
        ...report,
        bots: report.bots.map((bot) => ({ ...bot, title: titles.get(bot.botId) ?? bot.botId })),
      };
    },
    models: async () => {
      if (gateway === undefined) return [];
      const now = Date.now();
      if (modelCache !== undefined && now - modelCache.at < 60_000) return modelCache.ids;
      const ids = await listGatewayModels(gateway);
      modelCache = { at: now, ids };
      return ids;
    },
  });
  broadcast = daemon.broadcastCatalog;
  const close = async (): Promise<void> => {
    // One absolute deadline for the whole shutdown: a stalled socket grace, handle close
    // or log flush must not add up past the configured budget.
    const budget = canonical.closeDeadlineMs + 1_000;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget);
      timer.unref?.();
    });
    const stopped = (async () => {
      await daemon.close();
      await registry.shutdown();
      await sink.close();
      await lock.close();
    })();
    try {
      await Promise.race([stopped, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return { config: canonical, port: daemon.port, token, daemon, registry, close };
};

export const createProviderService = async (
  options: { readonly path?: string; readonly fetch?: typeof fetch } = {},
): Promise<ProviderApi & { readonly client: SearchClient; secrets(): readonly string[] }> => {
  const path = options.path ?? providersPath();
  let configs = await readProviders(path);
  let queue = Promise.resolve();
  const clientFor = (definition: ProviderDefinition): SearchClient => {
    const http = {
      apiKey: configs[definition.id]?.apiKey ?? "",
      baseUrl: definition.baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
    return definition.kind === "deepseek-search"
      ? createDeepSeekSearch(http)
      : createTavilySearch(http);
  };
  const selectedClient = (): SearchClient => {
    const definition = selectedProvider(configs);
    if (definition === undefined) throw new Error("请先在服务中选择一个已保存 Key 的搜索服务商。");
    return clientFor(definition);
  };
  const save: ProviderApi["save"] = async (id, input) => {
    const definition = providerDefinition(id);
    if (definition === undefined) return { error: `未知的服务：${id}` };
    const current = configs[id] ?? { apiKey: "", enabled: false };
    const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey.trim();
    if ((input.apiKey !== undefined || input.enabled === true) && apiKey.length === 0) {
      return { error: "请先保存 API Key" };
    }
    const next = { ...configs, [id]: { apiKey, enabled: input.enabled ?? current.enabled } };
    if (input.enabled === true) {
      for (const provider of PROVIDERS) {
        const config = next[provider.id];
        if (config !== undefined && provider.id !== id)
          next[provider.id] = { ...config, enabled: false };
      }
    }
    await writeProviders(next, path);
    configs = next;
    return {
      provider: publicProviders(configs).find((provider) => provider.id === id) as PublicProvider,
    };
  };
  return {
    public: () => publicProviders(configs),
    secrets: () => Object.values(configs).map((config) => config.apiKey),
    save(id, input) {
      const result = queue.then(() => save(id, input));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async test(id) {
      const definition = providerDefinition(id);
      if (definition === undefined || !configs[id]?.apiKey.trim()) {
        return { ok: false, message: "还没有保存这个服务的 API Key", latencyMs: 0 };
      }
      const started = performance.now();
      try {
        const results = await clientFor(definition).search({ query: "web search", count: 1 });
        return {
          ok: true,
          message: `连接成功，返回 ${results.length} 条结果`,
          latencyMs: Math.round(performance.now() - started),
          results: results.length,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "搜索服务不可用",
          latencyMs: Math.round(performance.now() - started),
        };
      }
    },
    client: {
      search: async (input, signal) => selectedClient().search(input, signal),
      fetchPage: async (input, signal) => selectedClient().fetchPage(input, signal),
    },
  };
};
