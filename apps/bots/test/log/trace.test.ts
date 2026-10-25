// Ladder row 43: the trace recipes. Each case injects one fault, waits on an explicit
// barrier and asserts presence *and* absence, so a missing record is a fact, not a race
// (docs/bots/OBSERVABILITY.md, "Diagnosis recipes").
import assert from "node:assert/strict";
import test from "node:test";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("R3: a malformed command never reaches core or the runtime", async () => {
  const stack = await startStack({ real: true });
  try {
    const botId = await stack.createBot("R3");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("r3sub") });
    await frames.next();
    const before = stack.records.length;
    await send(socket, { type: "nonsense", trace: tr("r3") });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.kind, "invalid_command");
    const records = stack.records.slice(before);
    const decode = records.filter((record) => record.evt === "protocol.decode.fail");
    assert.equal(decode.length, 1, "the protocol layer owns the record");
    assert.equal(decode[0]?.err?.origin, true);
    assert.equal(decode[0]?.err?.kind, "invalid_command");
    assert.deepEqual(
      records.filter((record) => record.layer === "core" || record.layer === "runtime"),
      [],
      "no core or runtime record for a frame that never decoded",
    );
    // The connection survives: the client can keep using it (PROTOCOL I8).
    await send(socket, { type: "ping" });
    assert.equal((await frames.next()).type, "pong");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("the command trace is echoed on everything the command causes", async () => {
  const stack = await startStack({ real: true });
  try {
    stack.faux?.setResponses([text("回答")]);
    const botId = await stack.createBot("trace");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const subscribeTrace = tr("trace1");
    await send(socket, { type: "subscribe", botId, trace: subscribeTrace });
    const baseline = await frames.next();
    assert.equal(baseline.trace, subscribeTrace, "the baseline answers the command");

    const sendTrace = tr("trace2");
    await send(socket, {
      type: "send",
      requestId: "r_trace_00001",
      text: "问题",
      whenBusy: "followUp",
      trace: sendTrace,
    });
    const seen: Record<string, unknown>[] = [];
    for (;;) {
      const frame = await frames.next(10_000);
      seen.push(frame);
      if (frame.type === "submission" && frame.status === "done") break;
    }
    // The first `submission` is the reply to this send; everything from there on is the
    // run that send admitted.
    const caused = seen.slice(seen.findIndex((frame) => frame.type === "submission"));
    assert.ok(caused.length >= 2, "the reply and its events arrived");
    for (const frame of caused) {
      assert.equal(frame.trace, sendTrace, `${String(frame.type)} inherits the submit trace`);
    }
    assert.ok(
      seen.some((frame) => frame.type === "append"),
      "the answer reached the client on the same trace",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a frame the client did not trace uses the connection trace", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const before = stack.records.length;
    await send(socket, { type: "ping" });
    assert.equal((await frames.next()).type, "pong");
    const records = stack.records.slice(before);
    const ping = records.find(
      (record) => record.evt === "transport.frame.recv.ok" && record.detail?.bytes !== undefined,
    );
    assert.ok(ping, "the frame was recorded");
    assert.match(ping.trace, /^tr_conn_\d+$/, "liveness uses the connection trace, never a new id");
    assert.equal(ping.connId, "c_1");
    const sent = records.find((record) => record.evt === "transport.frame.send.ok");
    assert.equal(sent?.trace, ping.trace, "the reply joins the same trace");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("daemon-originated work uses the boot trace", async () => {
  const stack = await startStack();
  try {
    const before = stack.records.length;
    // A create warms the bot without any command from a client.
    await stack.createBot("预热");
    for (let index = 0; index < 200; index += 1) {
      if (stack.records.some((record) => record.evt === "core.bot.open.ok")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const records = stack.records.slice(before);
    const opened = records.filter((record) => record.evt === "core.bot.open.ok");
    assert.equal(opened.length, 1, "the daemon opened the bot on its own");
    assert.match(opened[0]?.trace ?? "", /^tr_create_probe$/, "the caller's trace is inherited");
    const started = stack.records.filter((record) => record.evt === "core.recovery.start");
    assert.ok(started.length > 0);
    assert.match(started[0]?.trace ?? "", /^tr_boot_/, "the scan is boot work");
  } finally {
    await stack.close();
  }
});
