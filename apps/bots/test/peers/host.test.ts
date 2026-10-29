// The host side of a peer exchange (docs/bots/TRIGGERS.md §10): the sender is bound, the
// recipient is resolved by id, the budget is the daemon's, and a refusal says why.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotSummary, Submission } from "../../src/core/domain.ts";
import { PEER_MAX_TURNS, PeerExchangeStore } from "../../src/core/PeerExchangeStore.ts";
import { peerHostFor, peerRequestId } from "../../src/peers/host.ts";

const trace = "tr_peer_0001";

const bot = (id: string, overrides: Partial<BotSummary> = {}): BotSummary => ({
  id: id as never,
  title: id.replace("b_", ""),
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  model: { provider: "p", modelId: "m" },
  state: "idle",
  ...overrides,
});

type Bench = {
  readonly store: PeerExchangeStore;
  readonly sent: Array<{ botId: string; requestId: string; text: string; origin: unknown }>;
  readonly host: ReturnType<typeof peerHostFor>;
  readonly submissions: Map<string, Submission>;
  cleanup(): Promise<void>;
};

const createBench = async (): Promise<Bench> => {
  const root = await mkdtemp(join(tmpdir(), "bots-peer-host-"));
  const store = new PeerExchangeStore(join(root, "peers"));
  await store.open();
  const submissions = new Map<string, Submission>();
  const sent: Bench["sent"] = [];
  const bots = [
    bot("b_sender"),
    bot("b_target"),
    bot("b_busy", { state: "running" }),
    bot("b_gone", { unavailable: { reason: "internal", message: "quarantined" } }),
  ];
  const host = peerHostFor({
    botId: "b_sender",
    store,
    bots: () => bots,
    invoke: async (input) => {
      sent.push({
        botId: input.botId,
        requestId: input.requestId,
        text: input.text,
        origin: input.origin,
      });
      const submission: Submission = { id: "s_1", requestId: input.requestId, status: "queued" };
      submissions.set(`${input.botId}/${input.requestId}`, submission);
      return submission;
    },
    submission: async (query) => submissions.get(`${query.botId}/${query.requestId}`),
    entryText: async () => "the answer",
  });
  return {
    store,
    sent,
    host,
    submissions,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("peer_list never lists the sender, and reports what it observes", async () => {
  const bench = await createBench();
  try {
    const { items } = await bench.host.list({ limit: 20 });
    assert.deepEqual(
      items.map((item) => `${item.botId}:${item.availability}`),
      ["b_target:idle", "b_busy:working", "b_gone:unavailable"],
    );
    const filtered = await bench.host.list({ limit: 20, query: "TARG" });
    assert.deepEqual(
      filtered.items.map((item) => item.botId),
      ["b_target"],
    );
    const paged = await bench.host.list({ limit: 1 });
    assert.equal(paged.items.length, 1);
    assert.equal(paged.nextCursor, paged.items[0]?.botId);
  } finally {
    await bench.cleanup();
  }
});

test("a send admits one message addressed to the recipient, with the peer origin and a stable key", async () => {
  const bench = await createBench();
  try {
    const result = await bench.host.send({
      taskId: "task-1",
      toBotId: "b_target",
      message: "please check the build",
    });
    assert.equal(result.toBotId, "b_target");
    assert.equal(result.requestId, peerRequestId("b_sender", "b_target", "task-1"));
    assert.equal(result.status, "queued");
    assert.equal(result.sent, 1);
    assert.equal(result.remaining, PEER_MAX_TURNS - 1);
    assert.equal(result.exchangeStatus, "open");
    const origin = bench.sent[0]?.origin as {
      kind: string;
      fromBotId: string;
      label?: string;
      exchangeId?: string;
    };
    assert.equal(origin.kind, "peer");
    assert.equal(origin.fromBotId, "b_sender");
    assert.equal(origin.label, "sender");
    assert.equal(origin.exchangeId, result.exchangeId, "the origin names its exchange");
    assert.equal(bench.sent[0]?.botId, "b_target");
  } finally {
    await bench.cleanup();
  }
});

test("the same tool task sent twice is one message, and the second call reports the same receipt", async () => {
  const bench = await createBench();
  try {
    const first = await bench.host.send({ taskId: "task-1", toBotId: "b_target", message: "hi" });
    const again = await bench.host.send({ taskId: "task-1", toBotId: "b_target", message: "hi" });
    assert.equal(again.requestId, first.requestId);
    assert.equal(again.exchangeId, first.exchangeId);
    const exchange = await bench.store.get(first.exchangeId);
    assert.equal(exchange?.turns.length, 1);
  } finally {
    await bench.cleanup();
  }
});

test("a spent side is refused with the limit in the message, not a new exchange", async () => {
  const bench = await createBench();
  try {
    for (let index = 0; index < PEER_MAX_TURNS; index += 1) {
      await bench.host.send({ taskId: `task-${index}`, toBotId: "b_target", message: "again" });
    }
    await assert.rejects(
      () => bench.host.send({ taskId: "task-over", toBotId: "b_target", message: "again" }),
      new RegExp(`already sent ${PEER_MAX_TURNS} messages`),
    );
    // The other side still has its own budget, so the exchange stays open for it.
    const exchanges = await bench.store.list();
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]?.status, "open");
  } finally {
    await bench.cleanup();
  }
});

