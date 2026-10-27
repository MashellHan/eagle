// Ladder rows 23-27: pi-durable events → RuntimeEvent. The golden files under
// test/runtime/golden/ are recorded from a real Harness (scripts/record-golden.ts) and
// frozen; a hand-built case covers the shapes upstream only produces under conditions a
// faux provider cannot reach.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { DeltaChange, Message, StopReason } from "../../src/core/domain.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { reduceView } from "../../src/core/view.ts";
import {
  messageBytes,
  messageStateOf,
  provisionalMessageId,
} from "../../src/runtime/pi/convert.ts";
import { OVERSIZED_NOTICE } from "../../src/runtime/pi/limits.ts";
import { EventMapper } from "../../src/runtime/pi/mapEvents.ts";

const goldenDir = join(process.cwd(), "test/runtime/golden");
const trace = "tr_golden";
const fixedClock = () => new Date(0);

type Golden = {
  readonly scenario: string;
  readonly description: string;
  readonly events: readonly (readonly unknown[])[];
  readonly expected: readonly RuntimeEvent[];
};

const golden = (name: string): Golden =>
  JSON.parse(readFileSync(join(goldenDir, `${name}.json`), "utf8")) as Golden;

const mapperViewOf = (name: string) => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  for (const batch of golden(name).events) {
    for (const event of batch) mapper.map(event as never, trace);
  }
  return mapper.view();
};

const replay = (name: string): RuntimeEvent[] => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  return golden(name).events.flatMap((batch) =>
    batch.flatMap((event) => mapper.map(event as never, trace)),
  );
};

