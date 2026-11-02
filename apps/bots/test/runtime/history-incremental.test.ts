import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { pageHead } from "../../src/runtime/pi/historyIncremental.ts";
import { NativeHistory } from "../../src/runtime/pi/NativeHistory.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";

test("SDK ownerless ownership alone cannot distinguish the root from a passive import fork", async () => {
  const bench = await createBench();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(bench.dir, "ownership.sqlite")),
    { registry: createRegistry(), models: createModels() },
    ctx,
  );
  try {
    const root = await harness.root(ctx);
    const entry = await root.commit(
      (tx) => tx.appendEntry(root.id, { kind: "ownership.probe" }),
      ctx,
    );
    const fork = await harness.commit(
      (tx) => tx.forkConversation(root.id, entry.id, { ownership: { kind: "ownerless" } }),
      ctx,
    );
    const records = await harness.commit(
      async (tx) => [await tx.conversation(root.id), await tx.conversation(fork.id)],
      ctx,
    );
    assert.ok(records.every((record) => record !== undefined));
    assert.ok(records.every((record) => record?.owner === undefined));
  } finally {
    await harness.close(ctx);
    await bench.cleanup();
  }
});

for (const location of ["root", "continuation"] as const) {
  test(`received branch never appends into the local ${location} or changes its provider input`, async () => {
    const a = await createBench({ settings: { compaction: { enabled: false } } });
    const b = await createBench({ settings: { compaction: { enabled: false } } });
    const left = await a.runtime.open(a.spec());
    const right = await b.runtime.open(b.spec());
    try {
      a.faux.setResponses([text("common answer"), text("A local branch answer")]);
      await left.submit({
        requestId: "r_isolation_common",
        text: "common question",
        whenBusy: "followUp",
        trace,
      });
      await waitFor(
        async () => (await left.submission({ requestId: "r_isolation_common" }))?.status === "done",
        "common tail",
      );
      let ancestor = await left.exportHistoryPage();
      let selection: string | undefined;
      if (location === "continuation") {
        const branch = await left.continueHistory({
          head: ancestor.head,
          requestId: "r_isolation_local",
          text: "A local branch question",
        });
        selection = branch.branchId;
        ancestor = await left.exportHistoryPage({ selection });
      }
      const rootBefore = await left.history({ limit: 50 });
      await right.importHistoryPage(ancestor);
      b.faux.setResponses([text("FOREIGN B answer")]);
      const foreign = await right.continueHistory({
        head: ancestor.head,
        requestId: "r_isolation_foreign",
        text: "FOREIGN B question",
      });
      const page = await right.exportHistoryPage({ selection: foreign.branchId });
      await left.importHistoryPage(page);
      const unchanged = await left.exportHistoryPage(selection === undefined ? {} : { selection });
      assert.deepEqual(
        unchanged.records,
        ancestor.records,
        "incoming suffix must fork instead of appending to a live local container",
      );
      assert.deepEqual(await left.history({ limit: 50 }), rootBefore);
      assert.match(
        JSON.stringify((await left.readHistoryHead(page.head)).messages),
        /FOREIGN B answer/,
      );
      a.faux.setResponses([
        (context) => {
          assert.doesNotMatch(JSON.stringify(context.messages), /FOREIGN B/);
          assert.match(JSON.stringify(context.messages), /common answer/);
          return text("A local input unchanged");
        },
      ]);
      if (location === "root") {
        await left.submit({
          requestId: "r_isolation_next",
          text: "A next question",
          whenBusy: "followUp",
          trace,
        });
        await waitFor(
          async () => (await left.submission({ requestId: "r_isolation_next" }))?.status === "done",
          "A local provider",
        );
      } else {
        assert.equal(
          (
            await left.continueHistory({
              head: unchanged.head,
              requestId: "r_isolation_next",
              text: "A next question",
            })
          ).submission.status,
          "done",
        );
      }
      a.faux.setResponses([
        (context) => {
          assert.match(JSON.stringify(context.messages), /FOREIGN B answer/);
          return text("explicitly selected foreign branch");
        },
      ]);
      assert.equal(
        (
          await left.continueHistory({
            head: page.head,
            requestId: "r_isolation_explicit",
            text: "explicit branch selection",
          })
        ).submission.status,
        "done",
      );
      const db = new DatabaseSync(join(a.spec().dir, "session.sqlite"), { readOnly: true });
      try {
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS n FROM entries WHERE json_extract(record, '$.kind') = 'pi.user' AND json_extract(record, '$.model[0].content') = 'common question'",
            )
            .get()?.n,
          1,
          "the safe fork physically shares its ancestor",
        );
      } finally {
        db.close();
      }
    } finally {
      await left.close(trace, 5_000);
      await right.close(trace, 5_000);
      await a.cleanup();
      await b.cleanup();
    }
  });
}

