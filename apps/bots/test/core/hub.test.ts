// Ladder rows 12-16: revisions, fanout, backpressure, coalescing and snapshot rerender.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DELTA_BATCH_BYTE_LIMIT,
  EventHub,
  type HubEvent,
  type HubOptions,
  type HubSubscription,
  SubscriberTooSlow,
} from "../../src/core/EventHub.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const utf8 = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const hub = (options: Partial<HubOptions> = {}): EventHub =>
  new EventHub("b_1", trace, { measure: utf8, schedule: () => {}, ...options });

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
  const events = hub();
  const seen: number[] = [];
  events.subscribe((event) => {
    seen.push(event.rev);
  });
  for (let index = 0; index < 5; index += 1) {
    events.publish(status(index % 2 === 0));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(events.rev, 5);
});

test("snapshots take a revision like any other bot-scoped event", () => {
  const events = hub();
  const seen: { type: string; rev: number }[] = [];
  events.subscribe((event) => seen.push({ type: event.type, rev: event.rev }));
  events.publish(status());
  events.publishSnapshot(emptySnapshot(true));
  assert.deepEqual(seen, [
    { type: "status", rev: 1 },
    { type: "snapshot", rev: 2 },
  ]);
  assert.equal(events.rev, 2);
});

test("each hub numbers its own bot", () => {
  const first = hub();
  const second = new EventHub("b_2", trace, { measure: utf8, schedule: () => {} });
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
  const events = hub();
  const live: number[] = [];
  const manual: number[] = [];
  events.subscribe((event) => live.push(event.rev));
  const subscription = events.subscribe((event) => manual.push(event.rev), { manual: true });
  for (let index = 0; index < 4; index += 1) events.publish(status(index % 2 === 0));
  events.pump(subscription.id);
  assert.deepEqual(live, [1, 2, 3, 4]);
  assert.deepEqual(manual, [1, 2, 3, 4]);
});

test("a subscriber that falls behind is downgraded to snapshot-only", () => {
  const events = hub();
  const received: number[] = [];
  const subscription = events.subscribe((event) => received.push(event.rev), { manual: true });
  for (let index = 0; index < 300; index += 1) events.publish(status(index % 2 === 0));
  assert.equal(events.degraded(subscription.id), true);
  events.pump(subscription.id);
  assert.equal(received.length, 0, "a downgraded subscriber receives nothing while behind");
  events.publishSnapshot(emptySnapshot());
  events.pump(subscription.id);
  assert.deepEqual(received, [301], "the snapshot is the recovery and takes a revision");
  assert.equal(events.degraded(subscription.id), false);
  events.publish(status(true));
  events.pump(subscription.id);
  assert.deepEqual(received, [301, 302], "the subscriber is live again after the snapshot");
});

test("a snapshot that lost a later event is never delivered as if it were current", () => {
  const events = hub();
  const received: HubEvent[] = [];
  const subscription = events.subscribe((event) => received.push(event), { manual: true });
  for (let index = 0; index < 300; index += 1) events.publish(status(true));
  events.publishSnapshot(emptySnapshot(true));
  events.publish(status(false));
  events.pump(subscription.id);
  assert.equal(received.length, 0, "the anchor is stale, so the subscriber stays snapshot-only");
  assert.equal(events.degraded(subscription.id), true);
  events.publishSnapshot(emptySnapshot(false));
  events.pump(subscription.id);
  assert.deepEqual(
    received.map((event) => (event.type === "snapshot" ? event.value.running : null)),
    [false],
    "a current snapshot re-anchors the subscriber with the running state it lost",
  );
  assert.equal(events.degraded(subscription.id), false);
});

test("deltas inside one window are coalesced and keep every appended byte", () => {
  const scheduled: (() => void)[] = [];
  const events = hub({ schedule: (run) => scheduled.push(run) });
  const seen: { rev: number; changes: unknown }[] = [];
  events.subscribe((event) => {
    if (event.type === "delta") seen.push({ rev: event.rev, changes: event.changes });
  });
  for (const append of ["a", "b", "c"]) events.publish(delta(append));
  assert.equal(seen.length, 0, "nothing is delivered before the window closes");
  scheduled.shift()?.();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.changes, [{ kind: "text", index: 0, append: "abc" }]);
});