const of = <T extends RuntimeEvent["type"]>(events: readonly RuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

const appends = (events: readonly RuntimeEvent[]) =>
  of(events, "append").map((event) => [event.message.id, event.replaces ?? null] as const);

// ---------------------------------------------------------------- rows 23-26: goldens

test("maps a recorded run to append, delta, append, submission, status", () => {
  const events = replay("answer-with-deltas");
  const shape = events
    .map((event) =>
      event.type === "delta" ? "delta" : event.type === "submission" ? "submission" : event.type,
    )
    .filter((type, index, all) => type !== all[index - 1] || type !== "delta");
  assert.deepEqual(shape, [
    "append", // the user entry, on message_end
    "submission", // placed
    "status", // run_start after the first commit
    "append", // the provisional, from message_start content
    "delta",
    "append", // the answer entry replaces the provisional
    "status", // run_end
    "submission", // done
    "usage", // the conversation's totals after the turn
  ]);
  const [user, provisional, answer] = of(events, "append");
  assert.deepEqual(appends(events), [
    ["e_7", null],
    ["p_a1", null],
    ["e_10", "p_a1"],
  ]);
  assert.equal(user?.message.role, "user");
  // The submission record that names the request id arrives in the same batch, after the
  // entry, so the live append cannot carry it; the view and a later snapshot do.
  assert.equal(user?.message.requestId, undefined);
  assert.equal(mapperViewOf("answer-with-deltas").messages[0]?.requestId, "r_0000002");
  assert.equal(provisional?.message.state, "streaming");
  assert.equal(answer?.message.state, "complete");
  assert.equal(answer?.message.stopReason, "stop");

  const text = (message: Message) =>
    message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
  const streamed = of(events, "delta").reduce(
    (text, event) =>
      text + event.changes.map((change) => (change.kind === "text" ? change.append : "")).join(""),
    "",
  );
  // F4/F5: the provisional starts from `message_start` content and every later delta
  // extends it; the committed entry is the truth, and may end further along than the
  // last progress flush reached.
  const streamedText = text(provisional?.message as Message) + streamed;
  assert.ok(streamedText.length > 0, "the attempt streamed content");
  assert.ok(
    text(answer?.message as Message).startsWith(streamedText),
    "the stream is a prefix of what committed",
  );
  assert.deepEqual(
    of(events, "submission").map((event) => [event.record.status, event.record.answerEntryId]),
    [
      ["placed", undefined],
      ["done", "e_10"],
    ],
  );
});

test("every recorded sequence maps exactly as its frozen expectation", () => {
  const names = readdirSync(goldenDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.ok(names.length >= 8, "the golden set covers every recorded scenario");
  for (const name of names) {
    const file = golden(name.replace(/\.json$/, ""));
    assert.deepEqual(replay(file.scenario), file.expected, `${file.scenario} drifted`);
  }
});

test("builds the provisional from message_start content", () => {
  const events = replay("partial-start");
  const [provisional] = of(events, "append").filter((event) => event.message.id === "p_a1");
  const start = golden("partial-start")
    .events.flat()
    .find((event) => (event as { type: string }).type === "message_start" && isAssistant(event));
  const started = (start as { message: { content: { text?: string }[] } }).message.content;
  assert.deepEqual(provisional?.message.blocks, [{ type: "text", text: started[0]?.text ?? "" }]);
  assert.notEqual(started[0]?.text, "", "the first commit already carried content (F4)");
  assert.equal(provisional?.message.state, "streaming");
  assert.equal(provisional?.message.stopReason, undefined);
});

test("applies block and message replacements without loss, including a start block with no delta", () => {
  const events = replay("two-text-blocks");
  const changes = of(events, "delta").flatMap((event) => event.changes);
  const block = changes.find(
    (change): change is Extract<DeltaChange, { kind: "block" }> =>
      change.kind === "block" && change.index === 1,
  );
  assert.ok(block !== undefined, "a start block is announced as a block change");
  assert.equal(block.block.type, "text");
  const indexes = new Set(
    changes.filter((change) => change.kind === "text").map((change) => change.index),
  );
  assert.deepEqual([...indexes].sort(), [0, 1]);
  // Nothing is lost: replaying the changes for the second block reproduces it exactly.
  let second = block.block;
  for (const change of changes) {
    if (change.kind !== "text" || change.index !== 1) continue;
    second = { type: "text", text: `${second.text}${change.append}` };
  }
  const committed = of(events, "append").find((event) => event.message.id === "e_10")?.message;
  // The last progress flush is elided before the entry commits (F5), so the deltas are a
  // prefix of the committed block and never a substitute for it.
  const committedText = committed?.blocks[1];
  assert.equal(committedText?.type, "text");
  assert.ok(
    committedText.type === "text" && committedText.text.startsWith(second.text),
    "the streamed prefix is the prefix of what committed",
  );
  assert.ok(second.text.length > 0, "the second block streamed real content");
  // The plain run has no delta at all: its whole content arrives in message_start (F5).
  const plain = replay("plain-answer");
  assert.deepEqual(appends(plain), [
    ["e_7", null],
    ["p_a1", null],
    ["e_10", "p_a1"],
  ]);
  assert.deepEqual(of(plain, "delta"), []);
});

test("two text blocks receive deltas at their own indexes", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  const partial = {
    role: "assistant",
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: usage(),
    stopReason: "pending",
    timestamp: 0,
  };
  mapper.map({ type: "message_start", message: partial } as never, trace);
  const events = mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [
        { type: "text_delta", contentIndex: 1, delta: "!" },
        { type: "text_delta", contentIndex: 0, delta: "?" },
      ],
    } as never,
    trace,
  );
  assert.deepEqual(of(events, "delta")[0]?.changes, [
    { kind: "text", index: 1, append: "!" },
    { kind: "text", index: 0, append: "?" },
  ]);
  assert.deepEqual(
    of(events, "delta")[0]?.changes.map((change) => ("index" in change ? change.index : -1)),
    [1, 0],
  );
  const [first, second] = mapper.view().messages[0]?.blocks ?? [];
  assert.deepEqual(first, { type: "text", text: "first?" });
  assert.deepEqual(second, { type: "text", text: "second!" });
});

