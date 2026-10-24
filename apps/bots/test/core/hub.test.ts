// Ladder rows 12-16: revisions, fanout, backpressure, coalescing and snapshot rerender.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DELTA_FLUSH_MS,
  EventHub,
  type HubEvent,
  type HubSubscription,
} from "../../src/core/EventHub.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const status = (running = false) => ({
  type: "status" as const,
  trace,
  running,
  streaming: null,
  inbox: [],
});

const delta = (append: string, messageId = "p_a1") => ({
  type: "delta" as const,
  trace,
  messageId,
  changes: [{ kind: "text" as const, index: 0, append }],
});

const emptySnapshot = (running = false) => ({
  botId: "b_1",
  messages: [],
  streaming: null,
  pending: [],
  inbox: [],
  running,
});

test("revisions start at one and strictly increase", () => {
  const hub = new EventHub("b_1", trace);
  const seen: number[] = [];
  hub.subscribe((event) => {
    seen.push(event.rev);
  });
  for (let index = 0; index < 5; index += 1) {
    hub.publish(status(index % 2 === 0));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(hub.rev, 5);
});

test("snapshots take a revision like any other bot-scoped event", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const seen: { type: string; rev: number }[] = [];
  hub.subscribe((event) => seen.push({ type: event.type, rev: event.rev }));
  hub.publish(status());
  hub.publishSnapshot(emptySnapshot(true));
  assert.deepEqual(seen, [
    { type: "status", rev: 1 },
    { type: "snapshot", rev: 2 },
  ]);
  assert.equal(hub.rev, 2);
});

test("each hub numbers its own bot", () => {
  const first = new EventHub("b_1", trace);
  const second = new EventHub("b_2", trace);
  const firstSeen: number[] = [];
  const secondSeen: number[] = [];
  first.subscribe((event) => firstSeen.push(event.rev));
  second.subscribe((event) => secondSeen.push(event.rev));
  first.publish(status());
  first.publish(status());
  second.publish(status());
  assert.deepEqual(firstSeen, [1, 2]);
  assert.deepEqual(secondSeen, [1]);
});

test("every subscriber sees the same sequence, including a manual one", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const live: number[] = [];
  const manual: number[] = [];
  hub.subscribe((event) => live.push(event.rev));
  const subscription = hub.subscribe((event) => manual.push(event.rev), { manual: true });
  for (let index = 0; index < 4; index += 1) hub.publish(status(index % 2 === 0));
  hub.pump(subscription.id);
  assert.deepEqual(live, [1, 2, 3, 4]);
  assert.deepEqual(manual, [1, 2, 3, 4]);
});

test("a subscriber that falls behind is downgraded to snapshot-only", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const received: number[] = [];
  const subscription = hub.subscribe((event) => received.push(event.rev), { manual: true });
  for (let index = 0; index < 300; index += 1) hub.publish(status(index % 2 === 0));
  assert.equal(hub.degraded(subscription.id), true);
  hub.pump(subscription.id);
  assert.equal(received.length, 0, "a downgraded subscriber receives nothing while behind");
  hub.publishSnapshot(emptySnapshot());
  hub.pump(subscription.id);
  assert.deepEqual(received, [301], "the snapshot is the recovery and takes a revision");
  assert.equal(hub.degraded(subscription.id), false);
  hub.publish(status(true));
  hub.pump(subscription.id);
  assert.deepEqual(received, [301, 302], "the subscriber is live again after the snapshot");
});

test("a recovery snapshot is not evicted by increments that arrive before the pump", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const received: HubEvent[] = [];
  const subscription = hub.subscribe((event) => received.push(event), { manual: true });
  for (let index = 0; index < 300; index += 1) hub.publish(status(index % 2 === 0));
  hub.publishSnapshot(emptySnapshot());
  for (let index = 0; index < 300; index += 1) hub.publish(status(index % 2 === 0));
  hub.pump(subscription.id);
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot"],
    "increments are dropped while an undelivered snapshot is the only anchor",
  );
  assert.equal(hub.degraded(subscription.id), false);
});

