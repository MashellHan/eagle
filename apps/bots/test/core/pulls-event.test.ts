// The reported pull requests reach a client as a snapshot field and as a whole-list event
// (PROTOCOL.md v1, additive): the App never asks a forge, so these frames are the only source.
import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../../src/core/ConversationService.ts";
import type { PullSummary } from "../../src/core/domain.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { createBench } from "../support/pi.ts";

const botId = "b_01";
const trace = "tr_01a1b2c3-4d5e-7f60-8a1b-2c3d4e5f6071";

const pull = (overrides: Partial<PullSummary> = {}): PullSummary => ({
  url: "https://github.com/nocoo/eagle/pull/490",
  title: "deps: 依赖升级到 2.4.0",
  status: "open",
  host: "github.com",
  updatedAt: "2026-10-30T10:00:00.000Z",
  ...overrides,
});

const serviceWith = async (initial: readonly PullSummary[] | undefined) => {
  const bench = await createBench();
  return {
    bench,
    service: new ConversationService({
      open: (id, openTrace) =>
        bench.runtime.open({
          id,
          dir: `/tmp/${id}`,
          model: { provider: "faux", modelId: "faux-1" },
          trace: openTrace,
        }),
      measure: (event: RuntimeEvent) => Buffer.byteLength(JSON.stringify(event), "utf8"),
      ...(initial === undefined ? {} : { pullsOf: { list: async () => initial } }),
    }),
  };
};

test("the baseline carries the reported pull requests, and a report replaces the list", async () => {
  const { bench, service } = await serviceWith([pull()]);
  try {
    const received: HubEvent[] = [];
    const joined = await service.subscribe("c_1", botId, trace, (event) => received.push(event));
    assert.deepEqual(joined.snapshot.pulls, [pull()]);

    const merged = pull({ status: "merged" });
    service.publishPulls(botId, [merged], trace);
    const event = received.find((entry) => entry.type === "pulls");
    assert.deepEqual(
      event?.type === "pulls" ? event.pulls : undefined,
      [merged],
      "the event is a whole-list replacement",
    );
    assert.equal(event?.rev, joined.rev + 1);

    const later = await service.subscribe("c_2", botId, trace, () => {});
    assert.equal(later.snapshot.pulls?.[0]?.status, "merged", "a later subscriber starts current");
  } finally {
    await bench.cleanup();
  }
});

test("a bot with no report storage omits the list instead of inventing one", async () => {
  const { bench, service } = await serviceWith(undefined);
  try {
    const joined = await service.subscribe("c_1", botId, trace, () => {});
    assert.equal("pulls" in joined.snapshot, false);
  } finally {
    await bench.cleanup();
  }
});