test("an aborted entry replaces the provisional that a late attach already delivered", () => {
  const events = replay("abort-with-queued");
  const aborted = of(events, "append").find((event) => event.message.state === "aborted");
  assert.equal(aborted?.message.id, "e_11");
  assert.equal(aborted?.replaces, "p_a1");

  // The same attempt, but joined late: the snapshot already carries the partial.
  const goldenFile = golden("abort-with-queued");
  const entry = goldenFile.events
    .flat()
    .filter((event) => (event as { type: string }).type === "message_end")
    .map((event) => (event as { entry: { kind: string } }).entry)
    .find((value) => value.kind === "pi.assistant" && hasAbortedModel(value));
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.seed(
    {
      type: "snapshot",
      entries: [userEntry()],
      run: { inputs: ["8"] },
      generation: {
        attempt: 1,
        message: assistantMessage("alpha beta gamma del", "pending"),
      },
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as never,
    trace,
  );
  assert.deepEqual(
    mapper.view().messages.map((message) => [message.id, message.state]),
    [
      ["e_7", "complete"],
      ["p_a1", "streaming"],
    ],
  );
  assert.equal(mapper.view().streaming, "p_a1");
  const mapped = mapper.map({ type: "message_end", entry } as never, trace);
  assert.deepEqual(
    of(mapped, "append").map((event) => [event.message.id, event.message.state, event.replaces]),
    [["e_11", "aborted", "p_a1"]],
  );
  assert.deepEqual(
    mapper.view().messages.map((message) => [message.id, message.state]),
    [
      ["e_7", "complete"],
      ["e_11", "aborted"],
    ],
  );
  assert.equal(mapper.view().streaming, null, "the provisional is gone, not duplicated");
});

test("an oversized projection is withheld: the notice takes the entry id, replaces the provisional, and a reconnect sees the same notice", () => {
  const huge = "x".repeat(100 * 1024);
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "run_start", inputs: ["8"] } as never, trace);
  const started = mapper.map(
    { type: "message_start", message: assistantMessage(huge, "pending") } as never,
    trace,
  );
  assert.deepEqual(
    of(started, "snapshot").map((event) => [event.value.streaming, event.value.messages.length]),
    [[null, 0]],
    "the withdrawn attempt is not in the snapshot",
  );
  assert.deepEqual(
    of(started, "status").map((event) => [event.streaming, event.running]),
    [[null, true]],
    "running stays true: the run has work even with no provisional",
  );
  assert.deepEqual(of(started, "append"), []);

  const ended = mapper.map(
    { type: "message_end", entry: hugeAssistantEntry(huge) } as never,
    trace,
  );
  const [append] = of(ended, "append");
  assert.equal(append?.message.id, "e_10");
  assert.equal(append?.message.role, "notice");
  assert.equal(append?.replaces, "p_a1");
  assert.equal(append?.message.stopReason, undefined);
  assert.deepEqual(append?.message.blocks, [{ type: "text", text: OVERSIZED_NOTICE }]);

  const reconnected = new EventMapper({ botId: "b_golden", now: fixedClock });
  reconnected.seed(
    {
      type: "snapshot",
      entries: [hugeAssistantEntry(huge)],
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as never,
    trace,
  );
  assert.deepEqual(
    reconnected.view().messages,
    append === undefined ? [] : [append.message],
    "same id, same notice, no duplicate and no oversized frame",
  );
});

test("a failed attempt finalizes its provisional and the retry gets a new id", () => {
  const events = replay("retry-in-turn");
  assert.deepEqual(appends(events), [
    ["e_7", null],
    ["p_a1", null],
    ["e_10", "p_a1"],
    ["p_a2", null],
    ["e_11", "p_a2"],
  ]);
  const attempts = of(events, "append").filter((event) => event.message.id.startsWith("p_a"));
  assert.deepEqual(
    attempts.map((event) => event.message.state),
    ["streaming", "streaming"],
    "a provisional is always in flight, whatever the resolved message says",
  );
  assert.deepEqual(
    of(events, "append")
      .filter((event) => event.message.state === "error")
      .map((event) => event.message.id),
    ["e_10"],
  );
  const retried = replay("provider-error");
  assert.equal(
    of(retried, "submission").at(-1)?.record.reason,
    "model_error",
    "every attempt failed, so the input settles unanswered",
  );
  assert.deepEqual(
    of(retried, "append")
      .filter((event) => event.message.state !== "complete")
      .map((event) => event.message.id),
    ["p_a1", "e_10", "p_a2", "e_11", "p_a3", "e_12", "p_a4", "e_13"],
  );
});