test("the default scheduler flushes 50 ms after the first delta without extending", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventHub("b_1", trace, { measure: utf8 });
  const seen: { rev: number; changes: unknown }[] = [];
  events.subscribe((event) => {
    if (event.type === "delta") seen.push({ rev: event.rev, changes: event.changes });
  });
  events.publish(delta("a"));
  t.mock.timers.tick(49);
  assert.equal(seen.length, 0, "the contract's window is 50 ms, not 49");
  events.publish(delta("b"));
  t.mock.timers.tick(1);
  assert.equal(seen.length, 1, "a later delta does not extend the deadline");
  assert.deepEqual(seen[0]?.changes, [{ kind: "text", index: 0, append: "ab" }]);
});

test("a merged delta takes the next revision, so no subscriber sees a gap", () => {
  const scheduled: (() => void)[] = [];
  const events = hub({ schedule: (run) => scheduled.push(run) });
  const seen: { type: string; rev: number }[] = [];
  events.subscribe((event) => seen.push({ type: event.type, rev: event.rev }));
  events.publish(status());
  for (const append of ["a", "b", "c"]) events.publish(delta(append));
  scheduled.shift()?.();
  events.publishSnapshot(emptySnapshot());
  assert.deepEqual(seen, [
    { type: "status", rev: 1 },
    { type: "delta", rev: 2 },
    { type: "snapshot", rev: 3 },
  ]);
  assert.equal(events.rev, 3);
});

test("a non-delta event flushes pending deltas first, in order", () => {
  const events = hub();
  const seen: string[] = [];
  events.subscribe((event) => seen.push(`${event.type}:${event.rev}`));
  events.publish(delta("a"));
  events.publish(status(true));
  assert.deepEqual(seen, ["delta:1", "status:2"]);
});

test("a runtime snapshot is rendered at the next revision", () => {
  const events = hub();
  const seen: { type: string; rev: number; running: boolean | undefined }[] = [];
  events.subscribe((event) =>
    seen.push({
      type: event.type,
      rev: event.rev,
      running: event.type === "snapshot" ? event.value.running : undefined,
    }),
  );
  events.publish(status(false));
  events.publishSnapshot(emptySnapshot(true));
  assert.deepEqual(seen, [
    { type: "status", rev: 1, running: undefined },
    { type: "snapshot", rev: 2, running: true },
  ]);
});

test("merging keeps block, toolcall and message payloads intact", () => {
  const scheduled: (() => void)[] = [];
  const events = hub({ schedule: (run) => scheduled.push(run) });
  const seen: unknown[] = [];
  events.subscribe((event) => {
    if (event.type === "delta") seen.push(event.changes);
  });
  events.publish({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [
      { kind: "text", index: 0, append: "a" },
      { kind: "toolcall", index: 1, callId: "c", path: ["args", "q"], append: "x" },
      { kind: "block", index: 2, block: { type: "text", text: "whole" } },
    ],
  });
  events.publish(delta("b"));
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
  const events = hub();
  const seen: string[] = [];
  events.subscribe((event) => {
    if (event.type === "delta") seen.push(event.messageId);
  });
  events.publish(delta("a", "p_a1"));
  events.publish(delta("b", "p_a2"));
  events.drain();
  assert.deepEqual(seen, ["p_a1", "p_a2"]);
});

test("one event with several large changes is split between changes, not inside one", () => {
  const events = hub();
  const seen: HubEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const replacement = (text: string) => ({
    kind: "message" as const,
    message: {
      id: "p_a1",
      role: "assistant" as const,
      state: "streaming" as const,
      createdAt: "x",
      blocks: [{ type: "text" as const, text }],
    },
  });
  const letters = ["a", "b", "c", "d"];
  const changes = letters.map((letter) => replacement(letter.repeat(70_000)));
  events.publish({ type: "delta", trace, messageId: "p_a1", changes });
  events.drain();
  assert.equal(seen.length, 4, "each oversized change travels in its own frame");
  for (const [index, event] of seen.entries()) {
    assert.ok(utf8(event) < DELTA_BATCH_BYTE_LIMIT, "no frame crosses the soft limit alone");
    const delivered = event.type === "delta" ? event.changes : undefined;
    assert.deepEqual(delivered, [changes[index]], "each frame carries its whole change");
  }
});

