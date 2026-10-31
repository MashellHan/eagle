// The pull requests a Bot reports (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group). One
// append-only journal per Bot is the source of truth, keyed by URL: the model is the only
// writer, the daemon never queries a forge, and a replayed tool call returns what it already
// stored instead of appending a second record.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Pull = {
  /** Opened verbatim: any http(s) forge, never rewritten. */
  readonly url: string;
  readonly title: string;
  /** The tool surface owns the closed set; the store keeps whatever it was told. */
  readonly status: string;
  /** The host the row shows, so GitHub, ADO and anything else read alike. */
  readonly host: string;
  readonly updatedAt: string;
};

export const MAX_PULLS = 20;
export const MAX_PULL_TITLE = 200;
const MAX_JOURNAL_RECORDS = 200;

export const pullJournalPath = (botDir: string): string => `${botDir}/pulls.journal.jsonl`;

export type PullRefusal = "invalid_url" | "invalid_title" | "invalid_status";

/** A refusal the tool layer turns into a model-visible message; never a thrown bug. */
export class PullStoreError extends Error {
  readonly reason: PullRefusal;

  constructor(reason: PullRefusal, message: string) {
    super(message);
    this.name = "PullStoreError";
    this.reason = reason;
  }
}

type JournalRecord = {
  readonly op: "upsert";
  readonly opId: string;
  readonly at: string;
  readonly pull: Pull;
};

export type PullStoreOptions = {
  /** Deterministic clock for tests; the daemon passes the real one. */
  readonly now?: () => Date;
  /** Told after every applied change, so an open client follows a model's edit. */
  readonly onChange?: (pulls: readonly Pull[]) => void;
  /** Told once the replay finished, with anything it could not read. */
  readonly onDropped?: (count: number) => void;
};

export const pullHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export class PullStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #onChange: ((pulls: readonly Pull[]) => void) | undefined;
  /** url → pull: the journal is append-only, so the last record for a URL wins. */
  #pulls = new Map<string, Pull>();
  /** opId → url, so a replayed tool call is answered instead of applied twice. */
  readonly #ops = new Map<string, string>();
  #records = 0;
  #queue: Promise<unknown> = Promise.resolve();
  /** Two reports in the same millisecond still order the way they happened. */
  #clock = 0;

  private constructor(path: string, options: PullStoreOptions) {
    this.#path = path;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange;
  }

  static async open(path: string, options: PullStoreOptions = {}): Promise<PullStore> {
    const store = new PullStore(path, options);
    await store.#replay(options.onDropped);
    return store;
  }

  /** Newest first: the row order a person reads. */
  list(): readonly Pull[] {
    return [...this.#pulls.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One URL, one row: a second report updates that row instead of adding another. */
  async upsert(input: {
    readonly url: string;
    readonly title: string;
    readonly status: string;
    readonly opId: string;
    readonly at?: string;
  }): Promise<{ readonly pull: Pull; readonly created: boolean }> {
    const url = normalizeUrl(input.url);
    const title = normalizeTitle(input.title);
    const status = normalizeStatus(input.status);
    const added = input.at === undefined ? this.#stamp() : input.at;
    const record: JournalRecord = {
      op: "upsert",
      opId: input.opId,
      at: added,
      pull: { url, title, status, host: pullHost(url), updatedAt: added },
    };
    return this.#serial(async () => {
      const replayed = this.#ops.get(input.opId);
      if (replayed !== undefined) {
        const existing = this.#pulls.get(replayed);
        if (existing !== undefined) return { pull: existing, created: false };
      }
      const created = !this.#pulls.has(url);
      this.#pulls.set(url, record.pull);
      this.#ops.set(record.opId, url);
      await this.#append(record);
      this.#evict();
      this.#onChange?.(this.list());
      return { pull: record.pull, created };
    });
  }

  /** One journal record per change; a crash can lose an edit but never half-apply one. */
  async #append(record: JournalRecord): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await appendFile(this.#path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.#records += 1;
    if (this.#records > MAX_JOURNAL_RECORDS) await this.#compact();
  }

  /** The journal keeps every edit; past the cap it is rewritten to one record per URL. */
  async #compact(): Promise<void> {
    const records: JournalRecord[] = [...this.#pulls.values()].map((pull) => ({
      op: "upsert",
      opId: `compact_${pull.url}`,
      at: pull.updatedAt,
      pull,
    }));
    const temporary = `${this.#path}.tmp`;
    const body = records.map((record) => JSON.stringify(record)).join("\n");
    await writeFile(temporary, `${body}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
    this.#records = records.length;
  }

  async #replay(onDropped?: (count: number) => void): Promise<void> {
    let body = "";
    try {
      body = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    let dropped = 0;
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseRecord(line);
      if (record === undefined) {
        dropped += 1;
        continue;
      }
      this.#pulls.set(record.pull.url, record.pull);
      this.#ops.set(record.opId, record.pull.url);
      this.#records += 1;
    }
    if (dropped > 0) onDropped?.(dropped);
    if (this.#records > MAX_JOURNAL_RECORDS) await this.#compact();
  }

  /** Only the newest few are useful: the panel is not a forge dashboard. */
  #evict(): void {
    const keep = this.list().slice(0, MAX_PULLS);
    if (keep.length === this.#pulls.size) return;
    this.#pulls = new Map(keep.map((pull) => [pull.url, pull]));
  }

  #stamp(): string {
    const now = this.#now().getTime();
    this.#clock = now > this.#clock ? now : this.#clock + 1;
    return new Date(this.#clock).toISOString();
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

const parseRecord = (line: string): JournalRecord | undefined => {
  try {
    const value = JSON.parse(line) as Partial<JournalRecord>;
    if (value.op !== "upsert" || typeof value.opId !== "string") return undefined;
    const pull = value.pull as Partial<Pull> | undefined;
    if (
      pull === undefined ||
      typeof pull.url !== "string" ||
      typeof pull.title !== "string" ||
      typeof pull.updatedAt !== "string" ||
      typeof pull.status !== "string" ||
      pull.status === ""
    )
      return undefined;
    return {
      op: "upsert",
      opId: value.opId,
      at: typeof value.at === "string" ? value.at : pull.updatedAt,
      pull: {
        url: pull.url,
        title: pull.title,
        status: pull.status,
        host: typeof pull.host === "string" ? pull.host : pullHost(pull.url),
        updatedAt: pull.updatedAt,
      },
    };
  } catch {
    return undefined;
  }
};

const normalizeUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PullStoreError("invalid_url", `"${value}" is not a link`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PullStoreError("invalid_url", "the link must be http or https");
  }
  return url.toString();
};

const normalizeTitle = (value: string): string => {
  const title = value.trim();
  if (title === "" || title.length > MAX_PULL_TITLE) {
    throw new PullStoreError("invalid_title", `the title must be 1-${MAX_PULL_TITLE} characters`);
  }
  return title;
};

const normalizeStatus = (value: string): string => {
  const status = value.trim().toLowerCase();
  if (status === "" || status.length > 32) {
    throw new PullStoreError("invalid_status", "status must be 1-32 characters");
  }
  return status;
};
