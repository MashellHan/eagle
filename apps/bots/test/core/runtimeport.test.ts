// Ladder row 11: the fake runtime satisfies the port, so core tests can rely on it.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

test("open is recorded and returns a handle with the whole port", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  assert.deepEqual([...runtime.handles.keys()], ["b_1"]);
  for (const method of [
    "subscribe",
    "submit",
    "submission",
    "history",
    "abort",
    "recover",
    "busy",
    "close",
  ] as const) {
    assert.equal(typeof handle[method], "function", `${method} is missing`);
  }
  assert.deepEqual(await handle.busy(), { run: false, tasks: false });
  assert.equal(await handle.close(trace, 5_000), "closed");
  assert.deepEqual(runtime.handle("b_1").closes, [{ trace, deadlineMs: 5_000 }]);
});

test("subscribe is atomic: the snapshot and every later event arrive", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const seen: RuntimeEvent[] = [];
  const subscription = await handle.subscribe(trace, (event) => seen.push(event));
  assert.deepEqual(subscription.snapshot.messages, []);
  runtime.handle("b_1").emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "status");
  subscription.detach();
  runtime.handle("b_1").emit({ type: "status", trace, running: false, streaming: null, inbox: [] });
  assert.equal(seen.length, 1, "a detached sink receives nothing");
});

test("submit is idempotent by requestId and the record is readable both ways", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "queued" },
        },
      ],
    },
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const first = await handle.submit({ requestId, text: "hi", whenBusy: "followUp", trace });
  const second = await handle.submit({ requestId, text: "hi", whenBusy: "followUp", trace });
  assert.equal(first.id, second.id);
  assert.deepEqual(await handle.submission({ requestId }), first);
  assert.deepEqual(await handle.submission({ submissionId: first.id }), first);
  assert.equal(await handle.submission({ requestId: "nope" }), undefined);
});

test("history pages older messages and stops at the boundary", async () => {
  const runtime = new FakeRuntime({
    snapshot: () => ({
      botId: "b_1",
      messages: [1, 2, 3, 4, 5].map((index) => ({
        id: `e_${index}`,
        role: "user" as const,
        state: "complete" as const,
        createdAt: "2026-10-25T02:11:04.001Z",
        blocks: [{ type: "text" as const, text: String(index) }],
      })),
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    }),
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  assert.deepEqual(
    (await handle.history({ limit: 2 })).messages.map((m) => m.id),
    ["e_4", "e_5"],
  );
  const older = await handle.history({ beforeEntryId: "e_4", limit: 2 });
  assert.deepEqual(
    older.messages.map((m) => m.id),
    ["e_2", "e_3"],
  );
  assert.equal(older.hasMore, true);
});

test("each bot keeps its own state, and a second open returns the same handle", async () => {
  const runtime = new FakeRuntime();
  const spec = (id: string) => ({
    id,
    dir: `/tmp/${id}`,
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const first = await runtime.open(spec("b_1"));
  const second = await runtime.open(spec("b_2"));
  assert.notEqual(first, second);
  assert.equal(await runtime.open(spec("b_1")), first);
  runtime.handle("b_1").emit({
    type: "append",
    trace,
    message: { id: "e_1", role: "user", state: "complete", createdAt: "x", blocks: [], requestId },
  });
  assert.equal((await first.history({ limit: 10 })).messages.length, 1);
  assert.equal((await second.history({ limit: 10 })).messages.length, 0);
});

test("emitted events are visible through the query methods", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "submission",
    trace,
    record: { id: "s_1", requestId, status: "placed", entryId: "e_1" },
  });
  assert.deepEqual(await handle.submission({ requestId }), {
    id: "s_1",
    requestId,
    status: "placed",
    entryId: "e_1",
  });
  assert.equal((await handle.busy()).run, false);
  fake.emit({ type: "status", trace, running: true, streaming: "p_a1", inbox: [] });
  assert.equal((await handle.busy()).run, true);
});

test("deltas, replacements and snapshots keep the view consistent", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "p_a1",
      role: "assistant",
      state: "streaming",
      createdAt: "x",
      blocks: [{ type: "text", text: "A" }],
    },
  });
  fake.emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "B" }],
  });
  fake.emit({
    type: "append",
    trace,
    replaces: "p_a1",
    message: {
      id: "e_1",
      role: "assistant",
      state: "complete",
      createdAt: "x",
      blocks: [{ type: "text", text: "AB" }],
    },
  });
  const view = (await handle.subscribe(trace, () => {})).snapshot;
  assert.deepEqual(
    view.messages.map((m) => m.id),
    ["e_1"],
  );
  assert.equal(view.streaming, null, "a replaced provisional cannot remain the streaming target");
  const block = view.messages[0]?.blocks[0];
  assert.equal(block?.type === "text" ? block.text : "", "AB");
});

test("a snapshot is the authority for pending, running and the ledger", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "snapshot",
    trace,
    value: {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [{ id: "s_7", requestId, status: "queued" }],
      inbox: [],
      running: true,
    },
  });
  assert.equal((await handle.busy()).run, true);
  assert.deepEqual(await handle.submission({ requestId }), {
    id: "s_7",
    requestId,
    status: "queued",
  });
  assert.deepEqual(
    (await handle.submit({ requestId, text: "again", whenBusy: "followUp", trace })).id,
    "s_7",
  );
});