test("the injected measurement decides when a subscriber is downgraded", () => {
  const events = hub({ measure: () => 600 * 1024 });
  const subscription = events.subscribe(() => {}, { manual: true });
  events.publish(status());
  assert.equal(events.degraded(subscription.id), false);
  events.publish(status());
  assert.equal(events.degraded(subscription.id), true, "two 600 KiB events exceed 1 MiB");
});

test("the measurement, not the domain shape, decides the queued bytes", () => {
  // The wire encodes `streaming` as {messageId}, so a domain-JSON measure would price
  // these snapshots wrongly; only the injected transport measure is trusted.
  const events = hub({ measure: () => 128 * 1024 });
  const subscription = events.subscribe(() => {}, { manual: true });
  for (let index = 0; index < 8; index += 1) events.publishSnapshot(emptySnapshot());
  assert.equal(events.degraded(subscription.id), false, "eight 128 KiB events fit in 1 MiB");
  events.publishSnapshot(emptySnapshot());
  assert.equal(events.degraded(subscription.id), true, "the ninth exceeds it");
});

test("the reference measurement counts encoded bytes, not UTF-16 units", () => {
  const events = hub();
  const subscription = events.subscribe(() => {}, { manual: true });
  const text = "汉".repeat(20_000);
  for (let index = 0; index < 20; index += 1) {
    events.publish({
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
  assert.equal(events.degraded(subscription.id), true);
});

test("a publish from a sink is serialized behind the event being delivered", () => {
  const events = hub();
  const first: number[] = [];
  const second: number[] = [];
  events.subscribe((event) => {
    first.push(event.rev);
    if (event.rev === 1) events.publish(status(true));
  });
  events.subscribe((event) => second.push(event.rev));
  events.publish(status(false));
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [1, 2], "the reentrant event waits for the whole fanout");
});

test("a timer flush plus a publish from a sink stay in revision order", () => {
  const scheduled: (() => void)[] = [];
  const events = hub({ schedule: (run) => scheduled.push(run) });
  const seen: string[] = [];
  events.subscribe((event) => {
    seen.push(`${event.type}:${event.rev}`);
    if (event.type === "delta" && event.rev === 1) events.publishSnapshot(emptySnapshot(true));
  });
  events.publish(delta("a", "p_a1"));
  events.publish(delta("b", "p_a2"));
  scheduled.shift()?.();
  assert.deepEqual(seen, ["delta:1", "delta:2", "snapshot:3"]);
});

test("a subscriber that detaches inside a callback receives nothing more", () => {
  const events = hub();
  const received: number[] = [];
  let subscription: HubSubscription;
  subscription = events.subscribe(
    (event) => {
      received.push(event.rev);
      subscription.detach();
    },
    { manual: true },
  );
  for (let index = 0; index < 3; index += 1) events.publish(status());
  events.pump(subscription.id);
  assert.deepEqual(received, [1]);
});

test("a pump from inside a sink does not re-enter it", () => {
  const events = hub();
  const received: number[] = [];
  let depth = 0;
  let deepest = 0;
  let subscription: HubSubscription;
  subscription = events.subscribe(
    (event) => {
      depth += 1;
      deepest = Math.max(deepest, depth);
      received.push(event.rev);
      events.pump(subscription.id);
      depth -= 1;
    },
    { manual: true },
  );
  for (let index = 0; index < 3; index += 1) events.publish(status());
  events.pump(subscription.id);
  assert.deepEqual(received, [1, 2, 3]);
  assert.equal(deepest, 1, "the sink is never called re-entrantly");
});

test("a sink that throws is dropped without stalling other subscribers", () => {
  const events = hub();
  const received: number[] = [];
  const throwing = events.subscribe(() => {
    throw new Error("transport is gone");
  });
  events.subscribe((event) => received.push(event.rev));
  events.publish(status());
  events.publish(status());
  assert.deepEqual(received, [1, 2]);
  assert.equal(events.degraded(throwing.id), false);
  assert.equal(events.subscriberCount, 1);
});

test("a sink publish cannot slip between a flushed delta and its triggering event", () => {
  const events = hub();
  const seen: string[] = [];
  events.subscribe((event) => {
    seen.push(`${event.type}:${event.rev}`);
    if (event.type === "delta") {
      events.publish({
        type: "append",
        trace,
        message: {
          id: "p_a1",
          role: "assistant",
          state: "streaming",
          createdAt: "x",
          blocks: [{ type: "text", text: "final" }],
        },
      });
    }
  });
  events.publish(delta("a"));
  events.publishSnapshot(emptySnapshot());
  assert.deepEqual(seen, ["delta:1", "snapshot:2", "append:3"]);
});

test("a pump requested for another subscriber from inside a sink is not lost", () => {
  const events = hub();
  const first: number[] = [];
  const second: number[] = [];
  const manual = events.subscribe((event) => second.push(event.rev), { manual: true });
  events.subscribe((event) => {
    first.push(event.rev);
    events.pump(manual.id);
  });
  events.publish(status());
  assert.deepEqual(first, [1]);
  assert.deepEqual(second, [1], "the cross-slot request runs after the fanout, not inside it");
});

test("a pump requested on every event is never starved by a publishing sink", () => {
  const events = hub();
  const live: number[] = [];
  const manual: number[] = [];
  let depth = 0;
  let deepest = 0;
  const subscription = events.subscribe((event) => manual.push(event.rev), { manual: true });
  events.subscribe((event) => {
    depth += 1;
    deepest = Math.max(deepest, depth);
    live.push(event.rev);
    events.pump(subscription.id);
    if (event.rev < 300) events.publish(status());
    depth -= 1;
  });
  events.publish(status());
  assert.equal(live.length, 300);
  assert.deepEqual(manual, live, "the manual subscriber keeps up with the whole chain");
  assert.equal(events.degraded(subscription.id), false);
  assert.equal(deepest, 1, "no sink is called re-entrantly");
});

test("the snapshot that triggers the overflow becomes the recovery anchor", () => {
  const events = hub({ measure: () => 1 });
  const received: HubEvent[] = [];
  const subscription = events.subscribe((event) => received.push(event), { manual: true });
  for (let index = 0; index < 256; index += 1) events.publish(status());
  assert.equal(events.degraded(subscription.id), false, "256 queued events still fit");
  events.publishSnapshot(emptySnapshot(true));
  assert.equal(events.degraded(subscription.id), true);
  events.pump(subscription.id);
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot"],
    "the overflowing snapshot is delivered instead of dropped",
  );
  assert.equal(events.degraded(subscription.id), false);
});

test("a snapshot that exceeds the byte budget also becomes the anchor", () => {
  const events = hub({
    measure: (event) => (event.type === "snapshot" ? 60_300 : 4_000),
  });
  const received: HubEvent[] = [];
  const subscription = events.subscribe((event) => received.push(event), { manual: true });
  for (let index = 0; index < 255; index += 1) events.publish(status());
  events.publishSnapshot(emptySnapshot(true));
  events.pump(subscription.id);
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot"],
  );
  assert.equal(events.degraded(subscription.id), false);
});

