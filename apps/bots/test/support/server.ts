// A real loopback daemon over a fake runtime: the transport, close codes and auth are
// properties of a socket, so they are tested on one (docs/bots/TESTING.md).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../src/core/BotRegistry.ts";
import { ConversationService } from "../../src/core/ConversationService.ts";
import { captureLog, type LogRecord } from "../../src/log/log.ts";
import { measureEvent } from "../../src/main.ts";
import { startServer } from "../../src/server/http.ts";
import { FakeRuntime, type FakeScript } from "../../src/testing/FakeRuntime.ts";

/** A decoded frame: tests read one field at a time, so the shape stays open here. */
export type Frame = Record<string, unknown>;

export type StubBot = { id: string; state: string };

export type Stack = {
  readonly port: number;
  readonly token: string;
  readonly root: string;
  readonly records: LogRecord[];
  readonly runtime: FakeRuntime;
  readonly directory: BotDirectory;
  readonly registry: BotRegistry;
  readonly service: ConversationService;
  readonly daemon: Awaited<ReturnType<typeof startServer>>;
  readonly opens: () => number;
  createBot(title: string): Promise<string>;
  /** Puts a bot id in the quarantined state the transport refuses with 4090. */
  quarantine(botId: string): void;
  connect(options?: { token?: string; headers?: Record<string, string> }): WebSocket;
  close(): Promise<void>;
};

const token = "test-token-0123456789-abcdefghijklmnop";

export const startStack = async (
  options: {
    idleCloseMs?: number;
    script?: FakeScript;
    model?: { provider: string; modelId: string };
  } = {},
): Promise<Stack> => {
  const root = await mkdtemp(join(tmpdir(), "bots-server-"));
  const { log, records } = captureLog();
  const runtime = new FakeRuntime(options.script === undefined ? {} : { script: options.script });
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  let opens = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      opens += 1;
      return runtime.open(spec);
    },
    model: options.model ?? { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: options.idleCloseMs ?? 10 * 60 * 1000,
    quarantineRetryMs: 30_000,
    closeDeadlineMs: 500,
    bootTrace: () => "tr_boot_probe",
  });
  await registry.start();
  const quarantined = new Set<string>();
  const registryView = new Proxy(registry, {
    get(target, property) {
      if (property === "state") {
        return (botId: string) => (quarantined.has(botId) ? "quarantined" : target.state(botId));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new ConversationService({
    open: (botId, trace) => registry.open(botId, trace),
    handleOf: (botId) => registry.handleOf(botId),
    measure: measureEvent,
  });
  const daemon = await startServer({
    token,
    log,
    registry: registryView,
    service,
    version: "0.0.0-test",
    instance: "i_test",
    capabilities: {
      agent: false,
      tools: false,
      tasks: false,
      entries: false,
      usage: false,
      peers: false,
    },
    port: 0,
  });
  return {
    port: daemon.port,
    token,
    root,
    records,
    runtime,
    directory,
    registry,
    service,
    daemon,
    opens: () => opens,
    createBot: async (title) => (await registry.create(title, "tr_create_probe")).id,
    quarantine: (botId) => quarantined.add(botId),
    connect: (connectOptions = {}) =>
      new WebSocket(`ws://127.0.0.1:${daemon.port}`, {
        headers: {
          authorization: `Bearer ${connectOptions.token ?? token}`,
          ...connectOptions.headers,
        },
      }),
    close: async () => {
      await daemon.close();
      await registry.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
};

/** A buffered reader: frames that arrive before `next()` is awaited are kept. */
export const frameQueue = (socket: WebSocket) => {
  const buffered: Frame[] = [];
  const waiters: ((frame: Frame) => void)[] = [];
  socket.on("message", (data: { toString(): string }) => {
    const frame = JSON.parse(data.toString()) as Frame;
    const waiter = waiters.shift();
    if (waiter === undefined) buffered.push(frame);
    else waiter(frame);
  });
  return {
    next: (timeoutMs = 5_000): Promise<Frame> => {
      const frame = buffered.shift();
      if (frame !== undefined) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame")), timeoutMs);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
};

/** The next frame as a JSON object, or a rejection when the socket closes first. */
export const nextFrame = (socket: WebSocket): Promise<Frame> =>
  new Promise((resolve, reject) => {
    const onMessage = (data: { toString(): string }) => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Frame);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`closed ${code}`));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });

/** Resolves with the close code, or rejects when the socket does not close. */
export const closeCode = (socket: WebSocket, timeoutMs = 2_000): Promise<number> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket stayed open")), timeoutMs);
    socket.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

/** Sends one frame once the socket is open. */
export const send = async (socket: WebSocket, frame: unknown): Promise<void> => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
    return;
  }
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  socket.send(JSON.stringify(frame));
};

export const hello = { type: "hello", protocolVersion: 1, client: "BotsTest/0.0.0" };
