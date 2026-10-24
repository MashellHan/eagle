// The bot catalog: one JSON file written atomically, one directory per bot, and the
// reconciliation that finishes a delete interrupted between its two steps
// (docs/bots/ARCHITECTURE.md "Bot lifecycle"). Everything that mutates the catalog runs
// on one internal queue, so concurrent callers cannot overwrite each other.
import { randomUUID } from "node:crypto";
import type { BotRecord } from "./domain.ts";
import { BOT_ID_PATTERN } from "./domain.ts";

export type DirEntry = { readonly name: string; isDirectory(): boolean };

export interface DirectoryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, body: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export type DirectoryErrorReason =
  | "unknown_bot"
  | "duplicate_bot"
  | "corrupt_catalog"
  | "storage_failed";

export class DirectoryError extends Error {
  readonly reason: DirectoryErrorReason;

  constructor(reason: DirectoryErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DirectoryError";
    this.reason = reason;
  }
}

const CATALOG = "catalog.json";
const CATALOG_VERSION = 1;

export type BotConfig = BotRecord & {
  readonly instructions?: string;
  readonly thinkingLevel?: string;
};

export type ReconcileResult = {
  readonly finishedDeletes: readonly string[];
  readonly orphanedTrash: readonly string[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RECORD_KEYS = new Set([
  "id",
  "title",
  "createdAt",
  "updatedAt",
  "model",
  "instructions",
  "thinkingLevel",
]);

const isBotRecord = (value: unknown): value is BotConfig => {
  if (!isObject(value)) return false;
  if (Object.keys(value).some((key) => !RECORD_KEYS.has(key))) return false;
  if (!isObject(value.model)) return false;
  if (Object.keys(value.model).some((key) => key !== "provider" && key !== "modelId")) return false;
  const optional = value as { instructions?: unknown; thinkingLevel?: unknown };
  if (optional.instructions !== undefined && typeof optional.instructions !== "string")
    return false;
  if (optional.thinkingLevel !== undefined && typeof optional.thinkingLevel !== "string") {
    return false;
  }
  return (
    typeof value.id === "string" &&
    BOT_ID_PATTERN.test(value.id) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.model.provider === "string" &&
    typeof value.model.modelId === "string"
  );
};

const assertRecord = (bot: unknown, what: string): BotConfig => {
  if (!isBotRecord(bot)) throw new DirectoryError("corrupt_catalog", `${what} is malformed`);
  return bot;
};

export class BotDirectory {
  readonly #root: string;
  readonly #fs: DirectoryFs;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, fs: DirectoryFs) {
    this.#root = root;
    this.#fs = fs;
  }

  get catalogPath(): string {
    return `${this.#root}/${CATALOG}`;
  }

  botDir(id: string): string {
    return `${this.#root}/bots/${id}`;
  }

  trashDir(id: string): string {
    return `${this.#root}/trash/${id}`;
  }

  async load(): Promise<readonly BotConfig[]> {
    let body: string;
    try {
      body = await this.#fs.readFile(this.catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new DirectoryError("storage_failed", "cannot read catalog", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new DirectoryError("corrupt_catalog", "catalog is not JSON", { cause: error });
    }
    if (!isObject(parsed)) throw new DirectoryError("corrupt_catalog", "catalog is not an object");
    if (parsed.version !== CATALOG_VERSION) {
      throw new DirectoryError("corrupt_catalog", "catalog version is not 1");
    }
    const bots = parsed.bots;
    if (!Array.isArray(bots))
      throw new DirectoryError("corrupt_catalog", "catalog has no bots array");
    const seen = new Set<string>();
    for (const [index, bot] of bots.entries()) {
      if (!isBotRecord(bot)) {
        throw new DirectoryError("corrupt_catalog", `catalog entry ${index} is malformed`);
      }
      if (seen.has(bot.id)) {
        throw new DirectoryError("corrupt_catalog", `catalog repeats bot ${bot.id}`);
      }
      seen.add(bot.id);
    }
    return bots as readonly BotConfig[];
  }

  #writeAll(bots: readonly BotConfig[]): Promise<void> {
    for (const [index, bot] of bots.entries()) {
      if (!isBotRecord(bot)) {
        return Promise.reject(
          new DirectoryError("corrupt_catalog", `refusing to write malformed entry ${index}`),
        );
      }
    }
    return this.#writeCatalog(bots);
  }

  async #writeCatalog(bots: readonly BotConfig[]): Promise<void> {
    const temp = `${this.catalogPath}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: CATALOG_VERSION, bots }, null, 2)}\n`;
    try {
      await this.#fs.writeFile(temp, body, 0o600);
      await this.#fs.rename(temp, this.catalogPath);
    } catch (error) {
      await this.#fs.unlink(temp).catch(() => {});
      throw new DirectoryError("storage_failed", "cannot write catalog", { cause: error });
    }
  }

  /** Persists the bot config, then publishes the catalog entry. */
  async create(config: BotConfig): Promise<void> {
    // Validate before touching the filesystem: a malformed config must not leave a
    // directory or a bot.json behind.
    assertRecord(config, "bot config");
    await this.#serial(async () => {
      const bots = await this.load();
      if (bots.some((bot) => bot.id === config.id)) {
        throw new DirectoryError("duplicate_bot", `bot ${config.id} already exists`);
      }
      try {
        await this.#fs.mkdir(this.botDir(config.id), { recursive: true });
        await this.#fs.writeFile(
          `${this.botDir(config.id)}/bot.json`,
          `${JSON.stringify(config, null, 2)}\n`,
          0o600,
        );
      } catch (error) {
        throw new DirectoryError("storage_failed", `cannot write bot ${config.id}`, {
          cause: error,
        });
      }
      await this.#writeAll([...bots, config]);
    });
  }

  async rename(id: string, title: string, at: string): Promise<BotConfig> {
    return this.#serial(async () => {
      const bots = await this.load();
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      const current = bots[index] as BotConfig;
      const updated: BotConfig = { ...current, title, updatedAt: at };
      await this.#writeAll(bots.map((bot, position) => (position === index ? updated : bot)));
      return updated;
    });
  }

  /**
   * Two idempotent steps. ENOENT from the move is only acceptable when the source is
   * gone *and* the trash directory is there; anything else keeps the catalog entry so
   * the bot cannot become unreachable.
   */
  async remove(id: string): Promise<void> {
    await this.#serial(async () => {
      const bots = await this.load();
      if (!bots.some((bot) => bot.id === id)) {
        throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      }
      try {
        await this.#fs.mkdir(`${this.#root}/trash`, { recursive: true });
        await this.#fs.rename(this.botDir(id), this.trashDir(id));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const sourceGone = !(await this.#exists(this.botDir(id)));
        const trashed = await this.#exists(this.trashDir(id));
        if (!trashed && (await this.#exists(this.trashDir(id)))) {
          throw new DirectoryError("storage_failed", `trash path for ${id} is not a directory`);
        }
        if (!(code === "ENOENT" && sourceGone && trashed)) {
          throw new DirectoryError("storage_failed", `cannot move bot ${id} to trash`, {
            cause: error,
          });
        }
      }
      await this.#writeAll(bots.filter((bot) => bot.id !== id));
    });
  }

  async reconcile(): Promise<ReconcileResult> {
    return this.#serial(async () => {
      const bots = await this.load();
      const trashed = new Set(await this.#list(`${this.#root}/trash`));
      const present = new Set(await this.#list(`${this.#root}/bots`));
      const finishedDeletes = bots
        .filter((bot) => !present.has(bot.id) && trashed.has(bot.id))
        .map((bot) => bot.id);
      if (finishedDeletes.length > 0) {
        await this.#writeAll(bots.filter((bot) => !finishedDeletes.includes(bot.id)));
      }
      const catalogIds = new Set(bots.map((bot) => bot.id));
      return {
        finishedDeletes,
        orphanedTrash: [...trashed].filter((name) => !catalogIds.has(name)).sort(),
      };
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #exists(path: string): Promise<boolean> {
    try {
      const stats = await this.#fs.stat(path);
      return stats.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new DirectoryError("storage_failed", `cannot inspect ${path}`, { cause: error });
    }
  }

  async #list(path: string): Promise<string[]> {
    try {
      const entries = await this.#fs.readdir(path);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new DirectoryError("storage_failed", `cannot list ${path}`, { cause: error });
    }
  }
}

/** The real filesystem adapter used by the daemon. */
export const nodeDirectoryFs = async (): Promise<DirectoryFs> => {
  const fs = await import("node:fs/promises");
  return {
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, body, mode) => fs.writeFile(path, body, { mode: mode ?? 0o600 }),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, options) => fs.mkdir(path, options).then(() => undefined),
    readdir: async (path) =>
      (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory(),
      })),
    stat: async (path) => {
      const stats = await fs.stat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
};
