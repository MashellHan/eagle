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
  const models = createDaemonModels({
    baseUrl: process.env.BOTS_BASE_URL?.trim() ?? "",
    apiKeyEnv: "BOTS_API_KEY",
    provider: canonical.model.provider,
    modelId: canonical.model.modelId,
  });
  const runtime = new PiDurableRuntime({ models, log });
  const registry = new BotRegistry({
    directory,
    openRuntime: (spec) => runtime.open(spec),
    model: canonical.model,
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
  const daemon = await startServer({
    token,
    log,
    registry,
    service,
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
