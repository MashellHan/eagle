// The bot catalog: one JSON file, written atomically, plus the reconciliation that
// finishes a delete interrupted between its two steps (docs/bots/ARCHITECTURE.md,
// "Bot lifecycle"). Filesystem calls go through an injected interface so the failure
// windows can be tested exactly.
import { randomUUID } from "node:crypto";
import type { BotRecord } from "./domain.ts";

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

export class DirectoryError extends Error {}

const CATALOG = "catalog.json";

export type ReconcileResult = {
  /** Catalog entries removed because their bot directory is gone and trash has it. */
  readonly finishedDeletes: readonly string[];
  /** Trash directories with no catalog entry are left alone. */
  readonly orphanedTrash: readonly string[];
};

export class BotDirectory {
  readonly #root: string;
  readonly #fs: DirectoryFs;

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

  async load(): Promise<readonly BotRecord[]> {
    let body: string;
    try {
      body = await this.#fs.readFile(this.catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new DirectoryError(`cannot read catalog: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new DirectoryError("catalog is not JSON");
    }
    const bots = (parsed as { bots?: unknown }).bots;
    if (!Array.isArray(bots)) throw new DirectoryError("catalog has no bots array");
    return bots as readonly BotRecord[];
  }

  /** Writes through a temporary file and renames, so a crash never leaves a partial catalog. */
  async writeAll(bots: readonly BotRecord[]): Promise<void> {
    const temp = `${this.catalogPath}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: 1, bots }, null, 2)}\n`;
    try {
      await this.#fs.writeFile(temp, body, 0o600);
      await this.#fs.rename(temp, this.catalogPath);
    } catch (error) {
      await this.#fs.unlink(temp).catch(() => {});
      throw new DirectoryError(`cannot write catalog: ${(error as Error).message}`);
    }
  }

  async create(record: BotRecord): Promise<void> {
    const bots = await this.load();
    if (bots.some((bot) => bot.id === record.id)) {
      throw new DirectoryError(`bot ${record.id} already exists`);
    }
    await this.#fs.mkdir(this.botDir(record.id), { recursive: true });
    await this.writeAll([...bots, record]);
  }

  async rename(id: string, title: string, at: string): Promise<BotRecord> {
    const bots = await this.load();
    const index = bots.findIndex((bot) => bot.id === id);
    if (index === -1) throw new DirectoryError(`bot ${id} does not exist`);
    const current = bots[index] as BotRecord;
    const updated: BotRecord = { ...current, title, updatedAt: at };
    const next = bots.map((bot, position) => (position === index ? updated : bot));
    await this.writeAll(next);
    return updated;
  }

  /**
   * Two idempotent steps: move the directory to its deterministic trash path, then
   * drop the catalog entry. A failure after the move is finished by `reconcile`.
   */
  async remove(id: string): Promise<void> {
    const bots = await this.load();
    if (!bots.some((bot) => bot.id === id)) throw new DirectoryError(`bot ${id} does not exist`);
    await this.#fs.mkdir(`${this.#root}/trash`, { recursive: true });
    try {
      await this.#fs.rename(this.botDir(id), this.trashDir(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DirectoryError(`cannot move bot ${id} to trash: ${(error as Error).message}`);
      }
    }
    await this.writeAll(bots.filter((bot) => bot.id !== id));
  }

  /** Finishes interrupted deletes and reports trash that no catalog entry points at. */
  async reconcile(): Promise<ReconcileResult> {
    const bots = await this.load();
    const trashed = await this.#list(`${this.#root}/trash`);
    const present = new Set(await this.#list(`${this.#root}/bots`));
    const trashedSet = new Set(trashed);
    const finishedDeletes = bots
      .filter((bot) => !present.has(bot.id) && trashedSet.has(bot.id))
      .map((bot) => bot.id);
    if (finishedDeletes.length > 0) {
      const keep = bots.filter((bot) => !finishedDeletes.includes(bot.id));
      await this.writeAll(keep);
    }
    const catalogIds = new Set(bots.map((bot) => bot.id));
    return {
      finishedDeletes,
      orphanedTrash: trashed.filter((name) => !catalogIds.has(name)),
    };
  }

  async #list(path: string): Promise<string[]> {
    try {
      const entries = await this.#fs.readdir(path);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new DirectoryError(`cannot list ${path}: ${(error as Error).message}`);
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
