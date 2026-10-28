// Live work per bot (docs/bots/PROTOCOL.md, "tasks"): the inspector's 任务 section reads the
// same task graph the scheduler runs, pushed as its own event.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, requestId, trace, waitFor } from "../support/pi.ts";

test("a run reports its generation task and clears the graph afterwards", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([assistant("完成")]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    const subscription = await handle.subscribe(trace, (event) => events.push(event));
    assert.ok(
      Array.isArray(subscription.snapshot.tasks),
      "the baseline snapshot carries the task list",
    );
    assert.deepEqual(subscription.snapshot.tasks, [], "nothing runs before the first send");

    await handle.submit({ requestId, text: "你好", whenBusy: "followUp", trace });
    await waitFor(
      () => events.some((event) => event.type === "tasks" && event.tasks.length > 0),
      "a tasks event naming live work",
    );
    const during = events
      .filter((event): event is Extract<RuntimeEvent, { type: "tasks" }> => event.type === "tasks")
      .flatMap((event) => event.tasks);
    assert.ok(
      during.some((task) => task.kind === "pi.generation"),
      `the generation is visible (${during.map((task) => task.kind).join(",")})`,
    );
    const generation = during.find((task) => task.kind === "pi.generation");
    assert.ok(generation?.id.startsWith("t_"), "task ids are wire ids");
    assert.ok(generation?.conversationId.startsWith("c_"), "and name their conversation");

    await waitFor(
      async () => (await handle.submission({ requestId }))?.status === "done",
      "the run to settle",
    );
    await waitFor(() => {
      const latest = events.filter((event) => event.type === "tasks").at(-1);
      return latest !== undefined && latest.type === "tasks" && latest.tasks.length === 0;
    }, "the graph to empty");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
