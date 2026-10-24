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