test("an admitted submission is visible in pending", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  await handle.submit({ requestId, text: "hi", whenBusy: "followUp", trace });
  const view = (await handle.subscribe(trace, () => {})).snapshot;
  assert.deepEqual(
    view.pending.map((record) => record.id),
    ["s_1"],
  );
});

test("delta kinds keep every byte, including a replacement followed by more changes", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "p_a1",
      role: "assistant",
      state: "streaming",
      createdAt: "x",
      blocks: [{ type: "text", text: "A" }],
    },
  });
  fake.emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [
      {
        kind: "message",
        message: {
          id: "p_a1",
          role: "assistant",
          state: "streaming",
          createdAt: "x",
          blocks: [
            { type: "text", text: "base" },
            { type: "toolCall", callId: "c_1", name: "read", args: {} },
          ],
        },
      },
      { kind: "text", index: 0, append: "+" },
      { kind: "toolcall", index: 1, callId: "c_1", path: ["args", "path"], append: "/tmp/x" },
    ],
  });
  const view = (await handle.subscribe(trace, () => {})).snapshot;
  const [text, call] = view.messages[0]?.blocks ?? [];
  assert.equal(text?.type === "text" ? text.text : "", "base+");
  assert.deepEqual(call?.type === "toolCall" ? call.args : {}, { path: "/tmp/x" });
});

test("a snapshot handed to the constructor seeds the ledger", async () => {
  const runtime = new FakeRuntime({
    snapshot: () => ({
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [{ id: "s_9", requestId, status: "placed", entryId: "e_1" }],
      inbox: [],
      running: true,
    }),
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  assert.deepEqual(await handle.submission({ requestId }), {
    id: "s_9",
    requestId,
    status: "placed",
    entryId: "e_1",
  });
  assert.equal((await handle.busy()).run, true);
});

test("changes before a message replacement apply to the old content, not the new one", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "p_a1",
      role: "assistant",
      state: "streaming",
      createdAt: "x",
      blocks: [{ type: "text", text: "A" }],
    },
  });
  fake.emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [
      { kind: "text", index: 0, append: "!" },
      {
        kind: "message",
        message: {
          id: "p_a1",
          role: "assistant",
          state: "streaming",
          createdAt: "x",
          blocks: [{ type: "text", text: "base" }],
        },
      },
      { kind: "text", index: 0, append: "+" },
    ],
  });
  const view = (await handle.subscribe(trace, () => {})).snapshot;
  const block = view.messages[0]?.blocks[0];
  assert.equal(block?.type === "text" ? block.text : "", "base+");
});

test("a submission created after a restored ledger entry does not reuse its id", async () => {
  const runtime = new FakeRuntime({
    snapshot: () => ({
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [
        { id: "s_2", requestId: "r_0190a1b4-5061-7c72-8d3e-4f5061728394", status: "queued" },
      ],
      inbox: [],
      running: false,
    }),
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const created = await handle.submit({
    requestId: "r_0190a1b5-6172-7d83-9e4f-506172839405",
    text: "hi",
    whenBusy: "followUp",
    trace,
  });
  assert.equal(created.id, "s_3");
});

test("a toolcall delta walks the whole path from the block root", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "p_a1",
      role: "assistant",
      state: "streaming",
      createdAt: "x",
      blocks: [
        {
          type: "toolCall",
          callId: "c_1",
          name: "read",
          args: { q: "A", list: [{ value: "X" }] },
        },
      ],
    },
  });
  fake.emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [
      { kind: "toolcall", index: 0, callId: "c_1", path: ["args", "q"], append: "B" },
      {
        kind: "toolcall",
        index: 0,
        callId: "c_1",
        path: ["args", "list", 0, "value"],
        append: "Y",
      },
    ],
  });
  const view = (await handle.subscribe(trace, () => {})).snapshot;
  const call = view.messages[0]?.blocks[0];
  assert.deepEqual(call?.type === "toolCall" ? call.args : {}, {
    q: "AB",
    list: [{ value: "XY" }],
  });
});

test("a streaming append becomes the pointer a late joiner sees, and finalization clears it", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "p_a1",
      role: "assistant",
      state: "streaming",
      createdAt: "x",
      blocks: [{ type: "text", text: "half" }],
    },
  });
  const joined = (await handle.subscribe(trace, () => {})).snapshot;
  assert.equal(joined.streaming, "p_a1", "a late joiner sees the attempt as active");
  fake.emit({
    type: "append",
    trace,
    replaces: "p_a1",
    message: {
      id: "e_1",
      role: "assistant",
      state: "complete",
      createdAt: "x",
      blocks: [{ type: "text", text: "half and more" }],
    },
  });
  const finished = (await handle.subscribe(trace, () => {})).snapshot;
  assert.equal(finished.streaming, null);
});

