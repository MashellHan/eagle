// Ladder rows 52b, 52e and 52f: the client's outbox duties, proven from the daemon side —
// only `not_admitted` clears an entry, `unknown` keeps the requestId, and a re-send after a
// restart is answered by the stored record (docs/bots/PROTOCOL.md, "Client duties").
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("a send persisted before a restart is reconciled by re-sending its requestId", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-restart-"));
  const first = await startStack({ real: true, root });
  let botId: string;
  try {
    first.faux?.setResponses([text("重启之前的回答")]);
    botId = await first.createBot("停机");
    const socket = first.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("restart1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_restart_0001",
      text: "重启前的问题",
      whenBusy: "followUp",
      trace: tr("restart2"),
    });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "submission" && frame.status === "done") break;
    }
    socket.close();
  } finally {
    // The outbox entry is still on the client: its reply was lost with the daemon.
    await first.close();
  }

  const second = await startStack({ real: true, root });
  try {
    const socket = second.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("restart3") });
    const baseline = await frames.next();
    assert.equal(baseline.type, "snapshot");
    await send(socket, {
      type: "send",
      requestId: "r_restart_0001",
      text: "重启前的问题",
      whenBusy: "followUp",
      trace: tr("restart4"),
    });
    const reply = await (async () => {
      for (;;) {
        const frame = await frames.next(10_000);
        if (frame.type === "submission") return frame;
      }
    })();
    assert.equal(reply.requestId, "r_restart_0001");
    assert.equal(reply.status, "done", "the stored record answers the reconciled re-send");
    await send(socket, { type: "resync", trace: tr("restart5") });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const messages = (frame.value as { messages: { id: string; role: string }[] }).messages;
      assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant"],
        "one question, one answer: the restart duplicated nothing",
      );
      break;
    }
    socket.close();
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an admitted input whose record read failed is reconciled by the same requestId", async () => {
  const admitted = new Map<string, { id: string; requestId: string; status: "queued" }>();
  let failOnce = true;
  const runtime = {
    async open(): Promise<RuntimeHandle> {
      return {
        subscribe: async () => ({
          snapshot: {
            botId: "b_52f",
            messages: [],
            pending: [],
            inbox: [],
            running: false,
            streaming: null,
          },
          detach: () => undefined,
        }),
        submission: async (key) => ("requestId" in key ? admitted.get(key.requestId) : undefined),
        submit: async (input) => {
          // Admission succeeded; reading its record did not. The daemon cannot know
          // whether it was placed, so the client keeps the entry (PROTOCOL.md 52f).
          admitted.set(input.requestId, {
            id: `s_${input.requestId}`,
            requestId: input.requestId,
            status: "queued",
          });
          if (failOnce) {
            failOnce = false;
            throw new Error("the record read failed");
          }
          return admitted.get(input.requestId) as {
            id: string;
            requestId: string;
            status: "queued";
          };
        },
        history: async () => ({ messages: [], hasMore: false }),
        abort: async () => undefined,
        recover: async () => undefined,
        busy: async () => ({ run: false, tasks: false }),
        close: async () => "closed" as const,
      };
    },
  };
  const stack = await startStack({ runtime });
  try {
    const botId = await stack.createBot("未确认");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("unconf1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_unconf_0001",
      text: "无确认的问题",
      whenBusy: "followUp",
      trace: tr("unconf2"),
    });
    const lost = await frames.next();
    assert.equal(lost.type, "error");
    assert.equal(lost.disposition, "unknown", "the outbox entry survives");
    assert.equal(lost.requestId, "r_unconf_0001");

    await send(socket, {
      type: "send",
      requestId: "r_unconf_0001",
      text: "无确认的问题",
      whenBusy: "followUp",
      trace: tr("unconf3"),
    });
    const reconciled = await frames.next();
    assert.equal(reconciled.type, "submission", "the retry reads the stored record");
    assert.equal(reconciled.requestId, "r_unconf_0001");
    assert.equal(admitted.size, 1, "no second admission for the same requestId");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a not_admitted rejection restores the draft and an unknown result keeps the requestId", async () => {
  let rejectOnce = true;
  const runtime = {
    async open(): Promise<RuntimeHandle> {
      let sink: ((event: RuntimeEvent) => void) | undefined;
      return {
        subscribe: async () => ({
          snapshot: {
            botId: "b_outbox",
            messages: [],
            pending: [],
            inbox: [],
            running: false,
            streaming: null,
          },
          detach: () => {
            sink = undefined;
          },
        }),
        submission: async () => undefined,
        submit: async (input) => {
          if (rejectOnce) {
            rejectOnce = false;
            // The admission write failed in a way the daemon cannot classify: the client
            // must keep the entry and retry with the same requestId.
            throw new Error("the session went away while admitting");
          }
          sink?.({
            type: "status",
            trace: input.trace,
            running: false,
            streaming: null,
            inbox: [],
          });
          return {
            id: `s_${input.requestId}`,
            requestId: input.requestId,
            status: "queued" as const,
          };
        },
        history: async () => ({ messages: [], hasMore: false }),
        abort: async () => undefined,
        recover: async () => undefined,
        busy: async () => ({ run: false, tasks: false }),
        close: async () => "closed" as const,
      };
    },
  };
  const stack = await startStack({ runtime });
  try {
    const botId = await stack.createBot("发件箱");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("outbox1") });
    await frames.next();

    // not_admitted: the daemon refused before admission, so the draft comes back.
    await send(socket, {
      type: "send",
      requestId: "r_outbox_0001",
      text: "x".repeat(8_001),
      whenBusy: "followUp",
      trace: tr("outbox2"),
    });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.disposition, "not_admitted");
    assert.equal(refused.requestId, "r_outbox_0001");

    // unknown: admission could not be confirmed, so the entry survives.
    await send(socket, {
      type: "send",
      requestId: "r_outbox_0002",
      text: "重要的问题",
      whenBusy: "followUp",
      trace: tr("outbox3"),
    });
    const unconfirmed = await frames.next();
    assert.equal(unconfirmed.type, "error");
    assert.equal(unconfirmed.disposition, "unknown");
    assert.equal(unconfirmed.requestId, "r_outbox_0002");

    // The client retries that entry with the same requestId and is admitted once.
    await send(socket, {
      type: "send",
      requestId: "r_outbox_0002",
      text: "重要的问题",
      whenBusy: "followUp",
      trace: tr("outbox4"),
    });
    const admitted = await frames.next();
    assert.equal(admitted.type, "submission");
    assert.equal(admitted.requestId, "r_outbox_0002");
    assert.equal(admitted.status, "queued");
    socket.close();
  } finally {
    await stack.close();
  }
});
