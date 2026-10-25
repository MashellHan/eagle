// Ladder row 53 context: one bot's broken storage makes that bot unavailable and leaves
// every other bot working (docs/bots/TESTING.md, "Fault injection").
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("a bot whose session file is junk is unavailable while another bot answers", async () => {
  const stack = await startStack({
    real: true,
    prepare: async ({ directory }) => {
      const at = "2026-01-01T00:00:00.000Z";
      for (const [id, title] of [
        ["b_junk", "坏的"],
        ["b_healthy", "好的"],
      ] as const) {
        await directory.create({
          id,
          title,
          createdAt: at,
          updatedAt: at,
          model: { provider: "faux", modelId: "faux-1" },
        });
      }
      // A file that is not a database at all, in front of the real Harness.
      await mkdir(directory.botDir("b_junk"), { recursive: true });
      await writeFile(join(directory.botDir("b_junk"), "session.sqlite"), "not sqlite");
    },
  });
  try {
    stack.faux?.setResponses([text("好的回答")]);
    const broken = stack.connect();
    const brokenFrames = frameQueue(broken);
    await send(broken, hello);
    await brokenFrames.next();
    await send(broken, { type: "subscribe", botId: "b_junk", trace: tr("junk1") });
    const unavailable = await brokenFrames.next();
    assert.equal(unavailable.type, "snapshot");
    assert.equal(
      (unavailable.value as { unavailable?: { reason: string } }).unavailable?.reason,
      "storage_failed",
      "the broken bot renders a reason instead of failing the connection",
    );

    const healthy = stack.connect();
    const healthyFrames = frameQueue(healthy);
    await send(healthy, hello);
    await healthyFrames.next();
    await send(healthy, { type: "subscribe", botId: "b_healthy", trace: tr("junk2") });
    await healthyFrames.next();
    await send(healthy, {
      type: "send",
      requestId: "r_junk_00001",
      text: "你好",
      whenBusy: "followUp",
      trace: tr("junk3"),
    });
    for (;;) {
      const frame = await healthyFrames.next(10_000);
      if (frame.type === "submission" && frame.status === "done") break;
    }
    await send(healthy, { type: "resync", trace: tr("junk4") });
    for (;;) {
      const frame = await healthyFrames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const messages = (frame.value as { messages: Message[] }).messages;
      assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant"],
        "the other bot completes its conversation",
      );
      break;
    }
    healthy.close();
    broken.close();
  } finally {
    await stack.close();
  }
});

test("recover re-opens a bot that was unavailable and the next turn works", async () => {
  const stack = await startStack({
    real: true,
    prepare: async ({ directory }) => {
      const at = "2026-01-01T00:00:00.000Z";
      await directory.create({
        id: "b_repair",
        title: "可修复",
        createdAt: at,
        updatedAt: at,
        model: { provider: "faux", modelId: "faux-1" },
      });
      await writeFile(join(directory.botDir("b_repair"), "session.sqlite"), "not sqlite");
    },
  });
  try {
    stack.faux?.setResponses([text("修复之后能回答")]);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId: "b_repair", trace: tr("repair1") });
    const unavailable = await frames.next();
    assert.equal(
      (unavailable.value as { unavailable?: { reason: string } }).unavailable?.reason,
      "storage_failed",
    );

    // The user fixes the file (here: removes the junk so the Harness can create it) and
    // asks the daemon to recover, which is the only thing that re-opens it.
    await rm(join(stack.root, "bots", "b_repair", "session.sqlite"), { force: true });
    await send(socket, { type: "recover", trace: tr("repair2") });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      assert.equal(
        (frame.value as { unavailable?: unknown }).unavailable,
        undefined,
        "recover opened the bot again",
      );
      break;
    }
    await send(socket, {
      type: "send",
      requestId: "r_repair_0001",
      text: "还活着吗",
      whenBusy: "followUp",
      trace: tr("repair3"),
    });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "submission" && frame.status === "done") break;
    }
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a bot created at the summary budget still fits the catalog when it fails", async () => {
  // Every value below is inside its character cap; together they are at the encoded edge.
  const stack = await startStack({
    real: true,
    model: { provider: "p".repeat(40), modelId: "m".repeat(20) },
    prepare: async ({ directory }) => {
      await directory.create({
        id: "b_edge",
        title: "题".repeat(80),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        model: { provider: "p".repeat(40), modelId: "m".repeat(20) },
      });
      await mkdir(directory.botDir("b_edge"), { recursive: true });
      await writeFile(join(directory.botDir("b_edge"), "session.sqlite"), "not sqlite");
    },
  });
  try {
    const summaries = stack.registry.summaries();
    assert.equal(summaries.length, 1);
    const unavailable = summaries[0]?.unavailable;
    assert.ok(unavailable !== undefined, "the open failed, so the summary carries the reason");
    const encoded = Buffer.byteLength(JSON.stringify(summaries[0]));
    assert.ok(encoded <= 1_200, `the failing summary fits the bound (${encoded} bytes)`);

    // A new connection still receives its welcome with that summary in the catalog.
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    const welcome = await frames.next();
    assert.equal(welcome.type, "welcome");
    assert.equal((welcome.bots as { id: string }[])[0]?.id, "b_edge");
    socket.close();
  } finally {
    await stack.close();
  }
});