test("deferred_poll drops the provisional through a snapshot with streaming null", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "run_start", inputs: ["8"] } as never, trace);
  mapper.map(
    { type: "message_start", message: assistantMessage("partial", "pending") } as never,
    trace,
  );
  assert.equal(mapper.view().streaming, provisionalMessageId(1));
  const events = mapper.map({ type: "deferred_poll", pollAt: 1_000 } as never, trace);
  const [snapshot] = of(events, "snapshot");
  assert.equal(snapshot?.value.streaming, null);
  assert.equal(snapshot?.value.running, true);
  assert.deepEqual(
    snapshot?.value.messages.map((message) => message.id),
    [],
    "the dropped partial is gone, not stale",
  );
  assert.deepEqual(
    of(events, "status").map((event) => [event.running, event.streaming]),
    [[true, null]],
  );
  // A delta that arrives after the poll has no message to land on, so it is dropped.
  assert.deepEqual(
    mapper.map(
      {
        type: "message_update",
        usage: usage(),
        changes: [{ type: "text_delta", contentIndex: 0, delta: "late" }],
      } as never,
      trace,
    ),
    [],
  );

  const recorded = replay("deferred-poll");
  assert.deepEqual(
    of(recorded, "snapshot").map((event) => [event.value.streaming, event.value.running]),
    [
      [null, true],
      [null, true],
    ],
    "a deferred response never invents a streaming message (F23)",
  );
  assert.deepEqual(
    of(recorded, "append").map((event) => [event.message.id, event.replaces ?? null]),
    [
      ["e_7", null],
      ["p_a1", null],
      ["e_10", "p_a1"],
    ],
  );
});

test("maps every stopReason to a message state", () => {
  const expected: Readonly<Record<string, string | null>> = {
    pending: "streaming",
    stop: "complete",
    length: "complete",
    toolUse: "complete",
    aborted: "aborted",
    error: "error",
    deferred: null,
  };
  const reasons = Object.keys(expected) as (keyof typeof expected)[];
  assert.deepEqual(reasons.sort(), [
    "aborted",
    "deferred",
    "error",
    "length",
    "pending",
    "stop",
    "toolUse",
  ]);
  for (const reason of reasons) {
    assert.equal(messageStateOf(reason as never), expected[reason], `${reason} has a state`);
  }
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map(
    {
      type: "message_end",
      entry: assistantEntry(assistantMessage("answer", "length")),
    } as never,
    trace,
  );
  assert.deepEqual(
    mapper.view().messages.map((message) => [message.state, message.stopReason]),
    [["complete", "length"]],
    "a token-limit answer is complete and says why, so the client renders its own notice",
  );
  assert.deepEqual(
    of(replay("tool-call"), "append")
      .filter((event) => event.message.stopReason === "toolUse")
      .map((event) => [event.message.id, event.message.state]),
    [["e_10", "complete"]],
  );
  const states: StopReason[] = ["stop", "length", "toolUse", "aborted", "error"];
  for (const state of states) {
    const single = new EventMapper({ botId: "b_golden", now: fixedClock });
    single.map(
      {
        type: "message_end",
        entry: assistantEntry(assistantMessage("answer", state)),
      } as never,
      trace,
    );
    const [message] = single.view().messages;
    assert.equal(message?.stopReason, state);
    assert.equal(
      message?.state,
      state === "stop" || state === "length" || state === "toolUse"
        ? "complete"
        : state === "aborted"
          ? "aborted"
          : "error",
    );
  }
});

test("an attach snapshot that already counts the attempt keeps its provisional id", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  const snapshot = {
    type: "snapshot",
    entries: [userEntry()],
    run: { inputs: ["8"] },
    generation: { attempt: 1 },
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  };
  mapper.seed(snapshot as never, trace);
  assert.equal(mapper.view().streaming, null, "an attempt with no partial is not streaming yet");
  const events = mapper.map(
    { type: "message_start", message: assistantMessage("答", "pending") } as never,
    trace,
  );
  assert.deepEqual(
    of(events, "append").map((event) => event.message.id),
    ["p_a1"],
    "the attempt already in flight is p_a1, not p_a2",
  );
});

