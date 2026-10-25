// Ladder rows 44-47: one open per bot, idle close, quarantine and the recovery scan.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../src/core/BotRegistry.ts";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import { captureLog } from "../../src/log/log.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";
import { createBench } from "../support/pi.ts";

const fakeTimers = () => {
  let now = 0;
  let sequence = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, delayMs: number) => {
      sequence += 1;
      const id = sequence;
      pending.set(id, { at: now + delayMs, run });
      return () => pending.delete(id);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
      }
      await settle();
    },
    pending: () => pending.size,
  };
};

const settle = async (times = 8): Promise<void> => {
  for (let index = 0; index < times; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
};

const bench = async (
  options: {
    busy?: readonly string[];
    closeOutcome?: "closed" | "timeout";
    bots?: readonly string[];
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  for (const [index, title] of (options.bots ?? []).entries()) {
    await directory.create({
      id: `b_bot${index}`,
      title,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
  }
  const { log, records } = captureLog();
  const runtime = new FakeRuntime();
  const timers = fakeTimers();
  let opens = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      opens += 1;
      const handle = await runtime.open(spec);
      const busy = (options.busy ?? []).includes(spec.id);
      return {
        ...handle,
        busy: async () => (busy ? { run: true, tasks: false } : handle.busy()),
        close: async () => {
          await handle.close("tr_close_probe", 100);
          return options.closeOutcome ?? "closed";
        },
      };
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 1_000,
    quarantineRetryMs: 5_000,
    closeDeadlineMs: 100,
    setTimer: timers.setTimer,
    bootTrace: () => "tr_boot_probe",
  });
  return {
    root,
    registry,
    records,
    timers,
    opens: () => opens,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("open is idempotent and shared by concurrent subscribers", async () => {
  const setup = await bench({ bots: ["shared"] });
  try {
    await setup.registry.start();
    const [first, second] = await Promise.all([
      setup.registry.open("b_bot0", "tr_a_00000001"),
      setup.registry.open("b_bot0", "tr_b_00000002"),
    ]);
    assert.equal(first, second, "both subscribers share one handle");
    assert.equal(setup.opens(), 1, "the Harness opened once");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("an idle bot closes after idleCloseMs and reopens on demand", async () => {
  const setup = await bench();
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("idle", "tr_create_0001");
    const handle = await setup.registry.open(summary.id, "tr_open_000001");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state(summary.id), "catalogued", "the idle bot closed");
    assert.deepEqual(await handle.busy(), { run: false, tasks: false });
    const reopened = await setup.registry.open(summary.id, "tr_open_000002");
    assert.notEqual(reopened, handle, "a reopen creates a new handle");
    assert.equal(setup.opens(), 2);
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a timed-out close quarantines and refuses open and delete", async () => {
  const setup = await bench({ closeOutcome: "timeout" });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("stuck", "tr_create_0002");
    await setup.registry.open(summary.id, "tr_open_000003");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state(summary.id), "quarantined");
    await assert.rejects(
      () => setup.registry.open(summary.id, "tr_open_000004"),
      /quarantined/,
      "open is refused",
    );
    await assert.rejects(
      () => setup.registry.remove(summary.id, "tr_delete_0001"),
      /quarantined/,
      "delete is refused",
    );
    assert.ok(
      setup.records.some((record) => record.evt === "core.bot.close.degrade"),
      "the timeout is logged as a degradation, never as success",
    );
  } finally {
    await setup.cleanup();
  }
});

test("recovery scan resumes active bots and leaves the rest closed", async () => {
  const setup = await bench({ bots: ["busy", "quiet"], busy: ["b_bot0"] });
  try {
    await setup.registry.start();
    assert.equal(setup.registry.state("b_bot0"), "idle", "the busy bot keeps its handle");
    assert.equal(setup.registry.state("b_bot1"), "idle", "the quiet bot is open but idle");
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state("b_bot0"), "idle", "a busy bot is never idle-closed");
    assert.equal(setup.registry.state("b_bot1"), "catalogued", "the quiet bot closed");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("delete closes the handle and removes the bot from the catalog", async () => {
  const setup = await bench();
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("gone", "tr_create_0003");
    await setup.registry.open(summary.id, "tr_open_000005");
    await setup.registry.remove(summary.id, "tr_delete_0002");
    assert.deepEqual(setup.registry.summaries(), []);
    assert.deepEqual(
      await setup.registry.open
        .call(setup.registry, summary.id, "tr_open_000006")
        .catch((error: unknown) => (error as Error).message),
      "unknown bot",
    );
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("recover re-opens a bot whose open failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  const { log } = captureLog();
  const runtime = new FakeRuntime();
  let attempts = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      attempts += 1;
      if (attempts === 1) throw new Error("sqlite is locked");
      return runtime.open(spec);
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 60_000,
    quarantineRetryMs: 60_000,
    closeDeadlineMs: 100,
    bootTrace: () => "tr_boot_probe",
  });
  try {
    await directory.create({
      id: "b_flaky",
      title: "flaky",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
    // The recovery scan is the first open, and it fails: the bot is unavailable.
    await registry.start();
    const summary = { id: "b_flaky" };
    assert.equal(registry.state(summary.id), "unavailable", "a failed scan leaves it unavailable");
    assert.deepEqual(registry.summaries()[0]?.unavailable?.reason, "storage_failed");
    await registry.recover(summary.id, "tr_recover_0001");
    assert.equal(registry.state(summary.id), "idle");
    assert.equal(attempts, 2);
    assert.equal(registry.summaries()[0]?.unavailable, undefined);
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a delete whose close times out leaves the bot in quarantine", async () => {
  const setup = await bench({ closeOutcome: "timeout" });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("stuck2", "tr_create_0005");
    await setup.registry.open(summary.id, "tr_open_000008");
    await assert.rejects(
      () => setup.registry.remove(summary.id, "tr_delete_0003"),
      /quarantined/,
      "a close that did not finish refuses the delete",
    );
    assert.equal(setup.registry.state(summary.id), "quarantined");
    assert.deepEqual(
      setup.registry.summaries().map((bot) => bot.id),
      [summary.id],
      "the catalog entry is still there",
    );
  } finally {
    await setup.cleanup();
  }
});

test("an upstream open failure is propagated, not re-originated at core", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  const { log, records } = captureLog();
  const failure = { id: "f_runtime_1", kind: "session_failed" as const, layer: "runtime" as const };
  const registry = new BotRegistry({
    directory,
    openRuntime: async () => {
      throw new ClassifiedFailure(failure, "runtime", "the harness would not open");
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 60_000,
    quarantineRetryMs: 60_000,
    closeDeadlineMs: 100,
    bootTrace: () => "tr_boot_probe",
  });
  try {
    await directory.create({
      id: "b_upstream",
      title: "upstream",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
    await registry.start();
    const open = await registry
      .open("b_upstream", "tr_open_upstream")
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(open instanceof ClassifiedFailure, "the refusal keeps its class and identity");
    assert.equal(open.failure.id, failure.id);
    assert.equal(registry.state("b_upstream"), "unavailable");
    const core = records.filter((record) => record.evt === "core.bot.open.fail");
    assert.equal(core.length, 2, "both the scan and the explicit open are recorded");
    for (const record of core) {
      assert.equal(record.level, "warn", "only the originating layer logs at error");
      assert.equal(record.err?.failure, failure.id, "same identity as the runtime record");
      assert.equal(record.err?.origin, undefined);
      assert.equal(record.detail?.propagated, true, "the record says core propagated it");
    }
    assert.equal(
      records.filter((record) => record.level === "error" && record.err?.failure === failure.id)
        .length,
      0,
      "no second error record for one failure",
    );
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("two subscribers share one real Harness, so one sqlite file has one owner", async () => {
  const bench = await createBench();
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  const { log } = captureLog();
  let opens = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      opens += 1;
      return bench.runtime.open(spec);
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 60_000,
    quarantineRetryMs: 60_000,
    closeDeadlineMs: 1_000,
    bootTrace: () => "tr_boot_probe",
  });
  try {
    await directory.create({
      id: "b_real",
      title: "real",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
    await registry.start();
    const [first, second] = await Promise.all([
      registry.open("b_real", "tr_a_00000001"),
      registry.open("b_real", "tr_b_00000002"),
    ]);
    assert.equal(first, second, "one handle for the bot");
    assert.equal(opens, 1, "one Harness opened over the one sqlite file");
    assert.deepEqual(await first.busy(), { run: false, tasks: false });
  } finally {
    await registry.shutdown();
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
