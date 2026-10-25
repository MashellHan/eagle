// Phase 2 slice 1: the four bot tools run inside the workspace without an approval gate,
// and their results reach the model (docs/bots/RUNTIME.md, "Tools").
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import {
  assistant,
  type Bench,
  createBench,
  requestId,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

const workspaceOf = (bench: { dir: string }) => join(bench.dir, "b_runtime", "workspace");

const settle = async (handle: RuntimeHandle, bench: Bench, responses: FauxResponseStep[]) => {
  bench.faux.setResponses(responses);
  const events: RuntimeEvent[] = [];
  await handle.subscribe(trace, (event) => events.push(event));
  const submitted = await handle.submit({
    requestId,
    text: "请用工具完成任务",
    whenBusy: "followUp",
    trace,
  });
  void submitted;
  await waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "the run to settle",
  );
  const final = events
    .filter((event) => event.type === "append")
    .map((event) => event.message)
    .filter((message) => message.role === "assistant" && message.state === "complete")
    .at(-1);
  return { events, final };
};

test("a read_file call runs and its result reaches the model", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "工作区里的内容\n", { mode: 0o600 });

    const { final } = await settle(handle, bench, [
      assistant([toolCall("read_file", { path: "notes.txt" })], { stopReason: "toolUse" }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("工作区里的内容") ? "saw the file" : "missing");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "saw the file");
  } finally {
    await bench.cleanup();
  }
});

test("a write_file call runs without approval and the file exists", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("write_file", { path: "notes/out.txt", content: "from the model" })], {
        stopReason: "toolUse",
      }),
      text("written"),
    ]);
    assert.equal(
      await readFile(join(workspaceOf(bench), "notes/out.txt"), "utf8"),
      "from the model",
    );
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "written");
  } finally {
    await bench.cleanup();
  }
});

test("a run_command call runs in the workspace and reports its exit", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("run_command", { command: "printf hi > ran.txt" })], {
        stopReason: "toolUse",
      }),
      text("ran"),
    ]);
    assert.equal(await readFile(join(workspaceOf(bench), "ran.txt"), "utf8"), "hi");
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "ran");
  } finally {
    await bench.cleanup();
  }
});

test("a tool refusal is a result the model can read, not a failed run", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("read_file", { path: "../../etc/hosts" })], {
        stopReason: "toolUse",
      }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("outside the workspace") ? "refused" : "leaked");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "refused");
  } finally {
    await bench.cleanup();
  }
});

test("a long command output keeps its exit line through the SDK", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("run_command", { command: "seq 1 3000" })], { stopReason: "toolUse" }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("[exit code 0]") ? "exit seen" : "exit lost");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "exit seen");
  } finally {
    await bench.cleanup();
  }
});

test("a full read page keeps its total note through the SDK", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "long.txt"),
      Array.from({ length: 2_500 }, (_, index) => `row ${index + 1}`).join("\n"),
    );
    const { final } = await settle(handle, bench, [
      assistant([toolCall("read_file", { path: "long.txt" })], { stopReason: "toolUse" }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("[lines 1-2000 of 2500]") ? "note seen" : "note lost");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "note seen");
  } finally {
    await bench.cleanup();
  }
});

test("a tool call and its result are live transcript rows and survive a late join", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "工作区里的内容\n", { mode: 0o600 });
    const { events } = await settle(handle, bench, [
      assistant([toolCall("read_file", { path: "notes.txt" })], { stopReason: "toolUse" }),
      text("看完了"),
    ]);
    const appends = events.filter((event) => event.type === "append");
    const call = appends.find((event) =>
      event.message.blocks.some((block) => block.type === "toolCall"),
    );
    assert.equal(call?.message.role, "assistant", "the call rides in the assistant entry");
    const tool = appends.find((event) => event.message.role === "tool");
    assert.ok(tool !== undefined, "the durable tool result is an append of its own");
    const block = tool.message.blocks[0];
    assert.equal(block?.type, "toolResult");
    assert.equal(block?.type === "toolResult" ? block.name : "", "read_file");
    assert.match(block?.type === "toolResult" ? block.text : "", /工作区里的内容/);
    assert.equal(block?.type === "toolResult" ? block.isError : true, false);

    // A late join sees the same rows from the subscription's baseline, in order.
    const { snapshot } = await handle.subscribe(trace, () => undefined);
    assert.deepEqual(
      snapshot.messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(snapshot.messages[2]?.blocks[0]?.type, "toolResult");
  } finally {
    await bench.cleanup();
  }
});
