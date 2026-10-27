// Deferred tools (docs/bots/RUNTIME.md, "Tools"): the terminal tools are not offered until
// the model asks for them, and tool_search is what makes them callable.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

test("a terminal tool runs only after tool_search loads it", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([
      assistant([toolCall("tool_search", { query: "herdr" })], { stopReason: "toolUse" }),
      assistant([toolCall("herdr_list", {})], { stopReason: "toolUse" }),
      assistant("done"),
    ]);
    const handle = await bench.runtime.open({
      ...bench.spec(),
      toolGroups: ["core", "herdr"],
    });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await handle.submit({
      requestId: "r_deferred_1",
      text: "列一下 herdr",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
    const results = events
      .filter((event) => event.type === "append")
      .flatMap((event) => event.message.blocks)
      .flatMap((block) => (block.type === "toolResult" ? [block] : []));
    const search = results.find((block) => block.name === "tool_search");
    assert.ok(search, `tool_search ran (${results.map((block) => block.name).join(",")})`);
    assert.equal(search.isError, false, search.text);
    const listed = results.find((block) => block.name === "herdr_list");
    assert.ok(listed, "the loaded tool became callable");
    assert.match(listed.text, /no herdr space is open/);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
