// Two real bots in one real daemon: A hands a message to B through the same host a peer_send tool
// calls, B's real Harness answers it, and A reads that answer back by its receipt. Only the model
// network is faked (docs/bots/TESTING.md, "What may be faked").
import assert from "node:assert/strict";
import test from "node:test";
import { peerRequestId } from "../../src/peers/host.ts";
import { createPeerTools } from "../../src/tools/peers/tools.ts";
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

test("the peer_send tool, not just the host, hands a message over and peer_read returns the answer", async () => {
  const stack = await startStack({ real: true, toolGroups: ["core", "coding", "peers"] });
  try {
    const sender = await stack.createBot("sender");
    const target = await stack.createBot("target");
    const faux = stack.faux;
    assert.ok(faux !== undefined);
    faux.setResponses([text("CI 里已经重现，我改完通知你。")]);

    const tools = createPeerTools(stack.peersFor(sender));
    const peerSend = tools.find((tool) => tool.name === "peer_send");
    const peerRead = tools.find((tool) => tool.name === "peer_read");
    assert.ok(peerSend !== undefined && peerRead !== undefined);

    // The model's own step, with the durable task id the runtime supplies.
    const sent = await peerSend.execute(
      { botId: target, message: "us2 上 dashboard 的 tsc 过不了，帮我看下" },
      { taskId: "task-tool-1" } as never,
      {} as never,
    );
    const admitted = (sent.output ?? [])
      .map((block) => ("text" in block ? block.text : ""))
      .join("\n");
    assert.match(admitted, /admitted · to=/);
    const requestId = peerRequestId(sender, target, "task-tool-1");
    assert.match(admitted, new RegExp(requestId));

    await waitFor(async () => {
      const read = await peerRead.execute({ requestId } as never, {} as never, {} as never);
      return (read.output ?? [])
        .map((block) => ("text" in block ? block.text : ""))
        .join("\n")
        .includes("CI 里已经重现");
    }, "the peer_read tool returning the answer");

    // A second send from the same tool task is the same message, not a duplicate.
    const again = await peerSend.execute(
      { botId: target, message: "us2 上 dashboard 的 tsc 过不了，帮我看下" },
      { taskId: "task-tool-1" } as never,
      {} as never,
    );
    assert.match(
      (again.output ?? []).map((block) => ("text" in block ? block.text : "")).join("\n"),
      new RegExp(requestId),
    );
    const after = await viewOf(stack, target);
    assert.equal(after.filter((message) => message.role === "user").length, 1);
  } finally {
    await stack.close();
  }
});

test("the app reads the exchange over HTTP: participants, count and the answer", async () => {
  const stack = await startStack({ real: true, toolGroups: ["core", "coding", "peers"] });
  try {
    const sender = await stack.createBot("sender");
    const target = await stack.createBot("target");
    const faux = stack.faux;
    assert.ok(faux !== undefined);
    faux.setResponses([text("两份税册对不上，我按第二份改。")]);

    const host = stack.peersFor(sender);
    const sent = await host.send({ taskId: "task-http-1", toBotId: target, message: "对一下税册" });
    await waitFor(
      async () => (await host.read({ requestId: sent.requestId })).status === "done",
      "the answer",
    );

    const call = (path: string) =>
      fetch(`http://127.0.0.1:${stack.port}${path}`, {
        headers: { authorization: `Bearer ${stack.token}` },
      });

    const list = (await (await call(`/v1/bots/${sender}/exchanges`)).json()) as {
      exchanges: Array<{
        id: string;
        count: number;
        participants: Array<{ id: string; title: string }>;
      }>;
    };
    const summary = list.exchanges.find((item) => item.id === sent.exchangeId);
    assert.ok(summary !== undefined, "the sender's catalog lists its exchange");
    assert.deepEqual(summary.participants.map((item) => item.title).sort(), ["sender", "target"]);
    assert.equal(summary.count, 2, "one question and one answer");

    const detail = (await (
      await call(`/v1/bots/${sender}/exchanges/${sent.exchangeId}`)
    ).json()) as {
      exchange: { turns: Array<{ text: string; answer?: string; fromBotId: string }> };
    };
    assert.equal(detail.exchange.turns[0]?.text, "对一下税册");
    assert.equal(detail.exchange.turns[0]?.answer, "两份税册对不上，我按第二份改。");
    assert.equal(detail.exchange.turns[0]?.fromBotId, sender);

    // The recipient reads the same exchange, and a stranger cannot read it at all.
    assert.equal((await call(`/v1/bots/${target}/exchanges/${sent.exchangeId}`)).status, 200);
    const stranger = await stack.createBot("stranger");
    assert.equal((await call(`/v1/bots/${stranger}/exchanges/${sent.exchangeId}`)).status, 404);
    assert.equal((await call(`/v1/bots/${sender}/exchanges/x_000000000000`)).status, 404);
  } finally {
    await stack.close();
  }
});
