// The trigger tools (docs/bots/EXTENSIONS-AND-TOOLS.md §6.3): the Bot manages its own
// definitions, every mutation carries the durable tool-task id, and a refusal is a result
// the model can read rather than an exception.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TriggerStore, triggerJournalPath } from "../../src/core/TriggerStore.ts";
import {
  createTriggerTools,
  TRIGGER_TOOLS_EXTENSION,
  triggerSection,
} from "../../src/tools/trigger/tools.ts";
import type { TriggerToolHost, TriggerView } from "../../src/tools/types.ts";
import { triggerHost } from "../../src/triggers/host.ts";

const botId = "b_bot";

const trigger = (overrides: Partial<TriggerView> = {}): TriggerView => ({
  id: "t_abcd2ef3gh",
  kind: "schedule",
  name: "morning triage",
  prompt: "check the queue",
  enabled: true,
  schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
  counters: { fired: 2, dropped: 0, refused: 0 },
  ...overrides,
});

const recordingHost = (overrides: Partial<TriggerToolHost> = {}) => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const host: TriggerToolHost = {
    botId,
    async create(input) {
      calls.push({ name: "create", input });
      return { trigger: trigger({ name: input.name }), created: true };
    },
    async list() {
      calls.push({ name: "list", input: {} });
      return [trigger()];
    },
    async update(input) {
      calls.push({ name: "update", input });
      return trigger({ name: input.name ?? "morning triage" });
    },
    async enable(input) {
      calls.push({ name: "enable", input });
      return trigger({ enabled: input.enabled });
    },
    async remove(input) {
      calls.push({ name: "remove", input });
      return { triggerId: input.triggerId };
    },
    endpoint: (triggerId) => `/v1/triggers/${botId}/${triggerId}`,
    ...overrides,
  };
  return { host, calls };
};

/** The tool api only needs the durable task id, which is the operation id. */
const api = (taskId = "t_42") => ({ taskId }) as never;
const context = {} as never;

const tool = (host: TriggerToolHost, name: string) => {
  const found = createTriggerTools(host).find((registration) => registration.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
};

const textOf = (result: { output?: readonly { type: string; text?: string }[] }) =>
  (result.output ?? []).map((block) => block.text ?? "").join("\n");

test("create passes the model's input and the tool-task id, and reports what exists", async () => {
  const { host, calls } = recordingHost();
  const created = await tool(host, "trigger_create").execute(
    {
      kind: "schedule",
      name: "morning triage",
      prompt: "check the queue",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
    } as never,
    api(),
    context,
  );
  assert.deepEqual(calls[0]?.input, {
    opId: "t_42",
    kind: "schedule",
    name: "morning triage",
    prompt: "check the queue",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
  });
  assert.match(textOf(created as never), /^created: t_abcd2ef3gh · schedule · morning triage/);
  assert.match(textOf(created as never), /0 9 \* \* \* Asia\/Shanghai/);
  assert.equal((created as { isError?: boolean }).isError, undefined);
});

test("list renders one line per trigger and says so when there are none", async () => {
  const { host } = recordingHost({
    list: async () => [
      trigger(),
      {
        id: "t_wxyz234567",
        kind: "webhook",
        name: "deploy notify",
        prompt: "tell me about the deploy",
        enabled: true,
        counters: { fired: 0, dropped: 4, refused: 0 },
        lastSkipped: { at: "2026-10-28T00:00:00.000Z", reason: "disabled" },
      },
    ],
  });
  const listed = await tool(host, "trigger_list").execute({} as never, api(), context);
  const text = textOf(listed as never);
  assert.match(text, /t_abcd2ef3gh · schedule · morning triage · enabled/);
  assert.match(text, /t_wxyz234567 · webhook · deploy notify · enabled/);
  assert.match(text, /\/v1\/triggers\/b_bot\/t_wxyz234567/, "a webhook shows where it delivers");
  assert.match(text, /last skipped .* \(disabled\)/);

  const empty = recordingHost({ list: async () => [] });
  assert.equal(
    textOf((await tool(empty.host, "trigger_list").execute({} as never, api(), context)) as never),
    "no triggers",
  );
});

test("update, enable and delete carry the operation id and only their own fields", async () => {
  const { host, calls } = recordingHost();
  await tool(host, "trigger_update").execute(
    { triggerId: "t_abcd2ef3gh", name: "renamed" } as never,
    api("t_7"),
    context,
  );
  await tool(host, "trigger_enable").execute(
    { triggerId: "t_abcd2ef3gh", enabled: false } as never,
    api("t_8"),
    context,
  );
  await tool(host, "trigger_delete").execute(
    { triggerId: "t_abcd2ef3gh" } as never,
    api("t_9"),
    context,
  );
  assert.deepEqual(calls, [
    { name: "update", input: { opId: "t_7", triggerId: "t_abcd2ef3gh", name: "renamed" } },
    { name: "enable", input: { opId: "t_8", triggerId: "t_abcd2ef3gh", enabled: false } },
    { name: "remove", input: { opId: "t_9", triggerId: "t_abcd2ef3gh" } },
  ]);
});

test("a store refusal is a readable error result, not a failing run", async () => {
  const { host } = recordingHost({
    create: async () => {
      throw Object.assign(new Error("a bot holds at most 8 triggers"), {
        name: "TriggerStoreError",
      });
    },
    list: async () => {
      throw new Error("disk on fire");
    },
  });
  const refused = await tool(host, "trigger_create").execute(
    { kind: "webhook", name: "ninth", prompt: "x" } as never,
    api(),
    context,
  );
  assert.equal((refused as { isError?: boolean }).isError, true);
  assert.equal(textOf(refused as never), "a bot holds at most 8 triggers");

  const broken = await tool(host, "trigger_list").execute({} as never, api(), context);
  assert.equal((broken as { isError?: boolean }).isError, true);
  assert.equal(
    textOf(broken as never),
    "the trigger could not be changed",
    "an unexpected error never leaks its text",
  );
});

test("the prompt section names the limits a model has to respect", () => {
  const section = triggerSection(botId);
  assert.match(section, /At most eight triggers/);
  assert.match(section, /instruction to this bot, not a person's message/);
  assert.equal(TRIGGER_TOOLS_EXTENSION, "bots-trigger");
});

test("the real host over a real store satisfies the tool contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-trigger-tools-"));
  try {
    const store = await TriggerStore.open(botId, triggerJournalPath(join(dir, "bot")));
    const host: TriggerToolHost = triggerHost(botId, store);
    const created = await tool(host, "trigger_create").execute(
      { kind: "schedule", name: "nightly", prompt: "summarize", cron: "0 22 * * *" } as never,
      api("t_100"),
      context,
    );
    assert.match(textOf(created as never), /^created: t_/);
    const listed = textOf(
      (await tool(host, "trigger_list").execute({} as never, api(), context)) as never,
    );
    assert.match(listed, /nightly · enabled · 0 22 \* \* \*/);
    const disabled = textOf(
      (await tool(host, "trigger_enable").execute(
        { triggerId: store.list()[0]?.id as string, enabled: false } as never,
        api("t_101"),
        context,
      )) as never,
    );
    assert.match(disabled, /^disabled: /);
    const again = await tool(host, "trigger_enable").execute(
      { triggerId: store.list()[0]?.id as string, enabled: true } as never,
      api("t_101"),
      context,
    );
    assert.match(textOf(again as never), /^disabled: /, "a replayed op id answers as it did");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
