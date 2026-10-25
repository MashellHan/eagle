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
    // The catalog has to leave `unavailable` for clients that already show it.
    const seen: string[] = [];
    const catalog = await (async () => {
      for (;;) {
        const frame = await frames.next(3_000).catch(() => undefined);
        if (frame === undefined) return undefined;
        seen.push(String(frame.type));
        if (frame.type === "bots") return frame;
      }
    })();
    assert.ok(catalog !== undefined, `no catalog frame after recover (saw ${seen.join(",")})`);
    assert.equal(
      (catalog.bots as { id: string; state: string }[])[0]?.state,
      "idle",
      "the recovered bot is announced as idle",
    );
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

test("a summary whose failed variant would not fit is refused with an origin record", async () => {
  // Each value is inside its character cap. The healthy summary fits 1 200 bytes and the
  // unavailable variant does not, so creation must be refused — otherwise a failure
  // later turns a legal bot into a catalog event the frame budget refuses.
  const model = { provider: "界".repeat(40), modelId: "界".repeat(200) };
  const stack = await startStack({ real: true, model });
  try {
    const before = stack.records.length;
    const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "问".repeat(80) }),
    });
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: { kind: string } }).error.kind,
      "limit_exceeded",
    );
    assert.deepEqual(stack.registry.summaries(), [], "nothing was written");
    const failure = stack.records.slice(before).filter((record) => record.level === "error");
    assert.equal(failure.length, 1, "the refusal is recorded, not silent");
    assert.equal(failure[0]?.evt, "core.catalog.write.fail");
    assert.equal(failure[0]?.err?.origin, true);
  } finally {
    await stack.close();
  }
});
