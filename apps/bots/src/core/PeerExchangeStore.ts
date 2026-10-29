// One durable record per exchange between two local bots (docs/bots/TRIGGERS.md §10). The store
// owns durability, the request-keyed receipt and the turn budget; the tools own the model-facing
// surface. A turn is recorded before its admission is attempted, so a crash in between leaves a
// recoverable receipt rather than a message the sender cannot name.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * How many messages a bot may add to one exchange. The whole point of the number is that two bots
 * cannot talk forever: when a side has spent it, its next send is refused; when both sides have,
 * the exchange closes and stays closed.
 */
export const PEER_MAX_TURNS = 10;

export type PeerTurn = {
  readonly fromBotId: string;
  readonly toBotId: string;
  /** `pr_<16 hex>` of the sending tool task; stable across a retry (TRIGGERS.md §3.2). */
  readonly requestId: string;
  /** When the sender handed it over, ISO. */
  readonly at: string;
};

export type PeerExchangeStatus = "open" | "finished";
export type PeerFinishReason = "turn_limit" | "closed";

export type PeerExchange = {
  readonly id: string;
  /** Two bot ids, in the order the exchange started. */
  readonly participants: readonly [string, string];
  readonly startedAt: string;
  readonly status: PeerExchangeStatus;
  readonly finishedReason?: PeerFinishReason;
  readonly turns: readonly PeerTurn[];
};

export type PeerReceipt = { readonly exchangeId: string; readonly turn: PeerTurn };

const newExchangeId = (): string => `x_${randomBytes(6).toString("hex")}`;

const countOf = (exchange: PeerExchange, botId: string): number =>
  exchange.turns.filter((turn) => turn.fromBotId === botId).length;

const parse = (raw: string): PeerExchange => {
  const value = JSON.parse(raw) as Partial<PeerExchange>;
  if (typeof value.id !== "string" || !Array.isArray(value.turns)) {
    throw new Error("malformed exchange record");
  }
  return value as PeerExchange;
};

export class PeerExchangeStore {
  readonly #root: string;
  /** Appends are serialized: a read-modify-write must not interleave. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Stamped here, so "newest first" never depends on a caller's clock. */
  #clock = 0;

  constructor(root: string) {
    this.#root = root;
  }

  async open(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  async create(participants: readonly [string, string]): Promise<PeerExchange> {
    const exchange: PeerExchange = {
      id: newExchangeId(),
      participants,
      startedAt: this.#stamp(),
      status: "open",
      turns: [],
    };
    await this.#write(exchange);
    return exchange;
  }

  async get(id: string): Promise<PeerExchange | undefined> {
    if (!/^x_[0-9a-f]{12}$/.test(id)) return undefined;
    try {
      return parse(await readFile(this.#path(id), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Every exchange, newest first. Few per daemon: one file each, read on demand. */
  async list(): Promise<readonly PeerExchange[]> {
    const names = await readdir(this.#root).catch(() => [] as string[]);
    const exchanges: PeerExchange[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const exchange = await this.get(name.slice(0, -5));
      if (exchange !== undefined) exchanges.push(exchange);
    }
    return exchanges.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** The open exchange between two bot ids, in either direction. */
  async between(a: string, b: string): Promise<PeerExchange | undefined> {
    const exchanges = await this.list();
    return exchanges.find(
      (exchange) =>
        exchange.status === "open" &&
        exchange.participants.includes(a) &&
        exchange.participants.includes(b),
    );
  }

  /** The turn a retried send already recorded, so a duplicate never becomes a second message. */
  async byRequest(requestId: string): Promise<PeerReceipt | undefined> {
    for (const exchange of await this.list()) {
      const turn = exchange.turns.find((item) => item.requestId === requestId);
      if (turn !== undefined) return { exchangeId: exchange.id, turn };
    }
    return undefined;
  }

  async append(
    id: string,
    turn: Omit<PeerTurn, "at">,
  ): Promise<{ readonly exchange: PeerExchange; readonly duplicate: boolean }> {
    return this.#serial(async () => {
      const exchange = await this.get(id);
      if (exchange === undefined) throw new Error(`unknown exchange ${id}`);
      if (exchange.turns.some((item) => item.requestId === turn.requestId)) {
        return { exchange, duplicate: true };
      }
      const next = settle({
        ...exchange,
        turns: [...exchange.turns, { ...turn, at: this.#stamp() }],
      });
      await this.#write(next);
      return { exchange: next, duplicate: false };
    });
  }

  async finish(id: string, reason: PeerFinishReason): Promise<PeerExchange> {
    return this.#serial(async () => {
      const exchange = await this.get(id);
      if (exchange === undefined) throw new Error(`unknown exchange ${id}`);
      const next: PeerExchange = { ...exchange, status: "finished", finishedReason: reason };
      await this.#write(next);
      return next;
    });
  }

  /** What one bot has sent, newest first: `peer_read` without a request id reads this. */
  async receipts(botId: string, limit: number): Promise<readonly PeerReceipt[]> {
    const receipts: PeerReceipt[] = [];
    for (const exchange of await this.list()) {
      for (const turn of exchange.turns) {
        if (turn.fromBotId === botId) receipts.push({ exchangeId: exchange.id, turn });
      }
    }
    return receipts
      .sort(
        (a, b) =>
          b.turn.at.localeCompare(a.turn.at) || b.turn.requestId.localeCompare(a.turn.requestId),
      )
      .slice(0, limit);
  }

  /** How many messages one bot has added to an exchange. */
  static countIn(exchange: PeerExchange, botId: string): number {
    return countOf(exchange, botId);
  }

  #stamp(): string {
    const now = Date.now();
    this.#clock = now > this.#clock ? now : this.#clock + 1;
    return new Date(this.#clock).toISOString();
  }

  #path(id: string): string {
    return join(this.#root, `${id}.json`);
  }

  /** Temp file plus rename: a reader never sees half an exchange. */
  async #write(exchange: PeerExchange): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const target = this.#path(exchange.id);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(exchange, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

/** The exchange closes once both sides have spent the budget, never before. */
const settle = (exchange: PeerExchange): PeerExchange => {
  if (exchange.status !== "open") return exchange;
  const spent = exchange.participants.every((botId) => countOf(exchange, botId) >= PEER_MAX_TURNS);
  return spent
    ? { ...exchange, status: "finished", finishedReason: "turn_limit" as const }
    : exchange;
};
