// Ladder row 54: the performance measurement. Separate from `npm test` because absolute
// milliseconds are not deterministic; the bounds are generous so a real regression fails
// and noise does not (docs/bots/TESTING.md, "Performance measurement").
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { captureLog } from "../../src/log/log.ts";
import { PiDurableRuntime } from "../../src/runtime/pi/PiDurableRuntime.ts";

const SAMPLES = 5;

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? 0;
};

const bench = async (run: () => Promise<void>): Promise<{ median: number; values: number[] }> => {
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await run();
    values.push(Math.round((performance.now() - started) * 100) / 100);
  }
  return { median: Math.round(median(values)), values };
};

const report = (
  name: string,
  result: { median: number; values: number[] },
  bound: number,
): void => {
  process.stdout.write(
    `${JSON.stringify({
      measure: name,
      medianMs: result.median,
      samplesMs: result.values,
      boundMs: bound,
    })}\n`,
  );
  assert.ok(result.median < bound, `${name} took ${result.median} ms, over the ${bound} ms bound`);
};

test("the documented operations stay inside their bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-perf-"));
  const faux = fauxProvider({});
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
  process.stdout.write(
    `${JSON.stringify({
      machine: process.arch,
      platform: process.platform,
      node: process.version,
      cpus: (await import("node:os")).availableParallelism(),
      filesystem: (await import("node:os")).tmpdir(),
    })}\n`,
  );
  try {
    const openEmpty = await bench(async () => {
      const harness = await Harness.open(
        await openNodeSqliteStorage(join(dir, `empty-${Math.random()}.sqlite`)),
        {
          models,
          registry: createRegistry(),
          settings: { compaction: { enabled: false } } as never,
        },
        BACKGROUND_CONTEXT,
      );
      await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
      await harness.close(BACKGROUND_CONTEXT);
    });
    report("Harness.open + root() on an empty bot", openEmpty, 250);

    // A reopen with 400 entries: one real conversation, then measure open again.
    const path = join(dir, "busy-bot", "session.sqlite");
    await mkdir(join(dir, "busy-bot"), { recursive: true });
    const harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models, registry: createRegistry(), settings: { compaction: { enabled: false } } as never },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
    harness.resume();
    for (let index = 0; index < 200; index += 1) {
      faux.setResponses([fauxAssistantMessage(`答 ${index}`)]);
      const submission = await root.submit(
        {
          type: "input",
          content: `问 ${index}`,
          requestId: `r_perf_${String(index).padStart(4, "0")}`,
          whenBusy: "followUp",
        },
        BACKGROUND_CONTEXT,
      );
      // `wait` resolves at settlement; reading `status` only samples it.
      await submission.wait(BACKGROUND_CONTEXT);
    }
    await harness.close(BACKGROUND_CONTEXT);
    const reopen = await bench(async () => {
      const again = await Harness.open(
        await openNodeSqliteStorage(path),
        {
          models,
          registry: createRegistry(),
          settings: { compaction: { enabled: false } } as never,
        },
        BACKGROUND_CONTEXT,
      );
      await again.root(BACKGROUND_CONTEXT, { agent: { model } });
      await again.close(BACKGROUND_CONTEXT);
    });
    // The load is the one the bound names: 400 entries, read back through the adapter.
    const load = await (async () => {
      const runtime = new PiDurableRuntime({ models, log: captureLog().log });
      const handle = await runtime.open({
        id: "b_perf",
        dir: join(dir, "busy-bot"),
        model,
        trace: "tr_perf_1",
      });
      const page = await handle.history({ limit: 1_000 });
      await handle.close("tr_perf_2", 5_000);
      return page.messages.length;
    })();
    assert.ok(load >= 400, `the reopen measured a bot with ${load} messages, not 400 entries`);
    report("reopen a bot with 400 entries", reopen, 100);

    const turn = await bench(async () => {
      const one = await Harness.open(
        await openNodeSqliteStorage(join(dir, `turn-${Math.random()}.sqlite`)),
        {
          models,
          registry: createRegistry(),
          settings: { compaction: { enabled: false } } as never,
        },
        BACKGROUND_CONTEXT,
      );
      const oneRoot = await one.root(BACKGROUND_CONTEXT, { agent: { model } });
      one.resume();
      faux.setResponses([fauxAssistantMessage("好的")]);
      const submission = await oneRoot.submit(
        {
          type: "input",
          content: "问",
          requestId: `r_turn_${Math.random()}`,
          whenBusy: "followUp",
        },
        BACKGROUND_CONTEXT,
      );
      // The measurement is an *answered* turn: wait for the settlement.
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, "done");
      await one.close(BACKGROUND_CONTEXT);
    });
    report("one answered turn (faux provider)", turn, 200);

    const many = await bench(async () => {
      const harnesses = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const handle = await Harness.open(
            await openNodeSqliteStorage(join(dir, `many-${index}.sqlite`)),
            {
              models,
              registry: createRegistry(),
              settings: { compaction: { enabled: false } } as never,
            },
            BACKGROUND_CONTEXT,
          );
          await handle.root(BACKGROUND_CONTEXT, { agent: { model } });
          return handle;
        }),
      );
      await Promise.all(harnesses.map((handle) => handle.close(BACKGROUND_CONTEXT)));
    });
    report("20 bots open in one process", many, 1_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
