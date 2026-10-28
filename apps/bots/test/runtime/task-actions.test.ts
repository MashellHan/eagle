// Stopping one task (docs/bots/PROTOCOL.md, "Live tasks"): the inspector's 停止 acts on the
// task the panel names, not on the whole conversation.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { createBench, hanging, requestId, trace, waitFor } from "../support/pi.ts";

test("aborting the running generation settles its submission and leaves the task list empty", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([hanging()]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await handle.submit({ requestId, text: "慢慢想", whenBusy: "followUp", trace });
    await waitFor(
      () => events.some((event) => event.type === "tasks" && event.tasks.length > 0),
      "the generation to appear",
    );
    const generation = events
      .filter((event): event is Extract<RuntimeEvent, { type: "tasks" }> => event.type === "tasks")
      .flatMap((event) => event.tasks)
      .find((task) => task.kind === "pi.generation");
    assert.ok(generation, "the panel names the task it would stop");

    await handle.abortTask?.(generation.id, trace);
    await waitFor(async () => {
      const record = await handle.submission({ requestId });
      return record?.status === "unanswered";
    }, "the run to settle as unanswered");
    const record = await handle.submission({ requestId });
    assert.equal(record?.reason, "aborted");
    await waitFor(() => {
      const latest = events.filter((event) => event.type === "tasks").at(-1);
      return latest !== undefined && latest.type === "tasks" && latest.tasks.length === 0;
    }, "the task list to empty");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