test("history keeps messages that the current window no longer shows", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  for (const id of ["e_1", "e_2"]) {
    fake.emit({
      type: "append",
      trace,
      message: {
        id,
        role: "user",
        state: "complete",
        createdAt: "x",
        blocks: [{ type: "text", text: id }],
      },
    });
  }
  fake.emit({
    type: "snapshot",
    trace,
    value: {
      botId: "b_1",
      messages: [
        {
          id: "e_2",
          role: "user",
          state: "complete",
          createdAt: "x",
          blocks: [{ type: "text", text: "e_2" }],
        },
      ],
      truncatedBefore: "e_2",
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
  });
  assert.deepEqual(
    (await handle.history({ beforeEntryId: "e_2", limit: 10 })).messages.map((m) => m.id),
    ["e_1"],
  );
  assert.deepEqual(
    (await handle.history({ limit: 10 })).messages.map((m) => m.id),
    ["e_1", "e_2"],
  );
});

test("a withdrawn provisional leaves no history ghost", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "p_a1",
      role: "assistant",
      state: "streaming",
      createdAt: "x",
      blocks: [{ type: "text", text: "partial" }],
    },
  });
  fake.emit({
    type: "snapshot",
    trace,
    value: {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
  });
  fake.emit({
    type: "append",
    trace,
    message: {
      id: "e_1",
      role: "user",
      state: "complete",
      createdAt: "x",
      blocks: [{ type: "text", text: "next" }],
    },
  });
  assert.deepEqual(
    (await handle.history({ beforeEntryId: "e_1", limit: 10 })).messages.map((m) => m.id),
    [],
    "the withdrawn attempt is not a committed entry",
  );
});

test("a window that grows merges history in the order the snapshot already implies", async () => {
  const committed = (id: string) => ({
    id,
    role: "user" as const,
    state: "complete" as const,
    createdAt: "x",
    blocks: [{ type: "text" as const, text: id }],
  });
  const runtime = new FakeRuntime({
    snapshot: () => ({
      botId: "b_1",
      messages: [committed("e_3")],
      truncatedBefore: "e_3",
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    }),
  });
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  runtime.handle("b_1").emit({
    type: "snapshot",
    trace,
    value: {
      botId: "b_1",
      messages: [committed("e_1"), committed("e_2"), committed("e_3")],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
  });
  assert.deepEqual(
    (await handle.history({ limit: 10 })).messages.map((m) => m.id),
    ["e_1", "e_2", "e_3"],
  );
  assert.deepEqual(
    (await handle.history({ beforeEntryId: "e_3", limit: 10 })).messages.map((m) => m.id),
    ["e_1", "e_2"],
  );
});

test("a finalization keeps the window and history in one order", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  const message = (id: string, state: "streaming" | "complete", text: string) => ({
    id,
    role: (state === "streaming" ? "assistant" : "user") as "assistant" | "user",
    state,
    createdAt: "x",
    blocks: [{ type: "text" as const, text }],
  });
  fake.emit({ type: "append", trace, message: message("e_1", "complete", "one") });
  fake.emit({ type: "append", trace, message: message("p_a1", "streaming", "answer") });
  fake.emit({ type: "append", trace, message: message("e_2", "complete", "two") });
  fake.emit({
    type: "append",
    trace,
    replaces: "p_a1",
    message: {
      id: "e_3",
      role: "assistant",
      state: "complete",
      createdAt: "x",
      blocks: [{ type: "text", text: "answer" }],
    },
  });
  const view = (await handle.subscribe(trace, () => {})).snapshot;
  const window = view.messages.map((m) => m.id);
  assert.deepEqual(
    window,
    ["e_1", "e_2", "e_3"],
    "a finalized entry lands at its commit position, after entries committed before it",
  );
  assert.deepEqual(
    (await handle.history({ limit: 10 })).messages.map((m) => m.id),
    window,
    "history pages in the order the client already shows",
  );
  assert.deepEqual(
    (await handle.history({ beforeEntryId: "e_3", limit: 10 })).messages.map((m) => m.id),
    ["e_1", "e_2"],
  );
});

test("the fake ledger never downgrades a settled record", async () => {
  const runtime = new FakeRuntime();
  const handle = await runtime.open({
    id: "b_1",
    dir: "/tmp/b_1",
    model: { provider: "faux", modelId: "faux-1" },
    trace,
  });
  const fake = runtime.handle("b_1");
  const settled = {
    id: "s_1",
    requestId,
    status: "done" as const,
    entryId: "e_1",
    answerEntryId: "e_2",
  };
  fake.emit({ type: "submission", trace, record: settled });
  fake.emit({
    type: "submission",
    trace,
    record: { id: "s_1", requestId, status: "queued" },
  });
  fake.emit({
    type: "snapshot",
    trace,
    value: {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [{ id: "s_1", requestId, status: "queued" }],
      inbox: [],
      running: false,
    },
  });
  assert.deepEqual(await handle.submission({ requestId }), settled);
  assert.deepEqual(
    await handle.submit({ requestId, text: "again", whenBusy: "followUp", trace }),
    settled,
    "a repeated send answers the settlement, not the stale duplicate",
  );
});