test("a re-announced whole message over the limit is withdrawn like the first one", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock, maxMessageBytes: 200 });
  mapper.map({ type: "run_start", inputs: ["8"] } as never, trace);
  const first = mapper.map(
    { type: "message_start", message: assistantMessage("短", "pending") } as never,
    trace,
  );
  assert.deepEqual(
    of(first, "append").map((event) => event.message.id),
    ["p_a1"],
  );
  const reannounced = mapper.map(
    { type: "message_start", message: assistantMessage("x".repeat(400), "pending") } as never,
    trace,
  );
  assert.deepEqual(of(reannounced, "delta"), [], "the oversized replacement is never sent");
  assert.deepEqual(
    of(reannounced, "snapshot").map((event) => [
      event.value.streaming,
      event.value.messages.length,
    ]),
    [[null, 0]],
    "the attempt is withdrawn through a snapshot instead",
  );
  assert.equal(mapper.view().streaming, null);
});

test("a withheld notice is identical on every read, whatever the clock says", () => {
  const huge = "x".repeat(2_000);
  const entry = hugeAssistantEntry(huge);
  const first = new EventMapper({
    botId: "b_golden",
    now: () => new Date(1_000),
    maxMessageBytes: 500,
  });
  const second = new EventMapper({
    botId: "b_golden",
    now: () => new Date(9_999_999),
    maxMessageBytes: 500,
  });
  first.seed(
    {
      type: "snapshot",
      entries: [entry],
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as never,
    trace,
  );
  second.seed(
    {
      type: "snapshot",
      entries: [entry],
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as never,
    trace,
  );
  const [a] = first.view().messages;
  const [b] = second.view().messages;
  assert.deepEqual(a, b, "the notice keeps the entry's own timestamp");
  assert.equal(a?.role, "notice");
  assert.equal(a?.id, "e_10");
});

test("a start block with no delta is announced once and never invented", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "message_start", message: assistantMessage("", "pending") } as never, trace);
  const block = mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }],
    } as never,
    trace,
  );
  assert.deepEqual(of(block, "delta")[0]?.changes, [
    { kind: "block", index: 0, block: { type: "text", text: "" } },
  ]);
  assert.deepEqual(
    mapper.map({ type: "message_update", usage: usage(), changes: [] } as never, trace),
    [],
    "an empty batch is not a change",
  );
  assert.deepEqual(mapper.view().messages[0]?.blocks, [{ type: "text", text: "" }]);
});

test("a whole-message change replaces the content and keeps the attempt streaming", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "message_start", message: assistantMessage("dr", "pending") } as never, trace);
  const events = mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [{ type: "message", message: assistantMessage("draft done", "pending") }],
    } as never,
    trace,
  );
  const message = of(events, "delta")[0]?.changes[0];
  assert.equal(message?.kind, "message");
  assert.deepEqual(
    message?.kind === "message" ? [message.message.state, message.message.blocks] : undefined,
    ["streaming", [{ type: "text", text: "draft done" }]],
    "the replacement is streaming, so the client's pointer still names a live attempt",
  );
  assert.equal(mapper.view().streaming, provisionalMessageId(1));
  assert.deepEqual(mapper.view().messages[0]?.blocks, [{ type: "text", text: "draft done" }]);
});

test("a snapshot from the stream rebuilds pending from the work it names", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  const record = {
    id: "8",
    requestId: "r_0000002",
    status: "placed" as const,
    entryId: "e_7",
  };
  const base = {
    type: "snapshot",
    entries: [userEntry()],
    run: { inputs: ["8"] },
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  };
  mapper.seed(base as never, trace, [record]);
  assert.deepEqual(
    mapper.view().pending.map((item) => item.id),
    ["8"],
    "the active submission is pending",
  );
  // An overflow snapshot that still names the input keeps it…
  mapper.map(base as never, trace);
  assert.deepEqual(
    mapper.view().pending.map((item) => item.id),
    ["8"],
    "a reattach that still names the input does not lose it",
  );
  // …and one that names nothing drops it, whatever the ledger last saw.
  mapper.map({ ...base, run: undefined, entries: [] } as never, trace);
  assert.deepEqual(mapper.view().pending, [], "a settled input leaves pending");
});