test("adjacent appends for different block indexes are not merged", () => {
  const scheduled: (() => void)[] = [];
  const events = hub({ schedule: (run) => scheduled.push(run) });
  const seen: unknown[] = [];
  events.subscribe((event) => {
    if (event.type === "delta") seen.push(event.changes);
  });
  events.publish({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "A" }],
  });
  events.publish({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 1, append: "B" }],
  });
  scheduled.shift()?.();
  assert.deepEqual(seen[0], [
    { kind: "text", index: 0, append: "A" },
    { kind: "text", index: 1, append: "B" },
  ]);
});

test("a sink that cannot accept more is downgraded to snapshot-only", async () => {
  const { log, records } = (await import("../../src/log/log.ts")).captureLog();
  const slow = hub({ log });
  let delivered = 0;
  let refusing = true;
  const received: HubEvent[] = [];
  const id = slow.subscribe((event) => {
    if (refusing && delivered >= 2) throw new SubscriberTooSlow();
    delivered += 1;
    received.push(event);
  }).id;
  slow.publish(status(true));
  slow.publish(delta("a"));
  slow.drain();
  // The next delivery is refused by the transport, which is the same bound as a full queue.
  slow.publish(status(false));
  slow.drain();
  assert.equal(slow.degraded(id), true, "the subscriber is snapshot-only");
  assert.equal(
    records.filter((record) => record.evt === "core.hub.degrade").length,
    1,
    "the downgrade is recorded once",
  );
  refusing = false;
  received.length = 0;
  slow.publishSnapshot(
    {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    },
    trace,
  );
  slow.drain();
  assert.equal(slow.degraded(id), false, "a current snapshot is the recovery");
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "snapshot");
});
