// The daemon entry point (docs/bots/ARCHITECTURE.md "Process model"): one root, one lock,
// one token, one log, one registry and one server. Everything here is composition; the
// behaviour lives in the modules it wires.
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import type { DaemonConfig } from "./config.ts";
import { BotDirectory, nodeDirectoryFs } from "./core/BotDirectory.ts";
import { BotRegistry } from "./core/BotRegistry.ts";
import { ConversationService } from "./core/ConversationService.ts";
import { newFailure } from "./core/failures.ts";
import type { RuntimeEvent } from "./core/RuntimePort.ts";
import { declareEvent } from "./log/events.ts";
import { Log } from "./log/log.ts";
import { FileLogSink } from "./log/sink.ts";
import { encodeServerEvent } from "./protocol/encode.ts";
import { createDaemonModels } from "./runtime/pi/models.ts";
import { PiDurableRuntime } from "./runtime/pi/PiDurableRuntime.ts";
import { loadToken } from "./server/auth.ts";
import {
  type GatewayApi,
  type GatewayConfig,
  gatewayFromEnv,
  normalizeBaseUrl,
  publicGateway,
  readGateway,
  testGateway,
  writeGateway,
} from "./server/gateway.ts";
import { type Daemon, startServer } from "./server/http.ts";
import { acquireLock, LockError } from "./server/singleton.ts";
import { toServerEvent } from "./server/socket.ts";

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
  // The log exists before the lock so a refused second start is on record, and it holds
  // the token as a secret for redaction from its first record.
  const sink = new FileLogSink({ root, minimum: canonical.logLevel });
  const log = new Log(sink.sink, undefined, {
    secrets: () => [token, process.env.BOTS_API_KEY ?? ""],
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
  let gateway: GatewayConfig | undefined = (await readGateway(root)) ?? gatewayFromEnv(process.env);
  let models = createDaemonModels(
    gateway === undefined
      ? undefined
      : {
          baseUrl: gateway.baseUrl,
          apiKeyEnv: "BOTS_API_KEY",
          provider: gateway.provider,
          modelId: gateway.model,
        },
  );
  const runtime = new PiDurableRuntime({ models: () => models, log });
  const defaultModel =
    gateway === undefined
      ? canonical.model
      : { provider: gateway.provider, modelId: gateway.model };
  const registry = new BotRegistry({
    directory,
    openRuntime: (spec) => runtime.open(spec),
    model: defaultModel,
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
    onRecovered: (botId, running) => {
      // Always push: the client that showed `unavailable` has to see the recovery even
      // when the registry's own state already moved on.
      registry.markRecovered(botId, running);
      broadcast?.();
    },
  });
  const capabilities = {
    agent: false,
    tools: true,
    tasks: false,
    entries: false,
    usage: false,
    peers: false,
  };
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
      if (baseUrl.length === 0) {
        return { settings: publicGateway(gateway), error: "网关地址必须是 http(s) URL" };
      }
      if (model.length === 0) {
        return { settings: publicGateway(gateway), error: "模型不能为空" };
      }
      if (apiKey.length === 0) {
        return { settings: publicGateway(gateway), error: "API Key 不能为空" };
      }
      const next: GatewayConfig = { provider, baseUrl, model, apiKey };
      await writeGateway(root, next);
      gateway = next;
      // The provider reads the key through the environment on each request, so an
      // existing bot picks it up without being reopened.
      process.env.BOTS_API_KEY = apiKey;
      models = createDaemonModels({
        baseUrl,
        apiKeyEnv: "BOTS_API_KEY",
        provider,
        modelId: model,
      });
      await registry.applyModel({ provider, modelId: model }, "tr_http_settings");
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
