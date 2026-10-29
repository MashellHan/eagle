// Two real bots in one real daemon: A hands a message to B through the same host a peer_send tool
// calls, B's real Harness answers it, and A reads that answer back by its receipt. Only the model
// network is faked (docs/bots/TESTING.md, "What may be faked").
import assert from "node:assert/strict";
import test from "node:test";
import { text } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

/** What a client sees: the snapshot a subscription is opened with, origins applied. */
const viewOf = async (
  stack: Awaited<ReturnType<typeof startStack>>,
  botId: string,
): Promise<
  readonly {
    origin?: { kind: string; fromBotId?: string };
    blocks: readonly { type: string; text?: string }[];
    role: string;
  }[]
> => {
  const connectionId = "conn_peer_view";
  try {
    const { snapshot } = await stack.service.subscribe(
      connectionId,
      botId,
      "tr_peer_view_01",
      () => {},
    );
    return snapshot.messages;
  } finally {
    stack.service.unsubscribe(connectionId);
  }
};

const textOf = (message: { blocks: readonly { type: string; text?: string }[] }): string =>
  message.blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");

const waitFor = async (check: () => Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("one bot messages another and reads its answer", async () => {
  const stack = await startStack({
    real: true,
    toolGroups: ["core", "coding", "peers"],
  });
  try {
    const sender = await stack.createBot("sender");
    const target = await stack.createBot("target");
    // B answers the message it is handed; A's run never touches the model here.
    const faux = stack.faux;
    assert.ok(faux !== undefined, "a real stack scripts the model");
    faux.setResponses([text("修好了：dashboard 的 searchParams 已经判空。")]);

    const host = stack.peersFor(sender);
    const sent = await host.send({
      taskId: "task-peer-1",
      toBotId: target,
      message: "检查 dashboard 的 tsc 失败是不是 useSearchParams 没判空",
    });
    assert.match(sent.requestId, /^pr_[0-9a-f]{16}$/);
    assert.equal(sent.toBotId, target);
    assert.equal(sent.sent, 1);
    assert.equal(sent.remaining, 9);
    assert.equal(sent.exchangeStatus, "open");

    // The message reached B's transcript as a peer-originated turn…
    await waitFor(async () => {
      const messages = await viewOf(stack, target);
      return messages.some((message) => message.origin?.kind === "peer");
    }, "the peer message in the target's transcript");
    const received = await viewOf(stack, target);
    const peerMessage = received.find((message) => message.origin?.kind === "peer");
    assert.ok(peerMessage !== undefined, "the peer message is in the transcript");
    assert.equal(peerMessage.origin?.fromBotId, sender);
    assert.match(textOf(peerMessage), /tsc/);

    // …B answered it, and the answer is what A reads back through its own receipt.
    await waitFor(async () => {
      const read = await host.read({ requestId: sent.requestId });
      return read.status === "done";
    }, "the target's answer");
    const read = await host.read({ requestId: sent.requestId });
    assert.equal(read.status, "done");
    assert.match(read.answer ?? "", /修好了/);

    // Reading never started another turn: the target still shows one answer for one message.
    const after = await viewOf(stack, target);
    assert.equal(after.filter((message) => message.role === "assistant").length, 1);
  } finally {
    await stack.close();
  }
});

test("both bots of an exchange appear in its record, and receipts stay the sender's", async () => {
  const stack = await startStack({ real: true, toolGroups: ["core", "coding", "peers"] });
  try {
    const a = await stack.createBot("a");
    const b = await stack.createBot("b");
    const faux = stack.faux;
    assert.ok(faux !== undefined);
    faux.setResponses([text("收到。")]);

    const hostA = stack.peersFor(a);
    const sent = await hostA.send({ taskId: "task-a-1", toBotId: b, message: "第一件事" });

    const hostB = stack.peersFor(b);
    // B cannot read A's receipt: ownership comes from the receipt journal, not from the id alone.
    await assert.rejects(() => hostB.read({ requestId: sent.requestId }), /was not sent by you/);
    assert.deepEqual(await hostB.receipts({ limit: 20 }), []);

    const receipts = await hostA.receipts({ limit: 20 });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.requestId, sent.requestId);
    assert.equal(receipts[0]?.toBotId, b);

    const listing = await hostA.list({ limit: 20 });
    assert.deepEqual(
      listing.items.map((item) => item.botId),
      [b],
      "a bot is never offered itself",
    );
  } finally {
    await stack.close();
  }
});