test("deltas inside one window are coalesced and keep every appended byte", () => {
  const scheduled: (() => void)[] = [];
  const hub = new EventHub("b_1", trace, { schedule: (run) => scheduled.push(run) });
  const seen: { rev: number; changes: unknown }[] = [];
  hub.subscribe((event) => {
    if (event.type === "delta") seen.push({ rev: event.rev, changes: event.changes });
  });
  for (const append of ["a", "b", "c"]) hub.publish(delta(append));
  assert.equal(seen.length, 0, "nothing is delivered before the window closes");
  scheduled.shift()?.();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.changes, [{ kind: "text", index: 0, append: "abc" }]);
});

test("the default scheduler flushes 50 ms after the first delta without extending", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hub = new EventHub("b_1", trace);
  const seen: { rev: number; changes: unknown }[] = [];
  hub.subscribe((event) => {
    if (event.type === "delta") seen.push({ rev: event.rev, changes: event.changes });
  });
  hub.publish(delta("a"));
  t.mock.timers.tick(DELTA_FLUSH_MS - 1);
  assert.equal(seen.length, 0, "the window is not closed one millisecond early");
  hub.publish(delta("b"));
  t.mock.timers.tick(1);
  assert.equal(seen.length, 1, "a later delta does not extend the deadline");
  assert.deepEqual(seen[0]?.changes, [{ kind: "text", index: 0, append: "ab" }]);
});

test("a merged delta takes the next revision, so no subscriber sees a gap", () => {
  const scheduled: (() => void)[] = [];
  const hub = new EventHub("b_1", trace, { schedule: (run) => scheduled.push(run) });
  const seen: { type: string; rev: number }[] = [];
  hub.subscribe((event) => seen.push({ type: event.type, rev: event.rev }));
  hub.publish(status());
  for (const append of ["a", "b", "c"]) hub.publish(delta(append));
  scheduled.shift()?.();
  hub.publishSnapshot(emptySnapshot());
  assert.deepEqual(seen, [
    { type: "status", rev: 1 },
    { type: "delta", rev: 2 },
    { type: "snapshot", rev: 3 },
  ]);
  assert.equal(hub.rev, 3);
});

test("a non-delta event flushes pending deltas first, in order", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const seen: string[] = [];
  hub.subscribe((event) => seen.push(`${event.type}:${event.rev}`));
  hub.publish(delta("a"));
  hub.publish(status(true));
  assert.deepEqual(seen, ["delta:1", "status:2"]);
});

test("a runtime snapshot is rendered at the next revision", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const seen: { type: string; rev: number; running: boolean | undefined }[] = [];
  hub.subscribe((event) =>
    seen.push({
      type: event.type,
      rev: event.rev,
      running: event.type === "snapshot" ? event.value.running : undefined,
    }),
  );
  hub.publish(status(false));
  hub.publishSnapshot(emptySnapshot(true));
  assert.deepEqual(seen, [
    { type: "status", rev: 1, running: undefined },
    { type: "snapshot", rev: 2, running: true },
  ]);
});

test("merging keeps block, toolcall and message payloads intact", () => {
  const scheduled: (() => void)[] = [];
  const hub = new EventHub("b_1", trace, { schedule: (run) => scheduled.push(run) });
  const seen: unknown[] = [];
  hub.subscribe((event) => {
    if (event.type === "delta") seen.push(event.changes);
  });
  hub.publish({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [
      { kind: "text", index: 0, append: "a" },
      { kind: "toolcall", index: 1, callId: "c", path: ["args", "q"], append: "x" },
      { kind: "block", index: 2, block: { type: "text", text: "whole" } },
    ],
  });
  hub.publish(delta("b"));
  scheduled.shift()?.();
  // Only adjacent changes for the same block fold; a block change in between keeps the
  // original order instead of reordering content.
  assert.deepEqual(seen[0], [
    { kind: "text", index: 0, append: "a" },
    { kind: "toolcall", index: 1, callId: "c", path: ["args", "q"], append: "x" },
    { kind: "block", index: 2, block: { type: "text", text: "whole" } },
    { kind: "text", index: 0, append: "b" },
  ]);
});