test("a snapshot upgrades a queued record the run has placed", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  const queued = { id: "10", requestId: "r_0000006", status: "queued" as const };
  mapper.map({ type: "submission", record: submissionRecord(queued) } as never, trace);
  assert.deepEqual(
    mapper.view().pending.map((item) => item.status),
    ["queued"],
  );
  mapper.seed(
    {
      type: "snapshot",
      entries: [userEntry()],
      run: { inputs: ["10"] },
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as never,
    trace,
  );
  assert.deepEqual(
    mapper.view().pending.map((item) => [item.id, item.status]),
    [["10", "placed"]],
    "the run naming the input is newer than the ledger's queued record",
  );
});

test("a deferred poll closes the attempt, so the next one gets a new id", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "run_start", inputs: ["8"] } as never, trace);
  const first = mapper.map(
    { type: "message_start", message: assistantMessage("partial", "pending") } as never,
    trace,
  );
  assert.deepEqual(
    of(first, "append").map((event) => event.message.id),
    ["p_a1"],
  );
  mapper.map({ type: "deferred_poll", pollAt: 1 } as never, trace);
  const second = mapper.map(
    { type: "message_start", message: assistantMessage("after the poll", "pending") } as never,
    trace,
  );
  assert.deepEqual(
    of(second, "append").map((event) => event.message.id),
    ["p_a2"],
    "a withdrawn attempt never shares its id with the next one",
  );
});

test("a block replacement carries real content, not only the empty start", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "message_start", message: assistantMessage("", "pending") } as never, trace);
  const events = mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [{ type: "block", contentIndex: 0, block: { type: "text", text: "whole block" } }],
    } as never,
    trace,
  );
  assert.deepEqual(of(events, "delta")[0]?.changes, [
    { kind: "block", index: 0, block: { type: "text", text: "whole block" } },
  ]);
  assert.deepEqual(mapper.view().messages[0]?.blocks, [{ type: "text", text: "whole block" }]);
  const replaced = mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [{ type: "message", message: assistantMessage("done", "stop") }],
    } as never,
    trace,
  );
  const change = of(replaced, "delta")[0]?.changes[0];
  assert.equal(
    change?.kind === "message" ? change.message.state : undefined,
    "streaming",
    "a resolved replacement is still the attempt in flight, so it is normalized",
  );
  assert.deepEqual(mapper.view().messages[0]?.blocks, [{ type: "text", text: "done" }]);
});

test("a tool result is a transcript row and does not end the live attempt", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  mapper.map({ type: "message_start", message: assistantMessage("", "pending") } as never, trace);
  const entry = {
    id: 11,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "list_files",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        isError: true,
        timestamp: 5,
        durationMs: 12,
      },
    ],
  };
  const events = mapper.map({ type: "message_end", entry } as never, trace);
  assert.deepEqual(of(events, "append")[0]?.message, {
    id: "e_11",
    role: "tool",
    state: "complete",
    createdAt: new Date(5).toISOString(),
    blocks: [
      {
        type: "toolResult",
        callId: "call_1",
        name: "list_files",
        text: "a\nb",
        isError: true,
        durationMs: 12,
      },
    ],
  });
  assert.equal(
    mapper.view().streaming,
    "p_a1",
    "the assistant still streaming keeps its provisional while a tool result commits",
  );
});

