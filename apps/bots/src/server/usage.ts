// Usage statistics (docs/bots/PROTOCOL.md, "Usage statistics"): one row per bot and local
// day, kept for 90 days so Settings can show today, a week, a month and who spends the most.
// The store lives beside the token, not in a bot's session, so deleting a bot keeps history.
import { DatabaseSync } from "node:sqlite";
import type { Usage } from "../core/domain.ts";

export const RETENTION_DAYS = 90;

export type UsageTotals = {
  readonly totalTokens: number;
  readonly costUsd: number;
};

export type UsageDay = UsageTotals & { readonly day: string };

export type UsageBot = UsageTotals & { readonly botId: string };

export type UsageReport = {
  readonly retentionDays: number;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  readonly month: UsageTotals;
  /** The requested window, oldest first, with a zero row for a day nothing ran. */
  readonly days: readonly UsageDay[];
  /** The busiest bots inside the retention window, busiest first. */
  readonly bots: readonly UsageBot[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in the machine's own zone: a day is what the person experienced. */
export const dayOf = (at: Date): string => {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dayBefore = (at: Date, days: number): string => dayOf(new Date(at.getTime() - days * DAY_MS));

export class UsageStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #retention: number;

  constructor(
    path: string,
    options: { readonly now?: () => Date; readonly retentionDays?: number } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#retention = options.retentionDays ?? RETENTION_DAYS;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      create table if not exists daily (
        bot_id text not null,
        day text not null,
        total_tokens integer not null,
        cost_usd real not null,
        primary key (bot_id, day)
      );
      create table if not exists last_seen (
        bot_id text primary key,
        total_tokens integer not null,
        cost_usd real not null
      );
    `);
    this.prune();
  }

  /**
   * Adds the tokens and cost a conversation gained since the last report. The runtime's
   * usage is cumulative, so a delta is what belongs to today; a lower total (a reset
   * conversation) books nothing rather than a negative row.
   */
  record(botId: string, usage: Usage): void {
    const day = dayOf(this.#now());
    const seen = this.#db
      .prepare("select total_tokens, cost_usd from last_seen where bot_id = ?")
      .get(botId) as { total_tokens: number; cost_usd: number } | undefined;
    const previousTokens = seen?.total_tokens ?? 0;
    const previousCost = seen?.cost_usd ?? 0;
    const tokens = Math.max(0, usage.totalTokens - previousTokens);
    const cost = Math.max(0, (usage.costUsd ?? 0) - previousCost);
    if (tokens === 0 && cost === 0 && seen !== undefined) return;
    this.#db
      .prepare(
        `insert into daily (bot_id, day, total_tokens, cost_usd) values (?, ?, ?, ?)
         on conflict(bot_id, day) do update set
           total_tokens = total_tokens + excluded.total_tokens,
           cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(botId, day, tokens, cost);
    this.#db
      .prepare(
        `insert into last_seen (bot_id, total_tokens, cost_usd) values (?, ?, ?)
         on conflict(bot_id) do update set
           total_tokens = excluded.total_tokens,
           cost_usd = excluded.cost_usd`,
      )
      .run(botId, usage.totalTokens, usage.costUsd ?? 0);
    this.prune();
  }

  /** Drops what fell out of the retention window; cheap, so it runs on boot and on write. */
  prune(): void {
    this.#db
      .prepare("delete from daily where day < ?")
      .run(dayBefore(this.#now(), this.#retention));
  }

  report(days = 30): UsageReport {
    const at = this.#now();
    const window = Math.min(Math.max(days, 1), this.#retention);
    const rows = this.#db
      .prepare("select day, total_tokens, cost_usd from daily where day >= ?")
      .all(dayBefore(at, window - 1)) as { day: string; total_tokens: number; cost_usd: number }[];
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const series: UsageDay[] = [];
    for (let offset = window - 1; offset >= 0; offset -= 1) {
      const day = dayBefore(at, offset);
      const row = byDay.get(day);
      series.push({
        day,
        totalTokens: row?.total_tokens ?? 0,
        costUsd: row?.cost_usd ?? 0,
      });
    }
    const sum = (from: number): UsageTotals => {
      const since = dayBefore(at, from - 1);
      let totalTokens = 0;
      let costUsd = 0;
      for (const row of rows) {
        if (row.day < since) continue;
        totalTokens += row.total_tokens;
        costUsd += row.cost_usd;
      }
      return { totalTokens, costUsd };
    };
    const bots = this.#db
      .prepare(
        `select bot_id as botId, sum(total_tokens) as totalTokens, sum(cost_usd) as costUsd
         from daily where day >= ? group by bot_id order by totalTokens desc limit 10`,
      )
      .all(dayBefore(at, this.#retention - 1)) as UsageBot[];
    return {
      retentionDays: this.#retention,
      today: sum(1),
      week: sum(7),
      month: sum(30),
      days: series,
      bots,
    };
  }

  close(): void {
    this.#db.close();
  }
}
