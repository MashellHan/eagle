// docs/bots/TRIGGERS.md §6: a user message carries who admitted it, the label survives a
// restart, and all four render paths agree. Nothing here invents an origin: a message the
// daemon never admitted stays unlabeled, which a client shows as `unknown`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandError, ConversationService } from "../../src/core/ConversationService.ts";
import type { ConversationSnapshot, Message, Submission } from "../../src/core/domain.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import type { InvocationOrigin } from "../../src/core/Invocation.ts";
import { MAX_ORIGIN_RECORDS, OriginStore, originPath } from "../../src/core/OriginStore.ts";
import type {
  RuntimeBotSpec,
  RuntimeEvent,
  RuntimeHandle,
  RuntimePort,
  SubmitInput,
} from "../../src/core/RuntimePort.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";
const botId = "b_1";

const utf8 = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const user = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  state: "complete",
  createdAt: "2026-10-28T00:00:00.000Z",
  blocks: [{ type: "text", text: id }],
  ...extra,
});

/**
 * A runtime whose submit commits one user entry plus its submission record, and whose
 * history reads back whatever was committed, so the three render paths can be compared.
 */
const committedRuntime = () => {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const committed: Message[] = [];
  const records = new Map<string, Submission>();
  let nextEntry = 0;
  const runtime: RuntimePort = {
    async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
      const snapshot: ConversationSnapshot = {
        botId: spec.id,
        messages: [],
        pending: [],
        inbox: [],
        running: false,
        streaming: null,
      };
      return {
        refreshTools: async () => {},
        subscribe: async (_trace, next) => {
          sink = next;
          return { snapshot, detach: () => undefined };
        },
        submit: async (input: SubmitInput) => {
          nextEntry += 1;
          const entryId = `e_${nextEntry}`;
          // The adapter attaches the request id to a user entry from the same batch's
          // submission record (`EventMapper.prime`), so the live append can be labelled.
          const message = user(entryId, { requestId: input.requestId });
          committed.push(message);
          const record: Submission = {
            id: `s_${nextEntry}`,
            requestId: input.requestId,
            status: "done",
            entryId,
            answerEntryId: `e_${nextEntry + 1}`,
          };
          records.set(input.requestId, record);
          // The real order: the entry is published before the record that names its send.
          sink?.({ type: "append", trace: input.trace, message });
          sink?.({ type: "submission", trace: input.trace, record });
          return record;
        },
        submission: async (key) => ("requestId" in key ? records.get(key.requestId) : undefined),
        history: async (input) => ({
          messages: committed.slice(0, input.limit),
          hasMore: false,
        }),
        abort: async () => {},
        recover: async () => {},
        busy: async () => ({ run: false, tasks: false }),
        close: async () => "closed",
      };
    },
  };
  return runtime;
};

