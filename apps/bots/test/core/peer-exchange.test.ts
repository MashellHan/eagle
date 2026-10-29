// The exchange record (docs/bots/TRIGGERS.md §10): durability, the request-keyed receipt and the
// turn budget that stops two bots from talking forever.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PEER_MAX_TURNS, PeerExchangeStore } from "../../src/core/PeerExchangeStore.ts";

const withStore = async (run: (store: PeerExchangeStore) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bots-peers-"));
  try {
    const store = new PeerExchangeStore(join(root, "peers"));
    await store.open();
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

let counter = 0;
const nextRequestId = (): string => {
  counter += 1;
  return `pr_${counter.toString(16).padStart(16, "0")}`;
};

const turn = (
  from: string,
  to: string,
  requestId = nextRequestId(),
): { fromBotId: string; toBotId: string; requestId: string; message: string } => ({
  fromBotId: from,
  toBotId: to,
  requestId,
  message: `message ${requestId}`,
});

test("an exchange is found again between the same two bots, in either direction", async () => {
  await withStore(async (store) => {
    const created = await store.create(["b_a", "b_b"]);
    assert.equal((await store.between("b_a", "b_b"))?.id, created.id);
    assert.equal((await store.between("b_b", "b_a"))?.id, created.id);
    assert.equal(await store.between("b_a", "b_c"), undefined);
  });
});

test("the open exchange between a pair is the only one a send continues", async () => {
  await withStore(async (store) => {
    const first = await store.create(["b_a", "b_b"]);
    await store.append(first.id, turn("b_a", "b_b"));
    await store.finish(first.id, "closed");
    const second = await store.create(["b_a", "b_b"]);
    assert.equal((await store.between("b_a", "b_b"))?.id, second.id);
  });
});

test("a retried send is recognised by its request key and never appended twice", async () => {
  await withStore(async (store) => {
    const exchange = await store.create(["b_a", "b_b"]);
    const one = turn("b_a", "b_b", "pr_0123456789abcdef");
    const first = await store.append(exchange.id, one);
    const again = await store.append(exchange.id, one);
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.exchange.turns.length, 1);
    assert.equal((await store.byRequest(one.requestId))?.turn.requestId, one.requestId);
  });
});

test("the exchange closes only when both bots have spent the whole budget", async () => {
  await withStore(async (store) => {
    const exchange = await store.create(["b_a", "b_b"]);
    for (let index = 0; index < PEER_MAX_TURNS; index += 1) {
      const appended = await store.append(exchange.id, turn("b_a", "b_b"));
      // One side alone never closes it: the other side can still answer.
      assert.equal(appended.exchange.status, "open");
    }
    const halfway = await store.get(exchange.id);
    assert.ok(halfway !== undefined);
    assert.equal(PeerExchangeStore.countIn(halfway, "b_a"), PEER_MAX_TURNS);
    for (let index = 0; index < PEER_MAX_TURNS - 1; index += 1) {
      await store.append(exchange.id, turn("b_b", "b_a"));
    }
    const last = await store.append(exchange.id, turn("b_b", "b_a"));
    assert.equal(last.exchange.status, "finished");
    assert.equal(last.exchange.finishedReason, "turn_limit");
  });
});

test("receipts belong to the bot that sent them, newest first", async () => {
  await withStore(async (store) => {
    const first = await store.create(["b_a", "b_b"]);
    await store.append(first.id, turn("b_a", "b_b"));
    const second = await store.create(["b_a", "b_c"]);
    await store.append(second.id, turn("b_a", "b_c"));
    await store.append(second.id, turn("b_c", "b_a"));

    const receipts = await store.receipts("b_a", 10);
    assert.equal(receipts.length, 2);
    assert.deepEqual(
      receipts.map((item) => item.turn.toBotId),
      ["b_c", "b_b"],
    );
    assert.equal((await store.receipts("b_b", 10)).length, 0);
    assert.equal((await store.receipts("b_a", 1)).length, 1);
  });
});

test("a record survives a reopen of the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-peers-"));
  try {
    const store = new PeerExchangeStore(join(root, "peers"));
    await store.open();
    const exchange = await store.create(["b_a", "b_b"]);
    await store.append(exchange.id, turn("b_a", "b_b"));

    const reopened = new PeerExchangeStore(join(root, "peers"));
    const found = await reopened.get(exchange.id);
    assert.equal(found?.turns.length, 1);
    assert.equal(found?.participants.join(","), "b_a,b_b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn keeps the message it carried, and the first answer is the one kept", async () => {
  await withStore(async (store) => {
    const exchange = await store.create(["b_a", "b_b"]);
    const sent = turn("b_a", "b_b", "pr_aaaabbbbccccdddd");
    await store.append(exchange.id, sent);
    const answered = await store.answer(exchange.id, sent.requestId, "第一份回答");
    assert.equal(answered?.turns[0]?.message, `message ${sent.requestId}`);
    assert.equal(answered?.turns[0]?.answer, "第一份回答");
    const again = await store.answer(exchange.id, sent.requestId, "第二份回答");
    assert.equal(again?.turns[0]?.answer, "第一份回答", "the first answer wins");
    const missing = await store.answer(exchange.id, "pr_missing00000000", "x");
    assert.equal(missing?.turns[0]?.answer, "第一份回答", "an unknown request changes nothing");
  });
});
