// PROTOCOL.md v1, additive: the pull requests a bot reported, on the snapshot and as an event.
// A client that predates it simply never sees them, and nothing else changes shape.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, PullSummary } from "../../src/core/domain.ts";
import { encodeServerEvent, encodeSnapshot } from "../../src/protocol/encode.ts";
import { decodeServerEvent } from "../../src/protocol/frames.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const pull = (overrides: Partial<PullSummary> = {}): PullSummary => ({
  url: "https://github.com/nocoo/eagle/pull/490",
  title: "deps: 依赖升级到 2.4.0",
  status: "merged",
  host: "github.com",
  updatedAt: "2026-10-30T10:00:00.000Z",
  ...overrides,
});

test("a pulls event round-trips with the link, the state and the forge", () => {
  const frame = encodeServerEvent({
    type: "pulls",
    rev: 9,
    trace,
    pulls: [
      pull(),
      pull({
        url: "https://dev.azure.com/x/_git/y/pullrequest/12",
        host: "dev.azure.com",
        status: "reviewing",
      }),
    ],
  });
  const decoded = decodeServerEvent(frame);
  assert.equal(decoded.type, "pulls");
  assert.deepEqual(decoded.type === "pulls" ? decoded.pulls : undefined, [
    pull(),
    pull({
      url: "https://dev.azure.com/x/_git/y/pullrequest/12",
      host: "dev.azure.com",
      status: "reviewing",
    }),
  ]);
});

test("the snapshot carries the reported rows, and a client that predates them sees none", () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_01" as never,
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
    tasks: [],
    triggers: [],
    pulls: [pull()],
  };
  const wire = encodeSnapshot(snapshot) as unknown as Record<string, unknown>;
  assert.deepEqual(wire.pulls, [pull()]);

  const legacy = { ...snapshot, pulls: undefined };
  const encoded = encodeSnapshot(legacy as unknown as ConversationSnapshot) as unknown as Record<
    string,
    unknown
  >;
  assert.equal("pulls" in encoded, false, "absent means the daemon reports none");
});
