// PROTOCOL.md v1, additive: a bot-scoped `triggers` list, the same list on a snapshot, and
// a capability flag. The frame stays inside the page budget with eight worst-case entries.
import assert from "node:assert/strict";
import test from "node:test";
import type { TriggerSummary } from "../../src/core/domain.ts";
import { encodeServerEvent } from "../../src/protocol/encode.ts";
import { decodeServerEvent } from "../../src/protocol/frames.ts";
import { PAGE_MAX_BYTES } from "../../src/protocol/limits.ts";
import { assertFrameBudget } from "../../src/protocol/validate.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const trigger = (overrides: Partial<TriggerSummary> = {}): TriggerSummary => ({
  id: "t_9f2a1c3d04",
  kind: "schedule",
  name: "morning triage",
  enabled: true,
  schedule: {
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    nextDueAt: "2026-10-29T01:00:00.000Z",
  },
  counters: { fired: 12, dropped: 0, refused: 1 },
  lastFiredAt: "2026-10-28T01:00:03.114Z",
  ...overrides,
});

test("a triggers event round-trips with its counters and next instant", () => {
  const frame = encodeServerEvent({ type: "triggers", rev: 7, trace, triggers: [trigger()] });
  const decoded = decodeServerEvent(frame);
  assert.deepEqual(
    decoded.type === "triggers" ? decoded.triggers : undefined,
    [trigger()],
    "the wire keeps every field the sidebar renders",
  );
});

test("a skipped window and a webhook without a schedule survive the round trip", () => {
  const { schedule: _dropped, lastFiredAt: _never, ...base } = trigger();
  const webhook: TriggerSummary = {
    ...base,
    id: "t_7b1e55aa10",
    kind: "webhook",
    name: "deploy notify",
    enabled: false,
    lastSkipped: { at: "2026-10-27T00:00:00.000Z", reason: "queue_full" },
  };
  const frame = encodeServerEvent({ type: "triggers", rev: 8, trace, triggers: [webhook] });
  assert.deepEqual(decodeServerEvent(frame), {
    type: "triggers",
    rev: 8,
    trace,
    triggers: [webhook],
  });
});

test("a snapshot carries the same list, so a fresh subscriber needs no second request", () => {
  const frame = encodeServerEvent({
    type: "snapshot",
    rev: 9,
    trace,
    value: {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
      triggers: [trigger()],
    },
  });
  const decoded = decodeServerEvent(frame);
  assert.deepEqual(decoded.type === "snapshot" ? decoded.value.triggers : undefined, [trigger()]);
  const bare = decodeServerEvent(
    encodeServerEvent({
      type: "snapshot",
      rev: 10,
      trace,
      value: {
        botId: "b_1",
        messages: [],
        streaming: null,
        pending: [],
        inbox: [],
        running: false,
      },
    }),
  );
  assert.equal(
    bare.type === "snapshot" && "triggers" in bare.value,
    false,
    "a daemon without trigger storage omits the field instead of inventing an empty list",
  );
});

test("an unknown trigger kind or skip reason is refused", () => {
  for (const payload of [
    { ...trigger(), kind: "cron" },
    { ...trigger(), lastSkipped: { at: "x", reason: "later" } },
    { ...trigger(), counters: { fired: "12", dropped: 0, refused: 0 } },
  ]) {
    assert.throws(() =>
      decodeServerEvent({
        type: "triggers",
        rev: 1,
        trace,
        triggers: [payload],
      }),
    );
  }
});

test("eight worst-case triggers fit the page and the frame budget", () => {
  const worst = Array.from({ length: 8 }, (_unused, index) =>
    trigger({
      id: `t_${String(index).padStart(10, "a")}`,
      name: "n".repeat(64),
      schedule: { cron: "* ".repeat(31) + "*", timezone: "America/Argentina/ComodRivadavia" },
      counters: { fired: 999_999, dropped: 999_999, refused: 999_999 },
    }),
  );
  const frame = encodeServerEvent({ type: "triggers", rev: 1, trace, triggers: worst });
  const bytes = assertFrameBudget(frame);
  assert.ok(bytes < PAGE_MAX_BYTES, `${bytes} bytes stay inside the page budget`);
});