test("a toolcall delta carries a block-rooted path and the fold agrees", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
  const events: RuntimeEvent[] = [
    ...mapper.map(
      { type: "message_start", message: assistantMessage("", "pending") } as never,
      trace,
    ),
  ];
  events.push(
    ...mapper.map(
      {
        type: "message_update",
        usage: usage(),
        changes: [
          {
            type: "toolcall_start",
            contentIndex: 0,
            block: { type: "toolCall", id: "c_1", name: "search", arguments: {} },
          },
        ],
      } as never,
      trace,
    ),
    ...mapper.map(
      {
        type: "message_update",
        usage: usage(),
        changes: [
          { type: "toolcall_delta", contentIndex: 0, path: ["nested", "q"], delta: "a" },
          { type: "toolcall_delta", contentIndex: 0, path: ["nested", "q"], delta: "Z" },
        ],
      } as never,
      trace,
    ),
  );
  const deltas = of(events, "delta").flatMap((event) => event.changes);
  assert.deepEqual(
    deltas.filter((change) => change.kind === "toolcall"),
    [
      { kind: "toolcall", index: 0, callId: "c_1", path: ["args", "nested", "q"], append: "a" },
      { kind: "toolcall", index: 0, callId: "c_1", path: ["args", "nested", "q"], append: "Z" },
    ],
    "pi's arguments-relative path becomes the wire's block-rooted path",
  );
  let view = reduceView(
    {
      botId: "b_golden",
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
    events[0] as never,
    new Map(),
  );
  for (const event of events.slice(1)) view = reduceView(view, event, new Map());
  const expected = { nested: { q: "aZ" } };
  const block = view.messages[0]?.blocks[0];
  assert.equal(block?.type, "toolCall");
  assert.deepEqual(
    block?.type === "toolCall" ? block.args : undefined,
    expected,
    "the emitted events fold to the same arguments the mapper holds",
  );
  const own = mapper.view().messages[0]?.blocks[0];
  assert.deepEqual(
    own?.type === "toolCall" ? own.args : undefined,
    expected,
    "the mapper's own view folds the same path, not only the wire copy",
  );
});

test("a tool argument that grows past the budget withdraws the attempt", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock, maxMessageBytes: 4_096 });
  mapper.map({ type: "message_start", message: assistantMessage("", "pending") } as never, trace);
  mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [
        {
          type: "toolcall_start",
          contentIndex: 0,
          block: { type: "toolCall", id: "c_1", name: "search", arguments: {} },
        },
      ],
    } as never,
    trace,
  );
  const events = mapper.map(
    {
      type: "message_update",
      usage: usage(),
      changes: [
        { type: "toolcall_delta", contentIndex: 0, path: ["q"], delta: "x".repeat(100_000) },
      ],
    } as never,
    trace,
  );
  assert.equal(
    events.some((event) => event.type === "snapshot"),
    true,
  );
  assert.equal(mapper.view().streaming, null);
  assert.equal(mapper.view().messages.length, 0, "the oversized attempt is withdrawn");
});

test("an oversized tool result is clamped to the message budget, not turned into a notice", () => {
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock, maxMessageBytes: 4_096 });
  const entry = {
    id: 11,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "run_command",
        content: [{ type: "text", text: "x".repeat(8_000) }],
        isError: false,
        timestamp: 5,
      },
    ],
  };
  const events = mapper.map({ type: "message_end", entry } as never, trace);
  const message = of(events, "append")[0]?.message;
  assert.equal(message?.role, "tool");
  const block = message?.blocks[0];
  assert.equal(block?.type, "toolResult");
  assert.match(block?.type === "toolResult" ? block.text : "", /\[tool output truncated\]$/);
  assert.ok(message !== undefined && messageBytes(message) <= 4_096);
});

test("a tool result of quotes and newlines is clamped by its encoded size", () => {
  // Every quote or newline costs two bytes on the wire; the fitting prefix must be found
  // by measuring the encoded message, not by counting raw characters.
  const mapper = new EventMapper({ botId: "b_golden", now: fixedClock, maxMessageBytes: 4_096 });
  for (const text of ['"'.repeat(8_000), "\n".repeat(8_000), "\\".repeat(8_000)]) {
    const entry = {
      id: 11,
      conversationId: 1,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "run_command",
          content: [{ type: "text", text }],
          isError: false,
          timestamp: 5,
        },
      ],
    };
    const message = of(mapper.map({ type: "message_end", entry } as never, trace), "append")[0]
      ?.message;
    assert.ok(message !== undefined && messageBytes(message) <= 4_096);
    assert.match(
      message?.blocks[0]?.type === "toolResult" ? message.blocks[0].text : "",
      /\[tool output truncated\]$/,
    );
  }
});