const withStore = async (
  dir: string,
  runtime: RuntimePort,
  path = originPath(join(dir, "bot")),
) => {
  const stores: OriginStore[] = [];
  const service = new ConversationService({
    open: (id, openTrace) =>
      runtime.open({
        id,
        dir: `/tmp/${id}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      }),
    measure: utf8,
    origins: {
      store: async () => {
        const store = await OriginStore.open(path);
        stores.push(store);
        return store;
      },
    },
  });
  return { service, stores };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

const human = async (service: ConversationService, id = requestId) =>
  service.send("c_1", { requestId: id, text: "hello", whenBusy: "followUp", trace });

const subscribe = async (service: ConversationService, received: HubEvent[]) =>
  service.subscribe("c_1", botId, trace, (event) => received.push(event));

test("the store records, backfills and survives a reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const path = originPath(join(dir, "bot"));
    const store = await OriginStore.open(path);
    await store.record({ requestId, origin: { kind: "webhook", triggerId: "t_9f2a1c3d04" } });
    assert.deepEqual(
      store.originOf({ id: "e_1", requestId }),
      { kind: "webhook", triggerId: "t_9f2a1c3d04" },
      "a live message resolves by request id before its entry exists",
    );
    await store.backfill({ requestId, entryId: "e_1" });
    assert.deepEqual(store.originOf({ id: "e_1" }), {
      kind: "webhook",
      triggerId: "t_9f2a1c3d04",
    });

    const reopened = await OriginStore.open(path);
    assert.deepEqual(
      reopened.originOf({ id: "e_1" }),
      { kind: "webhook", triggerId: "t_9f2a1c3d04" },
      "the entry id is what survives a restart",
    );
    assert.equal(reopened.originOf({ id: "e_2" }), undefined, "an unrecorded entry is unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed line is dropped and counted, and the cap keeps the newest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const path = originPath(join(dir, "bot"));
    const store = await OriginStore.open(path);
    await store.record({ requestId: "r_keep_0001", origin: { kind: "human" } });
    await store.backfill({ requestId: "r_keep_0001", entryId: "e_keep" });
    await writeFile(path, '{"requestId":"r_bad_0001","origin":{"kind":"nope"}}\n{not json\n', {
      flag: "a",
    });
    const reopened = await OriginStore.open(path);
    assert.equal(reopened.dropped, 2, "both unreadable lines are reported, not fatal");
    assert.deepEqual(reopened.originOf({ id: "e_keep" }), { kind: "human" });
    assert.equal(MAX_ORIGIN_RECORDS, 20_000, "the documented cap");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every render path carries the same origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const { service } = await withStore(dir, committedRuntime());
    const received: HubEvent[] = [];
    await subscribe(service, received);

    await service.invoke({
      botId,
      requestId,
      text: "from the webhook",
      origin: { kind: "webhook", triggerId: "t_9f2a1c3d04" },
      trace,
    });
    await flush();

    // 1. the live append, published before its entry id exists
    const live = received.find((event) => event.type === "append" && event.message.role === "user");
    assert.deepEqual(
      live?.type === "append" ? live.message.origin : undefined,
      { kind: "webhook", triggerId: "t_9f2a1c3d04" },
      "a commit arrives labelled, resolved by request id",
    );

    // 2. history, which reads entries directly
    const history = await service.history("c_1", { limit: 10 }, trace);
    assert.deepEqual(
      history.messages.map((message) => message.origin),
      [{ kind: "webhook", triggerId: "t_9f2a1c3d04" }],
    );

    // 3. a later subscriber's baseline, and 4. a resync, both from the folded view
    const second: HubEvent[] = [];
    const joined = await service.subscribe("c_2", botId, trace, (event) => second.push(event));
    service.resync("c_2", trace);
    const baseline = joined.snapshot.messages.map((message) => message.origin);
    const resynced =
      second.filter((event) => event.type === "snapshot").at(-1)?.type === "snapshot"
        ? (
            second.filter((event) => event.type === "snapshot").at(-1) as Extract<
              HubEvent,
              { type: "snapshot" }
            >
          ).value.messages.map((message) => message.origin)
        : undefined;
    assert.deepEqual(baseline, [{ kind: "webhook", triggerId: "t_9f2a1c3d04" }]);
    assert.deepEqual(resynced, baseline, "a resync renders the same labels");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the label survives a restart because it is keyed by entry id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const first = await withStore(dir, committedRuntime());
    await first.service.invoke({
      botId,
      requestId,
      text: "before the restart",
      origin: { kind: "peer", fromBotId: "b_other" },
      trace,
    });
    await flush();

    // A new process: fresh runtime (whose attach snapshot is empty), fresh store object.
    const second = await withStore(dir, committedRuntime());
    await second.service.subscribe("c_1", botId, trace, () => {});
    const history = await second.service.history("c_1", { limit: 10 }, trace);
    assert.equal(history.messages.length, 0, "a fresh conversation has no rows, only the file");
    const reopened = await OriginStore.open(originPath(join(dir, "bot")));
    assert.deepEqual(reopened.originOf({ id: "e_1" }), { kind: "peer", fromBotId: "b_other" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a human admission is labelled human, not left to be guessed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const { service } = await withStore(dir, committedRuntime());
    await service.subscribe("c_1", botId, trace, () => {});
    await human(service);
    await flush();
    const history = await service.history("c_1", { limit: 10 }, trace);
    assert.deepEqual(history.messages[0]?.origin, { kind: "human" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an origin that cannot be written refuses the admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const path = originPath(join(dir, "bot"));
    const { service } = await withStore(dir, committedRuntime(), path);
    await service.subscribe("c_1", botId, trace, () => {});
    // The store opened when its file was missing; now the directory itself is a file, so
    // the write-ahead append cannot land.
    await writeFile(join(dir, "bot"), "not a directory");
    await assert.rejects(
      () =>
        service.invoke({
          botId,
          requestId: "r_nowrite_01",
          text: "unlabelable",
          origin: { kind: "webhook", triggerId: "t_9f2a1c3d04" },
          trace,
        }),
      (error: unknown) =>
        error instanceof CommandError &&
        error.kind === "storage_failed" &&
        error.disposition === "runtime",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a message the daemon never admitted stays unlabelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const { service } = await withStore(dir, committedRuntime());
    const store = await OriginStore.open(originPath(join(dir, "bot")));
    const origin: InvocationOrigin = { kind: "human" };
    await store.record({ requestId: "r_known_0001", origin });
    const page = await service
      .subscribe("c_1", botId, trace, () => {})
      .then(() => service.history("c_1", { limit: 10 }, trace));
    assert.deepEqual(page.messages, [], "nothing was committed");
    assert.equal(
      store.originOf({ id: "e_absent" }),
      undefined,
      "no record means unknown, never human",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a backfill without a recorded origin writes nothing and stays unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const store = await OriginStore.open(originPath(join(dir, "bot")));
    await store.backfill({ requestId: "r_never_seen_1", entryId: "e_1" });
    assert.equal(store.originOf({ id: "e_1" }), undefined);
    const reopened = await OriginStore.open(originPath(join(dir, "bot")));
    assert.equal(reopened.originOf({ id: "e_1" }), undefined, "nothing was appended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file past the cap is trimmed on open, keeping the newest records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-origin-"));
  try {
    const path = originPath(join(dir, "bot"));
    await mkdir(join(dir, "bot"), { recursive: true });
    const lines: string[] = [];
    for (let index = 0; index < MAX_ORIGIN_RECORDS + 5; index += 1) {
      lines.push(
        JSON.stringify({
          requestId: `r_cap_${String(index).padStart(6, "0")}`,
          entryId: `e_${index}`,
          origin: { kind: "human" },
        }),
      );
    }
    await writeFile(path, `${lines.join("\n")}\n`);
    const store = await OriginStore.open(path);
    assert.equal(store.dropped, 0, "well-formed lines are not losses");
    assert.equal(store.originOf({ id: "e_0" }), undefined, "the oldest fell off the cap");
    assert.deepEqual(
      store.originOf({ id: `e_${MAX_ORIGIN_RECORDS + 4}` }),
      { kind: "human" },
      "the newest survived",
    );
    const rewritten = await OriginStore.open(path);
    assert.equal(rewritten.dropped, 0, "the rewritten file is still readable");
    assert.equal(store.originOf({ id: "e_4" }), undefined, "the trimmed records stay trimmed");
    assert.deepEqual(store.originOf({ id: "e_5" }), { kind: "human" }, "the kept ones stay kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
