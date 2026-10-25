// The acceptance test for tool rows: a run whose model calls a workspace tool must show
// the call and its result live on the socket, and a late subscriber must see the same
// rows in its snapshot (docs/bots/PROTOCOL.md, "Tool rows"; RUNTIME.md, "Tools").
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { assistant, text, toolCall } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("a tool round is live in the transcript and in a later snapshot", async () => {
  const stack = await startStack({ real: true });
  try {
    const faux = stack.faux;
    assert.ok(faux !== undefined, "a real stack scripts the model network");
    faux.setResponses([
      assistant([toolCall("list_files", { path: "." })], { stopReason: "toolUse" }),
      text("工作区里没有别的文件。"),
    ]);
    const botId = await stack.createBot("工具行");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("sub1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_tools_0001",
      text: "列出文件",
      whenBusy: "followUp",
      trace: tr("send1"),
    });

    const appends: Message[] = [];
    for (;;) {
      const frame = await frames.next(20_000);
      if (frame.type === "append") appends.push(frame.message as Message);
      if (frame.type === "submission" && frame.requestId === "r_tools_0001") {
        if (frame.status === "done" || frame.status === "unanswered") break;
      }
    }

    const call = appends.find((message) =>
      message.blocks.some((block) => block.type === "toolCall"),
    );
    assert.equal(call?.role, "assistant", "the call rides in the assistant entry");
    const callBlock = call?.blocks.find((block) => block.type === "toolCall");
    assert.equal(callBlock?.type === "toolCall" ? callBlock.name : "", "list_files");

    const result = appends.find((message) => message.role === "tool");
    assert.ok(result !== undefined, "the tool result is appended as its own row");
    const resultBlock = result.blocks[0];
    assert.equal(resultBlock?.type, "toolResult");
    assert.equal(resultBlock?.type === "toolResult" ? resultBlock.name : "", "list_files");
    assert.equal(resultBlock?.type === "toolResult" ? resultBlock.isError : true, false);
    assert.match(
      resultBlock?.type === "toolResult" ? resultBlock.text : "",
      /\(the workspace is empty\)/,
    );

    // A late join after the run: the snapshot carries the same rows, in order.
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("sub2") });
    const snapshot = await renewed.next();
    const messages = (snapshot.value as { messages: Message[] }).messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.deepEqual(
      messages.find((message) => message.role === "tool")?.blocks,
      result.blocks,
      "the snapshot's tool row is byte-identical to the live one",
    );
    again.close();
    socket.close();
  } finally {
    await stack.close();
  }
});