test("a throwing optional observer cannot break ordinary chat and detaches normally", async () => {
  const bench = await createBench();
  const bot = await bench.runtime.open(bench.spec());
  let notices = 0;
  const detach = bot.observeHistoryChanges(() => {
    notices += 1;
    throw new Error("optional sync is broken");
  });
  try {
    bench.faux.setResponses([
      text("first answer"),
      text("chat still works"),
      text("detached answer"),
    ]);
    await bot.submit({ requestId: "r_observer_first", text: "first", whenBusy: "followUp", trace });
    await waitFor(
      async () => (await bot.submission({ requestId: "r_observer_first" }))?.status === "done",
      "first answer",
    );
    await waitFor(() => notices > 0, "throwing observer ran");
    await bot.submit({
      requestId: "r_observer_second",
      text: "second",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await bot.submission({ requestId: "r_observer_second" }))?.status === "done",
      "chat after observer failure",
    );
    detach();
    const detached = notices;
    await bot.submit({
      requestId: "r_observer_detached",
      text: "third",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await bot.submission({ requestId: "r_observer_detached" }))?.status === "done",
      "chat after detach",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(notices, detached);
  } finally {
    detach();
    await bot.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("the bounded branch directory exports received and concurrent local continuations with shared IDs", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  try {
    a.faux.setResponses([text("common ancestor"), text("A concurrent answer")]);
    await left.submit({
      requestId: "r_branch_source",
      text: "shared question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_branch_source" }))?.status === "done",
      "source",
    );
    const ancestor = await left.exportHistoryPage();
    await right.importHistoryPage(ancestor);
    b.faux.setResponses([text("B concurrent answer")]);
    const branchB = await right.continueHistory({
      head: ancestor.head,
      requestId: "r_branch_b",
      text: "B question",
    });
    const branchA = await left.continueHistory({
      head: ancestor.head,
      requestId: "r_branch_a",
      text: "A question",
    });
    const pageA = await left.exportHistoryPage({ selection: branchA.branchId });
    const pageB = await right.exportHistoryPage({ selection: branchB.branchId });
    await right.importHistoryPage(pageA);
    await left.importHistoryPage(pageB);
    const branches = await right.listHistoryBranches({ limit: 32 });
    for (const id of [ancestor.branchId, branchA.branchId, branchB.branchId])
      assert.ok(branches.branches.some((branch) => branch.branchId === id));
    const remote = branches.branches.find((branch) => branch.branchId === branchA.branchId);
    assert.ok(remote);
    const forwarded = await right.exportHistoryPage({ selection: remote.selection });
    assert.equal(forwarded.branchId, pageA.branchId);
    assert.deepEqual(
      forwarded.records,
      pageA.records,
      "forwarded provenance and ancestry stay exact",
    );
    assert.deepEqual(pageA.records.slice(0, ancestor.records.length), ancestor.records);
    assert.deepEqual(pageB.records.slice(0, ancestor.records.length), ancestor.records);
    await right.importHistory(await left.exportHistory(branchA.branchId));
    const db = new DatabaseSync(join(b.spec().dir, "session.sqlite"), { readOnly: true });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM entries WHERE json_extract(record, '$.kind') = 'pi.user'",
          )
          .get()?.n,
        3,
        "shared user ancestry is physically deduplicated across both branches",
      );
    } finally {
      db.close();
    }
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    assert.deepEqual(await right.listHistoryBranches({ limit: 32 }), branches);
    assert.deepEqual(
      await right.continueHistory({
        head: ancestor.head,
        requestId: "r_branch_b",
        text: "B question",
      }),
      branchB,
    );
    assert.deepEqual((await right.history({ limit: 50 })).messages, []);
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("incremental native import preserves real tool results passively and refuses broken raw/effective contexts", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  try {
    a.faux.setResponses([
      assistant(
        [toolCall("write", { path: "native-proof.txt", content: "from A" }, { id: "call_1" })],
        { stopReason: "toolUse" },
      ),
      assistant([toolCall("list", {}, { id: "call_1" })], { stopReason: "toolUse" }),
      text("completed real tool groups"),
    ]);
    await left.submit({
      requestId: "r_native_tools",
      text: "write and list",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_native_tools" }))?.status === "done",
      "tool groups",
    );
    assert.equal(
      await readFile(join(a.spec().dir, "workspace/native-proof.txt"), "utf8"),
      "from A",
    );
    const page = await left.exportHistoryPage();
    const results = page.records
      .flatMap((record) => record.entry.model ?? [])
      .filter((item) => item.role === "toolResult");
    assert.equal(results.length, 2);
    let calls = 0;
    b.faux.setResponses([
      () => {
        calls += 1;
        return text("unexpected passive run");
      },
    ]);
    const archive = await left.exportHistory();
    await right.importHistory(archive);
    await right.importHistoryPage(page);
    await right.importHistoryPage(page);
    const db = new DatabaseSync(join(b.spec().dir, "session.sqlite"), { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM entries").get()?.n,
        page.records.length,
        "archive and incremental imports deduplicate the same native records",
      );
    } finally {
      db.close();
    }
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    assert.equal(calls, 0);
    await assert.rejects(access(join(b.spec().dir, "workspace/native-proof.txt")), {
      code: "ENOENT",
    });
    b.faux.setResponses([
      (context) => {
        calls += 1;
        assert.deepEqual(
          context.messages.filter((item) => item.role === "toolResult"),
          results,
        );
        return text("B local tools and model");
      },
    ]);
    const result = await right.continueHistory({
      head: page.head,
      requestId: "r_native_tools_b",
      text: "continue",
    });
    assert.equal(result.submission.status, "done");
    assert.equal(calls, 1);
    for (const damage of [
      "missing raw result",
      "duplicate edited call",
      "omit final answer",
      "missing edit reference",
    ] as const) {
      const target = await createBench();
      const receiver = await target.runtime.open(target.spec());
      try {
        const broken = structuredClone(page);
        if (damage === "missing raw result") {
          broken.records = broken.records.filter(
            (record) => !record.entry.model?.some((item) => item.role === "toolResult"),
          );
          for (const [index, record] of broken.records.entries())
            record.previous = broken.records[index - 1]?.entry.id ?? null;
        } else {
          const caller = broken.records.find((record) =>
            record.entry.model?.some(
              (item) => item.role === "assistant" && item.stopReason === "toolUse",
            ),
          );
          const answer = broken.records.findLast((record) => record.entry.kind === "pi.assistant");
          assert.ok(caller && answer);
          const replacement = structuredClone(caller.entry.model ?? []);
          const model = replacement.find((item) => item.role === "assistant");
          assert.ok(model?.role === "assistant" && model.content[0]);
          model.content.push(model.content[0]);
          const id = `${answer.entry.originId}/e999999`;
          broken.records.push({
            previous: broken.tip,
            entry: {
              id,
              originId: answer.entry.originId,
              conversationId: answer.entry.conversationId,
              kind: "test.edit",
              edits:
                damage === "duplicate edited call"
                  ? [{ target: caller.entry.id, action: "replace", messages: replacement }]
                  : [
                      {
                        target:
                          damage === "missing edit reference"
                            ? `${answer.entry.originId}/e999998`
                            : answer.entry.id,
                        action: "omit",
                      },
                    ],
            },
          });
          broken.tip = id;
          broken.head = pageHead(broken.branchId, broken.tip);
        }
        if (damage === "missing edit reference")
          await assert.rejects(receiver.importHistoryPage(broken), /reference/);
        else {
          await receiver.importHistoryPage(broken);
          assert.equal((await receiver.assessHistoryHead(broken.head)).usable, false, damage);
          await assert.rejects(
            receiver.continueHistory({
              head: broken.head,
              requestId: "r_invalid_incremental",
              text: "must not run",
            }),
          );
        }
      } finally {
        await receiver.close(trace, 5_000);
        await target.cleanup();
      }
    }
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("large missing-ancestry tails are visible with bounded reads while backfill and usability remain separate", async () => {
  let reads = 0;
  const b = await createBench({
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      return new Proxy(storage, {
        get(target, property) {
          if (property === "scanEntries")
            return (...args: Parameters<typeof storage.scanEntries>) => {
              reads += 1;
              return target.scanEntries(...args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  const sourceStorage = await openNodeSqliteStorage(join(b.dir, "source.sqlite"));
  const scans: number[] = [];
  const source = await Harness.open(
    new Proxy(sourceStorage, {
      get(target, property) {
        if (property === "scanEntries")
          return (...args: Parameters<typeof sourceStorage.scanEntries>) => {
            scans.push(args[1]);
            return target.scanEntries(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    { registry: createRegistry(), models: createModels() },
    ctx,
  );
  const root = await source.root(ctx);
  const feed = new NativeHistory(source, root.id, "b_large");
  const right = await b.runtime.open(b.spec());
  try {
    for (let turn = 0; turn < 24; turn += 1)
      await source.commit(async (tx) => {
        await tx.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `old user ${turn}`, timestamp: turn }],
        });
        await tx.appendEntry(root.id, {
          kind: "pi.assistant",
          model: [text(`old answer ${turn} ${"x".repeat(16_000)}`)],
        });
      }, ctx);
    const initial = await feed.exportPage();
    assert.ok(initial.hasMore, "history exceeds both a single page and the old archive cap");
    assert.ok(initial.snapshot && initial.cursor);
    assert.match(JSON.stringify(initial.records), /old answer 23/);
    assert.ok(Buffer.byteLength(JSON.stringify(initial)) <= 128 * 1024);
    await right.importHistoryPage(initial);
    reads = 0;
    const view = await right.readHistoryHead(initial.head);
    assert.equal(reads, 0, "latest view never assembles context or scans the branch");
    assert.match(JSON.stringify(view.messages), /old answer 23/);
    assert.equal(view.usable, false);
    assert.equal((await right.assessHistoryHead(initial.head)).usable, false);
    await assert.rejects(
      right.continueHistory({
        head: initial.head,
        requestId: "r_missing_ancestor",
        text: "cannot continue",
      }),
    );
    await source.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "NEW USER before backfill", timestamp: 100 }],
        }),
      ctx,
    );
    scans.length = 0;
    const fresh = await feed.exportPage({ after: initial.snapshot, limit: 1 });
    assert.ok(
      scans.reduce((sum, limit) => sum + limit, 0) <= 4,
      "new tail scans stay bounded independently of old history",
    );
    assert.equal(fresh.records.length, 1);
    assert.match(JSON.stringify(fresh.records), /NEW USER before backfill/);
    assert.doesNotMatch(JSON.stringify(fresh.records), /old answer/);
    const fixed = await feed.exportPage({ selection: initial.head });
    assert.equal(fixed.tip, initial.tip, "head selections never advance with later native commits");
    assert.doesNotMatch(JSON.stringify(fixed.records), /NEW USER/);
    await right.importHistoryPage(fresh);
    reads = 0;
    const newest = await right.readHistoryHead(fresh.head);
    assert.equal(reads, 0);
    assert.match(JSON.stringify(newest.messages), /NEW USER before backfill/);
    assert.equal(newest.usable, false);
    let page = initial;
    let total = Buffer.byteLength(JSON.stringify(page));
    while (page.hasMore) {
      assert.ok(page.cursor);
      page = await feed.exportPage({
        before: page.cursor,
        until: initial.snapshot,
        limit: 8,
        maxBytes: 64 * 1024,
      });
      total += Buffer.byteLength(JSON.stringify(page));
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024);
      const receipt = await right.importHistoryPage(page);
      for (let drain = receipt.pending; drain; )
        drain = (await right.importHistoryPage({ ...page, records: [] })).pending;
    }
    assert.ok(total > 240 * 1024);
    assert.equal(
      (await right.assessHistoryHead(initial.head)).usable,
      true,
      "backfill completes the immutable old head",
    );
    reads = 0;
    assert.equal((await right.readHistoryHead(initial.head)).usable, true);
    assert.equal(reads, 0, "even a fully materialized branch has a bounded, scan-free latest view");
    assert.equal(
      (await right.assessHistoryHead(fresh.head)).usable,
      false,
      "the newest unanswered user remains unselectable",
    );
  } finally {
    await source.close(ctx);
    await right.close(trace, 5_000);
    await b.cleanup();
  }
});

test("committed user is incrementally readable before a slow provider and only a complete head continues", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let notices = 0;
  let detach: (() => void) | undefined;
  try {
    assert.equal(typeof left.observeHistoryChanges, "function", "history observation is explicit");
    detach = left.observeHistoryChanges(() => {
      notices += 1;
    });
    a.faux.setResponses([
      async () => {
        await blocked;
        return text("A durably finished");
      },
    ]);
    await left.submit({
      requestId: "r_slow_feed",
      text: "committed before the model",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => notices > 0, "native commit notice");
    const partial = await left.exportHistoryPage({ limit: 32, maxBytes: 128 * 1024 });
    assert.ok(Buffer.byteLength(JSON.stringify(partial)) <= 128 * 1024);
    assert.match(JSON.stringify(partial.records), /committed before the model/);
    await right.importHistoryPage(partial);
    let view = await right.readHistoryHead(partial.head);
    assert.match(JSON.stringify(view.messages), /committed before the model/);
    assert.equal(view.usable, false);
    await assert.rejects(
      right.continueHistory({ head: partial.head, requestId: "r_not_usable", text: "premature" }),
    );
    assert.deepEqual((await right.history({ limit: 50 })).messages, []);
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    await right.importHistoryPage(partial);
    view = await right.readHistoryHead(partial.head);
    assert.equal(view.usable, false);
    release();
    await waitFor(
      async () => (await left.submission({ requestId: "r_slow_feed" }))?.status === "done",
      "source answer",
    );
    assert.ok(partial.cursor);
    const delta = await left.exportHistoryPage({ after: partial.cursor });
    assert.ok(delta.records.length > 0);
    assert.doesNotMatch(JSON.stringify(delta.records), /committed before the model/);
    await right.importHistoryPage(delta);
    assert.equal((await right.assessHistoryHead(delta.head)).usable, true);
    view = await right.readHistoryHead(delta.head);
    assert.equal(view.usable, true);
    b.faux.setResponses([
      (context) => {
        calls += 1;
        assert.match(JSON.stringify(context.messages), /committed before the model/);
        assert.match(JSON.stringify(context.messages), /A durably finished/);
        return text("B really continued");
      },
    ]);
    const continued = await right.continueHistory({
      head: delta.head,
      requestId: "r_feed_continue",
      text: "B local continuation",
    });
    assert.equal(continued.submission.status, "done");
    assert.equal(calls, 1);
  } finally {
    release();
    detach?.();
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});
