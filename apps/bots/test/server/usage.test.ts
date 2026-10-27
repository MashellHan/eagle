// Usage statistics (docs/bots/PROTOCOL.md, "Usage statistics"): the runtime's cumulative
// totals become per-day deltas, a reset never books negative work, and ninety days are kept.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageStore } from "../../src/server/usage.ts";

const store = async (options: { now?: () => Date; retentionDays?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "bots-usage-"));
  let at = new Date("2026-10-20T10:00:00");
  const usage = new UsageStore(join(root, "usage.sqlite"), {
    now: options.now ?? (() => at),
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
  });
  return {
    root,
    usage,
    advance: (days: number) => {
      at = new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
    },
    cleanup: async () => {
      usage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("a cumulative total becomes one delta per day and resets book nothing", async () => {
  const bench = await store();
  try {
    bench.usage.record("b_1", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
    });
    bench.usage.record("b_1", {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      costUsd: 0.02,
    });
    bench.advance(1);
    bench.usage.record("b_1", {
      inputTokens: 300,
      outputTokens: 200,
      totalTokens: 500,
      costUsd: 0.04,
    });
    // A reset conversation reports less than before; nothing is subtracted.
    bench.usage.record("b_1", { inputTokens: 5, outputTokens: 5, totalTokens: 10 });

    const report = bench.usage.report(7);
    assert.equal(report.today.totalTokens, 200, "the second day gained 200 tokens");
    assert.equal(report.week.totalTokens, 500);
    assert.equal(report.days.length, 7, "the window is padded with zero days");
    assert.equal(report.days.at(-1)?.day, "2026-10-21");
    assert.equal(report.days.at(-2)?.totalTokens, 300);
    assert.equal(report.bots[0]?.botId, "b_1");
    assert.equal(report.bots[0]?.totalTokens, 500);
  } finally {
    await bench.cleanup();
  }
});

test("today, week and month windows and the retention bound hold", async () => {
  const bench = await store({ retentionDays: 3 });
  try {
    bench.usage.record("b_1", { inputTokens: 10, outputTokens: 0, totalTokens: 10 });
    bench.advance(1);
    bench.usage.record("b_1", { inputTokens: 10, outputTokens: 0, totalTokens: 20 });
    bench.advance(1);
    bench.usage.record("b_1", { inputTokens: 10, outputTokens: 0, totalTokens: 30 });
    bench.advance(1);
    bench.usage.record("b_1", { inputTokens: 10, outputTokens: 0, totalTokens: 40 });
    const report = bench.usage.report(30);
    assert.equal(report.retentionDays, 3);
    assert.equal(report.today.totalTokens, 10);
    assert.equal(report.days.length, 3, "the window never exceeds the retention");
    assert.equal(
      report.week.totalTokens + report.month.totalTokens,
      60,
      "the first day fell out of the three-day window",
    );
    const written = bench.usage.report(3).days.map((day) => day.day);
    assert.deepEqual(written, ["2026-10-21", "2026-10-22", "2026-10-23"]);
  } finally {
    await bench.cleanup();
  }
});