test("a tool result that interleaves a commit keeps the snapshot's order", () => {
  const toolEntry = {
    id: 12,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: "c_1",
        toolName: "list_files",
        content: [{ type: "text", text: "a" }],
        isError: false,
        timestamp: 5,
      },
    ],
  };
  const finalEntry = assistantEntry(assistantMessage("done", "stop"), 13);
  const snapshot = {
    type: "snapshot",
    entries: [toolEntry, finalEntry],
    run: { inputs: [] },
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  };

  const live = new EventMapper({ botId: "b_golden", now: fixedClock });
  live.map({ type: "message_start", message: assistantMessage("", "pending") } as never, trace);
  live.map({ type: "message_end", entry: toolEntry } as never, trace);
  const replaced = live.map({ type: "message_end", entry: finalEntry } as never, trace);
  assert.equal(of(replaced, "append")[0]?.replaces, "p_a1");
  assert.deepEqual(
    live.view().messages.map((message) => message.id),
    ["e_12", "e_13"],
    "the finalized entry lands after the tool result committed during its attempt",
  );

  const seeded = new EventMapper({ botId: "b_golden", now: fixedClock });
  seeded.seed(snapshot as never, trace);
  assert.deepEqual(
    seeded.view().messages.map((message) => message.id),
    live.view().messages.map((message) => message.id),
    "a late join sees the same order as the live stream",
  );

  // Window 1: the tool result trims the provisional away, so `streaming` must not name a
  // message the view no longer holds.
  const narrow = new EventMapper({ botId: "b_golden", now: fixedClock, windowMessages: 1 });
  narrow.map({ type: "message_start", message: assistantMessage("", "pending") } as never, trace);
  narrow.map({ type: "message_end", entry: toolEntry } as never, trace);
  assert.deepEqual(
    narrow.view().messages.map((message) => message.id),
    ["e_12"],
  );
  assert.equal(narrow.view().streaming, null);
  const final = narrow.map({ type: "message_end", entry: finalEntry } as never, trace);
  assert.equal(of(final, "append")[0]?.replaces, undefined);
  assert.deepEqual(
    narrow.view().messages.map((message) => message.id),
    ["e_13"],
  );
});

test("the mapper's view agrees with the service's fold of the same events", () => {
  for (const name of ["answer-with-deltas", "abort-with-queued", "tool-call", "two-text-blocks"]) {
    const mapper = new EventMapper({ botId: "b_golden", now: fixedClock });
    const ranks = new Map();
    let view = mapper.view();
    for (const batch of golden(name).events) {
      for (const event of batch) {
        for (const mapped of mapper.map(event as never, trace)) {
          view = reduceView(view, mapped, ranks);
        }
      }
    }
    const own = mapper.view();
    assert.deepEqual(
      view.messages.map((message) => [message.id, message.state]),
      own.messages.map((message) => [message.id, message.state]),
      `${name}: the emitted events fold to the view the mapper holds`,
    );
    assert.equal(view.streaming, own.streaming, `${name}: streaming agrees`);
    assert.deepEqual(view.pending, own.pending, `${name}: pending agrees`);
  }
});

// ---------------------------------------------------------------- fixture helpers

const usage = () => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMessage = (text: string, stopReason: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: usage(),
  stopReason,
  timestamp: 0,
});

const assistantEntry = (message: unknown, id = 10) => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [message],
});

const hugeAssistantEntry = (text: string) => assistantEntry(assistantMessage(text, "stop"));

const submissionRecord = (record: {
  id: string;
  requestId: string;
  status: string;
  entryId?: string;
}) => ({
  id: record.id,
  conversationId: 1,
  type: "input",
  requestId: record.requestId,
  status: record.status,
  ...(record.entryId === undefined ? {} : { entry: record.entryId.replace(/^e_/, "") }),
});

const userEntry = () => ({
  id: 7,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: "第一个问题", timestamp: 0 }],
});

const isAssistant = (event: unknown) =>
  (event as { message?: { role?: string } }).message?.role === "assistant";

const hasAbortedModel = (entry: unknown) => {
  const model = (entry as { model?: { stopReason?: string }[] }).model;
  return model?.[0]?.stopReason === "aborted";
};
