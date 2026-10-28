// Subagents (docs/bots/RUNTIME.md, "Subagents"): a bot starts a child conversation, gives
// it work, and reads its answer back, over the real adapter and real sqlite.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

const runWithTools = async (handle: {
  subscribe: (t: string, s: (e: RuntimeEvent) => void) => Promise<unknown>;
  submit: (i: {
    requestId: string;
    text: string;
    whenBusy: "followUp";
    trace: string;
  }) => Promise<unknown>;
}) => {
  const events: RuntimeEvent[] = [];
  await handle.subscribe(trace, (event) => events.push(event));
  await handle.submit({
    requestId: "r_subagent_1",
    text: "委派给子 agent",
    whenBusy: "followUp",
    trace,
  });
  await waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "the run to settle",
    10_000,
  );
  return events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .flatMap((block) => (block.type === "toolResult" ? [block] : []));
};

test("a child agent runs the delegated turn and its answer comes back", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([
      // 1. the parent asks to start a child
      assistant([toolCall("agent_spawn", { name: "计数" })], { stopReason: "toolUse" }),
      // 2. the parent hands it work
      (context: { messages: readonly { content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        const id = /as c_(\d+)/.exec(seen)?.[1];
        assert.ok(id, "the spawn result names the child id");
        return assistant([toolCall("agent_send", { agentId: `c_${id}`, message: "回复 READY" })], {
          stopReason: "toolUse",
        });
      },
      // 3. the child answers
      assistant("READY"),
      // 4. the parent closes the turn
      assistant("子 agent 已完成"),
    ]);
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "agents"] });
    const results = await runWithTools(handle);
    const spawn = results.find((block) => block.name === "agent_spawn");
    assert.ok(spawn, `the spawn call ran (${results.map((block) => block.name).join(",")})`);
    assert.match(spawn.text, /c_\d+/);
    const send = results.find((block) => block.name === "agent_send");
    assert.ok(send, "the send call ran");
    assert.equal(send.isError, false, `the child answered (${send.text})`);
    assert.match(send.text, /READY/);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
