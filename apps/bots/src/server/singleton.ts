// The one-owner-per-root lock (docs/bots/ARCHITECTURE.md "Singleton lock"): a kernel
// listener on a port derived from the canonical root path, so the kernel releases it even
// after a SIGKILL and there is no stale file to delete.
import { connect, createServer, type Server, type Socket } from "node:net";
/** Above the service port: `44000 + hash(root) % 1000` (ARCHITECTURE.md). */
export const LOCK_PORT_BASE = 44000;

/** FNV-1a, 32 bit: the hash the lock port is derived from. */
export const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const lockPort = (root: string): number => LOCK_PORT_BASE + (fnv1a(root) % 1000);

export type LockOwner = {
  readonly root: string;
  readonly port: number;
  close(): Promise<void>;
};

export class LockError extends Error {
  readonly reason: "running" | "collision" | "unavailable";

  constructor(reason: LockError["reason"], message: string) {
    super(message);
    this.name = "LockError";
    this.reason = reason;
  }
}

export type LockOptions = {
  readonly root: string;
  readonly pid?: number;
  /** Connect-and-ask timeout for the case where another process holds the port. */
  readonly probeTimeoutMs?: number;
};

/**
 * Binds the lock port. `EADDRINUSE` is resolved by asking the owner which root it serves:
 * the same root is a live daemon, a different one is a hash collision.
 */
export const acquireLock = async (options: LockOptions): Promise<LockOwner> => {
  const root = options.root;
  const port = lockPort(root);
  const pid = options.pid ?? process.pid;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // The challenger speaks first; the owner answers with its identity.
    socket.once("data", () => {
      socket.end(`${root}\t${pid}\n`);
    });
    socket.on("error", () => undefined);
  });
  try {
    await listen(server, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw new LockError("unavailable", `cannot bind the lock port ${port}: ${String(error)}`);
    }
    await closeServer(server);
    const owner = await ask({ port, root, timeoutMs: options.probeTimeoutMs ?? 1_000 });
    if (owner === undefined) {
      throw new LockError("unavailable", `port ${port} is held but no daemon answered`);
    }
    if (owner.root === root) {
      throw new LockError(
        "running",
        `another daemon (pid ${String(owner.pid)}) already owns ${root}`,
      );
    }
    throw new LockError(
      "collision",
      `lock port ${port} is shared: ${root} and ${owner.root} hash to the same port; use a different root`,
    );
  }
  return {
    root,
    port,
    close: async () => {
      // A client that connected and never wrote would otherwise hold `close()` forever.
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

const listen = (server: Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port });
  });

/** One line from the current owner, or undefined when nothing answers. */
const ask = async (options: {
  readonly port: number;
  readonly root: string;
  readonly timeoutMs: number;
}): Promise<{ readonly root: string; readonly pid: string } | undefined> => {
  const answer = await new Promise<string | undefined>((resolve) => {
    const socket: Socket = connect({ host: "127.0.0.1", port: options.port });
    let body = "";
    const done = (value: string | undefined) => {
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), options.timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${options.root}\n`));
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (body.includes("\n")) {
        clearTimeout(timer);
        done(body.trim());
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      done(undefined);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      // A partial line without its newline is not an answer: resolve the probe so a
      // half-speaking owner cannot hang the start.
      if (!body.includes("\n")) done(undefined);
    });
  });
  if (answer === undefined) return undefined;
  const [root, pid] = answer.split("\t");
  if (root === undefined) return undefined;
  return { root, pid: pid ?? "?" };
};
