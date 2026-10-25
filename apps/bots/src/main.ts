// The daemon entry point (docs/bots/ARCHITECTURE.md "Process model"): one root, one lock,
// one token, one log, one registry and one server. Everything here is composition; the
// behaviour lives in the modules it wires.
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonConfig, readConfig } from "./config.ts";
import { BotDirectory, nodeDirectoryFs } from "./core/BotDirectory.ts";
import { BotRegistry } from "./core/BotRegistry.ts";
import { ConversationService } from "./core/ConversationService.ts";
import type { RuntimeEvent } from "./core/RuntimePort.ts";
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
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock({ root });
  } catch (error) {
    if (error instanceof LockError) {
      process.stderr.write(`bots: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const token = await loadToken(root);
  const sink = new FileLogSink({ root, minimum: canonical.logLevel });
  const log = new Log(sink.sink, undefined, {
    secrets: () => [token, process.env.BOTS_API_KEY ?? ""],
  });
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
  const service = new ConversationService({
    open: (botId, trace) => registry.open(botId, trace),
    handleOf: (botId) => registry.handleOf(botId),
    measure: measureEvent,
  });
  const capabilities = {
    agent: false,
    tools: false,
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
  const close = async (): Promise<void> => {
    await daemon.close();
    await registry.shutdown();
    await sink.close();
    await lock.close();
  };
  return { config: canonical, port: daemon.port, token, daemon, registry, close };
};

const isEntry = process.argv[1]?.endsWith("main.ts") === true;
if (isEntry) {
  const config = readConfig();
  const handle = await startDaemon(config);
  process.stdout.write(
    `${JSON.stringify({
      event: "daemon.start",
      root: handle.config.root,
      port: handle.port,
      tokenFile: join(handle.config.root, "token"),
    })}\n`,
  );
  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
