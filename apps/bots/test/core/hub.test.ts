// Ladder row 12: revisions are strictly increasing per bot and every subscriber sees
// the same sequence.
import assert from "node:assert/strict";
import test from "node:test";
import { EventHub } from "../../src/core/EventHub.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

test("revisions start at one and strictly increase", () => {
  const hub = new EventHub("b_1", trace);
  const seen: number[] = [];
  hub.subscribe((event) => {
    seen.push(event.rev);
  });
  for (let index = 0; index < 5; index += 1) {
    hub.publish({ type: "status", trace, running: index % 2 === 0, streaming: null, inbox: [] });
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(hub.rev, 5);
});

test("snapshots take a revision like any other bot-scoped event", () => {
  const hub = new EventHub("b_1", trace);
  hub.publish({ type: "status", trace, running: false, streaming: null, inbox: [] });
  const snapshot = hub.publishSnapshot({
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  });
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.rev, 2);
});

test("each hub numbers its own bot", () => {
  const first = new EventHub("b_1", trace);
  const second = new EventHub("b_2", trace);
  assert.equal(
    "rev" in first.publish({ type: "status", trace, running: false, streaming: null, inbox: [] }),
    true,
  );
  const event = second.publish({
    type: "status",
    trace,
    running: false,
    streaming: null,
    inbox: [],
  });
  assert.equal("rev" in event ? event.rev : undefined, 1);
});

const status = (running = false) => ({
  type: "status" as const,
  trace,
  running,
  streaming: null,
  inbox: [],
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
  hub.drain();
});

test("deltas inside one window are coalesced and keep every appended byte", () => {
  const scheduled: (() => void)[] = [];
  const hub = new EventHub("b_1", trace, { schedule: (run) => scheduled.push(run) });
  const seen: { rev: number; changes: unknown }[] = [];
  hub.subscribe((event) => {
    if (event.type === "delta") seen.push({ rev: event.rev, changes: event.changes });
  });
  for (const append of ["a", "b", "c"]) {
    hub.publish({
      type: "delta",
      trace,
      messageId: "p_a1",
      changes: [{ kind: "text", index: 0, append }],
    });
  }
  assert.equal(seen.length, 0, "nothing is delivered before the window closes");
  scheduled.shift()?.();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.changes, [{ kind: "text", index: 0, append: "abc" }]);
  assert.equal(seen[0]?.rev, 3, "the merged delta keeps the latest revision");
});

test("a non-delta event flushes pending deltas first, in order", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const seen: string[] = [];
  hub.subscribe((event) => seen.push(`${event.type}:${event.rev}`));
  hub.publish({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "a" }],
  });
  hub.publish(status(true));
  hub.drain();
  assert.deepEqual(seen, ["delta:1", "status:2"]);
});

test("a runtime snapshot is rendered at the next revision", () => {
  const hub = new EventHub("b_1", trace, { schedule: () => {} });
  const seen: { type: string; rev: number }[] = [];
  hub.subscribe((event) => seen.push({ type: event.type, rev: event.rev }));
  hub.publish(status(false));
  const snapshot = hub.publishSnapshot({
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: true,
  });
  assert.deepEqual(seen, [
    { type: "status", rev: 1 },
    { type: "snapshot", rev: 2 },
  ]);
  assert.equal(snapshot.rev, 2);
  assert.equal(snapshot.type === "snapshot" ? snapshot.value.running : undefined, true);
});
