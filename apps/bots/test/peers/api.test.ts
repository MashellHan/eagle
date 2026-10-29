// The app's read side of an exchange (docs/bots/TRIGGERS.md §10): owner-scoped, counted in the
// units a person sees, and the answer filled in from the recipient's own submission.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotSummary, Submission } from "../../src/core/domain.ts";
import { PeerExchangeStore } from "../../src/core/PeerExchangeStore.ts";
import { peerApi } from "../../src/peers/api.ts";

const bot = (id: string, title: string): BotSummary => ({
  id: id as never,
  title,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  model: { provider: "p", modelId: "m" },
  state: "idle",
});

const withStore = async (run: (store: PeerExchangeStore) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bots-peer-api-"));
  try {
    const store = new PeerExchangeStore(join(root, "peers"));
    await store.open();
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("the list counts question and answer pairs, and only this bot's exchanges", async () => {
  await withStore(async (store) => {
    const exchange = await store.create(["b_a", "b_b"]);
    await store.append(exchange.id, {
      fromBotId: "b_a",
      toBotId: "b_b",
      requestId: "pr_00000000000000aa",
      message: "问一句",
    });
    await store.answer(exchange.id, "pr_00000000000000aa", "答一句");
    const other = await store.create(["b_c", "b_d"]);
    await store.append(other.id, {
      fromBotId: "b_c",
      toBotId: "b_d",
      requestId: "pr_00000000000000bb",
      message: "别人的对话",
    });

    const api = peerApi({
      store,
      bots: () => [bot("b_a", "A"), bot("b_b", "B")],
      submission: async () => undefined,
      entryText: async () => undefined,
    });
    const list = await api.list("b_a");
    assert.equal(list.length, 1);
    assert.equal(list[0]?.count, 2, "one question and its answer");
    const first = list[0];
    assert.ok(first !== undefined);
    assert.deepEqual(
      (first.participants as Array<{ title: string }>).map((item) => item.title),
      ["A", "B"],
    );
  });
});

test("the detail fills an unanswered turn from the recipient's run, and keeps it", async () => {
  await withStore(async (store) => {
    const exchange = await store.create(["b_a", "b_b"]);
    await store.append(exchange.id, {
      fromBotId: "b_a",
      toBotId: "b_b",
      requestId: "pr_00000000000000aa",
      message: "问一句",
    });
    let reads = 0;
    const api = peerApi({
      store,
      bots: () => [bot("b_a", "A"), bot("b_b", "B"), bot("b_c", "C")],
      submission: async (query) =>
        query.botId === "b_b" && query.requestId === "pr_00000000000000aa"
          ? ({
              id: "s_1",
              requestId: query.requestId,
              status: "done",
              answerEntryId: "e_9",
            } as Submission)
          : undefined,
      entryText: async (botId, entryId) => {
        reads += 1;
        assert.equal(botId, "b_b");
        assert.equal(entryId, "e_9");
        return "答一句";
      },
    });

    const detail = await api.detail("b_a", exchange.id);
    assert.ok(detail !== undefined);
    const turns = detail.turns as Array<{ answer?: string }>;
    assert.equal(turns[0]?.answer, "答一句");
    assert.equal(reads, 1);
    assert.equal((await store.get(exchange.id))?.turns[0]?.answer, "答一句");

    // A second read answers from the record, not from the runtime again.
    await api.detail("b_a", exchange.id);
    assert.equal(reads, 1);
  });
});

test("a bot outside the exchange cannot read it", async () => {
  await withStore(async (store) => {
    const exchange = await store.create(["b_a", "b_b"]);
    const api = peerApi({
      store,
      bots: () => [bot("b_a", "A"), bot("b_b", "B"), bot("b_c", "C")],
      submission: async () => undefined,
      entryText: async () => undefined,
    });
    assert.equal(await api.detail("b_c", exchange.id), undefined);
    assert.equal(await api.detail("b_a", "x_000000000000"), undefined);
    assert.deepEqual(await api.list("b_c"), []);
  });
});
