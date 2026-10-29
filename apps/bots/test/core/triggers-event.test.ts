// docs/bots/TRIGGERS.md §8.2: a bot-scoped `triggers` list, whole-list replacement, and the
// same list on the baseline a fresh subscriber sees.
import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../../src/core/ConversationService.ts";
import type { ConversationSnapshot, TriggerSummary } from "../../src/core/domain.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import type { RuntimeEvent, RuntimeHandle, RuntimePort } from "../../src/core/RuntimePort.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const botId = "b_1";

const utf8 = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const trigger = (overrides: Partial<TriggerSummary> = {}): TriggerSummary => ({
  id: "t_9f2a1c3d04",
  kind: "schedule",
  name: "morning triage",
  enabled: true,
  schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
  counters: { fired: 0, dropped: 0, refused: 0 },
  ...overrides,
});

const runtime = () => {
  const snapshot: ConversationSnapshot = {
    botId,
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const port: RuntimePort = {
    async open(): Promise<RuntimeHandle> {
      return {
        refreshTools: async () => {},
        subscribe: async () => ({ snapshot, detach: () => undefined }),
        submit: async (input) => ({
          id: "s_1",
          requestId: input.requestId,
          status: "queued",
        }),
        submission: async () => undefined,
        history: async () => ({ messages: [], hasMore: false }),
        abort: async () => {},
        recover: async () => {},
        busy: async () => ({ run: false, tasks: false }),
        close: async () => "closed",
      };
    },
  };
  return port;
};

const serviceWith = (initial: readonly TriggerSummary[] | undefined) =>
  new ConversationService({
    open: (id, openTrace) =>
      runtime().open({
        id,
        dir: `/tmp/${id}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      }),
    measure: utf8,
    ...(initial === undefined ? {} : { triggersOf: { list: async () => initial } }),
  });

test("the baseline carries the bot's triggers, and an edit replaces the whole list", async () => {
  const service = serviceWith([trigger()]);
  const received: HubEvent[] = [];
  const joined = await service.subscribe("c_1", botId, trace, (event) => received.push(event));
  assert.deepEqual(joined.snapshot.triggers, [trigger()], "the first frame needs no extra request");

  service.publishTriggers(
    botId,
    [trigger({ enabled: false, counters: { fired: 3, dropped: 1, refused: 0 } })],
    trace,
  );
  const event = received.find((entry) => entry.type === "triggers");
  assert.deepEqual(
    event?.type === "triggers" ? event.triggers : undefined,
    [trigger({ enabled: false, counters: { fired: 3, dropped: 1, refused: 0 } })],
    "the event is a whole-list replacement",
  );
  assert.equal(event?.rev, joined.rev + 1, "it takes the next revision");

  const later: HubEvent[] = [];
  const second = await service.subscribe("c_2", botId, trace, (entry) => later.push(entry));
  assert.deepEqual(
    second.snapshot.triggers?.[0]?.enabled,
    false,
    "a later subscriber starts from the current list",
  );
});

test("a bot with no trigger storage omits the list instead of inventing one", async () => {
  const service = serviceWith(undefined);
  const joined = await service.subscribe("c_1", botId, trace, () => {});
  assert.equal("triggers" in joined.snapshot, false);
});