test("deltas for different messages are not merged together", () => {
  const scheduled: (() => void)[] = [];
  const hub = new EventHub("b_1", trace, { schedule: (run) => scheduled.push(run) });
  const seen: string[] = [];
  hub.subscribe((event) => {
    if (event.type === "delta") seen.push(event.messageId);
  });
  hub.publish(delta("a", "p_a1"));
  hub.publish(delta("b", "p_a2"));
  hub.drain();
  assert.deepEqual(seen, ["p_a1", "p_a2"]);
});

test("a delta batch flushes before the 96 KiB soft limit without splitting a change", () => {
  const scheduled: (() => void)[] = [];
  const hub = new EventHub("b_1", trace, { schedule: (run) => scheduled.push(run) });
  const seen: unknown[] = [];
  hub.subscribe((event) => {
    if (event.type === "delta") seen.push(event.changes);
  });
  const big = "x".repeat(60 * 1024);
  hub.publish(delta(big));
  assert.equal(seen.length, 0, "one change stays inside the window");
  hub.publish(delta(big));
  assert.equal(seen.length, 1, "the batch flushes instead of growing past the soft limit");
  assert.deepEqual(seen[0], [{ kind: "text", index: 0, append: big }]);
  scheduled.shift()?.();
  assert.deepEqual(seen[1], [{ kind: "text", index: 0, append: big }]);
});

test("a subscriber behind in bytes is downgraded using the injected measurement", () => {
  const hub = new EventHub("b_1", trace, {
    schedule: () => {},
    measure: () => 600 * 1024,
  });
  const subscription = hub.subscribe(() => {}, { manual: true });
  hub.publish(status());
  assert.equal(hub.degraded(subscription.id), false);
  hub.publish(status());
  assert.equal(hub.degraded(subscription.id), true, "two 600 KiB events exceed 1 MiB");
});

test("the default measurement counts encoded bytes, not UTF-16 units", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const subscription = hub.subscribe(() => {}, { manual: true });
  const text = "汉".repeat(20_000);
  for (let index = 0; index < 20; index += 1) {
    hub.publish({
      type: "append",
      trace,
      message: {
        id: `e_${index}`,
        role: "user",
        state: "complete",
        createdAt: "x",
        blocks: [{ type: "text", text }],
      },
    });
  }
  assert.equal(hub.degraded(subscription.id), true);
});

test("a publish from a sink is serialized behind the event being delivered", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const first: number[] = [];
  const second: number[] = [];
  hub.subscribe((event) => {
    first.push(event.rev);
    if (event.rev === 1) hub.publish(status(true));
  });
  hub.subscribe((event) => second.push(event.rev));
  hub.publish(status(false));
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [1, 2], "the reentrant event waits for the whole fanout");
});

test("a subscriber that detaches inside a callback receives nothing more", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const received: number[] = [];
  let subscription: HubSubscription;
  subscription = hub.subscribe(
    (event) => {
      received.push(event.rev);
      subscription.detach();
    },
    { manual: true },
  );
  for (let index = 0; index < 3; index += 1) hub.publish(status());
  hub.pump(subscription.id);
  assert.deepEqual(received, [1]);
});

test("a sink that throws is dropped without stalling other subscribers", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const received: number[] = [];
  const throwing = hub.subscribe(() => {
    throw new Error("transport is gone");
  });
  hub.subscribe((event) => received.push(event.rev));
  hub.publish(status());
  hub.publish(status());
  assert.deepEqual(received, [1, 2]);
  assert.equal(hub.degraded(throwing.id), false);
  assert.equal(hub.subscriberCount, 1);
});