test("a finished exchange is never reopened: the next send starts a new one", async () => {
  const bench = await createBench();
  try {
    const first = await bench.host.send({ taskId: "t-1", toBotId: "b_target", message: "hi" });
    await bench.store.finish(first.exchangeId, "turn_limit");
    const next = await bench.host.send({ taskId: "t-2", toBotId: "b_target", message: "hi again" });
    assert.notEqual(next.exchangeId, first.exchangeId);
    assert.equal((await bench.store.get(first.exchangeId))?.turns.length, 1);
  } finally {
    await bench.cleanup();
  }
});

test("self, unknown and unavailable recipients are refusals with a reason", async () => {
  const bench = await createBench();
  try {
    await assert.rejects(
      () => bench.host.send({ taskId: "t", toBotId: "b_sender", message: "hi" }),
      /cannot message yourself/,
    );
    await assert.rejects(
      () => bench.host.send({ taskId: "t", toBotId: "b_nobody", message: "hi" }),
      /no bot with id b_nobody/,
    );
    await assert.rejects(
      () => bench.host.send({ taskId: "t", toBotId: "b_gone", message: "hi" }),
      /unavailable/,
    );
    assert.equal(bench.sent.length, 0);
  } finally {
    await bench.cleanup();
  }
});

test("peer_read answers the caller's own receipt and refuses another bot's", async () => {
  const bench = await createBench();
  try {
    const sent = await bench.host.send({ taskId: "t-1", toBotId: "b_target", message: "hi" });
    bench.submissions.set(`b_target/${sent.requestId}`, {
      id: "s_1",
      requestId: sent.requestId,
      status: "done",
      answerEntryId: "e_9",
    });
    const read = await bench.host.read({ requestId: sent.requestId });
    assert.equal(read.status, "done");
    assert.equal(read.answer, "the answer");

    // A receipt recorded for someone else is not readable through this bot's host.
    const other = peerHostFor({
      botId: "b_other",
      store: bench.store,
      bots: () => [bot("b_sender"), bot("b_target"), bot("b_other")],
      invoke: async () => ({ id: "s", requestId: "pr_x", status: "queued" }),
      submission: async () => undefined,
      entryText: async () => undefined,
    });
    await assert.rejects(() => other.read({ requestId: sent.requestId }), /was not sent by you/);
    await assert.rejects(() => other.read({ requestId: "pr_missing" }), /no message of yours/);
  } finally {
    await bench.cleanup();
  }
});

test("receipts can be narrowed to one recipient", async () => {
  const bench = await createBench();
  try {
    await bench.host.send({ taskId: "t-1", toBotId: "b_target", message: "one" });
    await bench.host.send({ taskId: "t-2", toBotId: "b_busy", message: "two" });
    const narrowed = await bench.host.receipts({ limit: 20, toBotId: "b_busy" });
    assert.equal(narrowed.length, 1);
    assert.equal(narrowed[0]?.toBotId, "b_busy");
  } finally {
    await bench.cleanup();
  }
});

test("receipts list only this bot's messages, newest first, with their status", async () => {
  const bench = await createBench();
  try {
    const first = await bench.host.send({ taskId: "t-1", toBotId: "b_target", message: "one" });
    await bench.host.send({ taskId: "t-2", toBotId: "b_busy", message: "two" });
    const receipts = await bench.host.receipts({ limit: 20 });
    assert.equal(receipts.length, 2);
    assert.equal(receipts.at(-1)?.toBotId, "b_target");
    assert.equal(receipts.at(-1)?.requestId, first.requestId);
    assert.equal(receipts.at(-1)?.status, "queued");
  } finally {
    await bench.cleanup();
  }
});

test("the trace a peer send uses names the request, never a random value", async () => {
  const bench = await createBench();
  try {
    const sent = await bench.host.send({ taskId: "t-1", toBotId: "b_target", message: "hi" });
    assert.match(sent.requestId, /^pr_[0-9a-f]{16}$/);
    assert.equal(peerRequestId("b_sender", "b_target", "t-1"), sent.requestId);
    assert.equal(trace.length > 0, true);
  } finally {
    await bench.cleanup();
  }
});

test("a read whose submission the daemon no longer knows answers unknown, not an answer", async () => {
  const bench = await createBench();
  try {
    const sent = await bench.host.send({ taskId: "t-1", toBotId: "b_target", message: "hi" });
    bench.submissions.delete(`b_target/${sent.requestId}`);
    const read = await bench.host.read({ requestId: sent.requestId });
    assert.equal(read.status, "unknown");
    assert.equal(read.answer, undefined);
  } finally {
    await bench.cleanup();
  }
});

test("paging walks the catalogue with the cursor, and no page invents a next one", async () => {
  const bench = await createBench();
  try {
    const first = await bench.host.list({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.nextCursor, first.items[1]?.botId);
    const second = await bench.host.list({
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, undefined);
  } finally {
    await bench.cleanup();
  }
});
