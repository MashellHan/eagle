import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDocFamily, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { pageHead } from "../../src/runtime/pi/historyIncremental.ts";
import { NativeHistory } from "../../src/runtime/pi/NativeHistory.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";

test("an empty A to B to A echo cannot shadow the live root's first committed chat", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  let left = await a.runtime.open(a.spec());
  const right = await b.runtime.open(b.spec());
  const held = Promise.withResolvers<void>();
  let sourceCalls = 0;
  let targetCalls = 0;
  try {
    b.faux.setResponses([
      (context) => {
        targetCalls++;
        assert.match(JSON.stringify(context.messages), /first local chat after empty echo/);
        assert.match(JSON.stringify(context.messages), /A answered after the empty echo/);
        return text("B continues the first real chat");
      },
    ]);
    const empty = await left.exportHistoryPage();
    assert.deepEqual(empty.records, []);
    await right.importHistoryPage(empty);
    const received = (await right.listHistoryBranches()).branches.find(
      (branch) => branch.branchId === empty.branchId,
    );
    assert.ok(received);
    const echo = await right.exportHistoryPage({ selection: received.selection });
    assert.equal(echo.head, empty.head);
    await left.importHistoryPage(echo);
    a.faux.setResponses([
      async (context) => {
        sourceCalls++;
        assert.match(JSON.stringify(context.messages), /first local chat after empty echo/);
        await held.promise;
        return text("A answered after the empty echo");
      },
    ]);
    await left.submit({
      requestId: "r_after_empty_echo",
      text: "first local chat after empty echo",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => sourceCalls === 1, "the first local provider is held after user commit");
    const live = (await left.listHistoryBranches()).branches.find(
      (branch) => branch.branchId === empty.branchId,
    );
    assert.ok(live);
    const partial = await left.exportHistoryPage({ selection: live.selection });
    assert.match(
      JSON.stringify(partial.records),
      /first local chat after empty echo/,
      "the directory must expose native commits without an archive export",
    );
    assert.equal(partial.branchId, empty.branchId);
    await right.importHistoryPage(partial);
    assert.equal((await right.assessHistoryHead(partial.head)).usable, false);
    held.resolve();
    await waitFor(
      async () => (await left.submission({ requestId: "r_after_empty_echo" }))?.status === "done",
      "first local answer",
    );
    await left.close(trace, 5_000);
    left = await a.runtime.open(a.spec());
    await left.importHistoryPage(echo);
    const reopened = (await left.listHistoryBranches()).branches.find(
      (branch) => branch.branchId === empty.branchId,
    );
    assert.ok(reopened);
    const complete = await left.exportHistoryPage({ selection: reopened.selection });
    assert.match(JSON.stringify(complete.records), /A answered after the empty echo/);
    assert.notEqual(complete.head, empty.head);
    assert.deepEqual(
      (await left.exportHistoryPage({ selection: empty.head })).records,
      [],
      "the old echoed immutable head stays empty",
    );
    await right.importHistoryPage(complete);
    assert.equal((await right.assessHistoryHead(complete.head)).usable, true);
    assert.equal(targetCalls, 0, "all receives were passive");
    const continued = await right.continueHistory({
      head: complete.head,
      requestId: "r_after_echo_continue",
      text: "continue locally on B",
    });
    assert.equal(continued.submission.status, "done");
    assert.equal(targetCalls, 1);
  } finally {
    held.resolve();
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("sequential handoff proves the current native tail and rejects same-conversation siblings", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  const right = await b.runtime.open(b.spec());
  const held = Promise.withResolvers<void>();
  let bCalls = 0;
  let continuing: ReturnType<typeof right.continueHistory> | undefined;
  try {
    a.faux.setResponses([
      text("common answer"),
      text("A concurrent local answer"),
      text("A relay answer"),
    ]);
    await left.submit({
      requestId: "r_common_handoff",
      text: "common question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_common_handoff" }))?.status === "done",
      "common turn",
    );
    const common = await left.exportHistoryPage();
    assert.equal(await left.currentHistoryBranch(), common.branchId);
    await right.importHistoryPage(common);
    b.faux.setResponses([
      async () => {
        bCalls++;
        await held.promise;
        return text("B sequential answer");
      },
    ]);
    const beforeContinuing = new Set(
      (await right.listHistoryBranches()).branches.map((branch) => branch.branchId),
    );
    continuing = right.continueHistory({
      head: common.head,
      requestId: "r_b_handoff",
      text: "B next",
    });
    await waitFor(() => bCalls === 1, "B's committed user while the model is held");
    const branches = await right.listHistoryBranches();
    const bBranch = branches.branches.find((branch) => !beforeContinuing.has(branch.branchId));
    assert.ok(bBranch);
    assert.equal(
      await right.currentHistoryBranch(),
      bBranch.branchId,
      "the committed active continuation is available before its provider completes",
    );
    const partial = await right.exportHistoryPage({ selection: bBranch.selection });
    await left.importHistoryPage(partial);
    const partialView = await left.readHistoryHead(partial.head);
    assert.match(JSON.stringify(partialView.messages), /B next/);
    assert.equal(partialView.usable, false);
    assert.equal(
      partialView.extendsCurrent,
      true,
      "committed user is a successor before assessment/model completion",
    );
    held.resolve();
    const continued = await continuing;
    const bPage = await right.exportHistoryPage({ selection: continued.branchId });
    await left.importHistoryPage(bPage);
    assert.equal(bPage.conversationId, common.conversationId);
    assert.equal(
      (await left.readHistoryHead(bPage.head)).extendsCurrent,
      true,
      "B's new branch must strictly extend A's current native tail",
    );
    assert.equal(
      (await left.readHistoryHead(common.head)).extendsCurrent,
      false,
      "an echo is not a successor",
    );
    await left.submit({
      requestId: "r_a_sibling",
      text: "A independently continued",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_a_sibling" }))?.status === "done",
      "A sibling turn",
    );
    assert.equal(
      (await left.readHistoryHead(bPage.head)).extendsCurrent,
      false,
      "a shared conversation ID does not make B a successor of A's new local work",
    );
    const aPage = await left.exportHistoryPage();
    await right.importHistoryPage(aPage);
    assert.equal(
      (await right.readHistoryHead(aPage.head)).extendsCurrent,
      false,
      "compare the native active continuation, not the old local root",
    );
    const next = await left.continueHistory({
      head: bPage.head,
      requestId: "r_a_relay",
      text: "A explicitly follows B",
    });
    const aRelay = await left.exportHistoryPage({ selection: next.branchId });
    await right.importHistoryPage(aRelay);
    assert.equal((await right.readHistoryHead(aRelay.head)).extendsCurrent, true);
    assert.equal(
      (await left.readHistoryHead(aPage.head, trace, bPage.head)).extendsCurrent,
      false,
      "a displayed immutable branch also excludes its siblings",
    );
    assert.equal(
      (await right.readHistoryHead(aRelay.head, trace, bPage.head)).extendsCurrent,
      true,
    );
  } finally {
    held.resolve();
    await continuing?.catch(() => undefined);
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("an archive-only receiver accepts a pure later delta and reopens into a usable native head", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  try {
    a.faux.setResponses([text("archive ancestor answer"), text("pure delta answer")]);
    await left.submit({
      requestId: "r_pure_ancestor",
      text: "ancestor question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_pure_ancestor" }))?.status === "done",
      "ancestor",
    );
    await right.importHistory(await left.exportHistory());
    const snapshot = await left.exportHistoryPage();
    assert.ok(snapshot.snapshot);
    await left.submit({
      requestId: "r_pure_delta",
      text: "delta question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_pure_delta" }))?.status === "done",
      "delta",
    );
    const delta = await left.exportHistoryPage({ after: snapshot.snapshot });
    assert.ok(delta.records.length > 0);
    assert.doesNotMatch(JSON.stringify(delta.records), /archive ancestor answer|ancestor question/);
    await right.importHistoryPage(delta);
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    await right.importHistoryPage(delta);
    assert.equal((await right.assessHistoryHead(delta.head)).usable, true);
    b.faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /archive ancestor answer/);
        assert.match(JSON.stringify(context.messages), /pure delta answer/);
        return text("B continues pure delta");
      },
    ]);
    assert.equal(
      (
        await right.continueHistory({
          head: delta.head,
          requestId: "r_pure_continue",
          text: "B next",
        })
      ).submission.status,
      "done",
    );
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("a missing-ancestor received selection forwards bounded original records while remaining unusable", async () => {
  const a = await createBench();
  const b = await createBench();
  const c = await createBench();
  const left = await a.runtime.open(a.spec());
  let middle = await b.runtime.open(b.spec());
  const right = await c.runtime.open(c.spec());
  try {
    a.faux.setResponses([
      text("old answer"),
      text("forward before backfill"),
      text("future answer"),
    ]);
    await left.submit({
      requestId: "r_partial_old",
      text: "older missing ancestor",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_partial_old" }))?.status === "done",
      "old answer",
    );
    await left.submit({
      requestId: "r_partial_forward",
      text: "missing user ancestor",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_partial_forward" }))?.status === "done",
      "answer",
    );
    const tail = await left.exportHistoryPage({ limit: 2 });
    assert.ok(tail.records[0]?.previous);
    await middle.importHistoryPage(tail);
    await middle.close(trace, 5_000);
    middle = await b.runtime.open(b.spec());
    const branch = (await middle.listHistoryBranches()).branches.find(
      (value) => value.branchId === tail.branchId,
    );
    assert.ok(branch);
    const forwarded = await middle.exportHistoryPage({
      selection: branch.selection,
      limit: 1,
      maxBytes: 4096,
    });
    assert.deepEqual(forwarded.records, tail.records.slice(-1));
    assert.ok(forwarded.cursor);
    const older = await middle.exportHistoryPage({
      selection: branch.selection,
      before: forwarded.cursor,
      limit: 1,
      maxBytes: 4096,
    });
    assert.deepEqual(older.records, tail.records.slice(0, 1));
    await right.importHistoryPage(older);
    assert.equal(forwarded.head, tail.head);
    assert.ok(Buffer.byteLength(JSON.stringify(forwarded)) <= 4096);
    await right.importHistoryPage(forwarded);
    assert.match(
      JSON.stringify((await right.readHistoryHead(tail.head)).messages),
      /forward before backfill/,
    );
    assert.equal((await right.assessHistoryHead(tail.head)).usable, false);
    await middle.importHistoryPage(await left.exportHistoryPage());
    assert.deepEqual(
      (
        await middle.exportHistoryPage({
          selection: branch.selection,
          before: forwarded.cursor,
          limit: 1,
        })
      ).records,
      older.records,
      "received cursors survive later native materialization",
    );
    await left.submit({
      requestId: "r_partial_future",
      text: "future user",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await left.submission({ requestId: "r_partial_future" }))?.status === "done",
      "future answer",
    );
    const future = await left.exportHistoryPage({ limit: 2 });
    await right.importHistoryPage(future);
    const futureForward = await right.exportHistoryPage({ selection: future.head });
    assert.ok(futureForward.snapshot);
    await assert.rejects(
      right.exportHistoryPage({ selection: tail.head, until: futureForward.snapshot }),
      /selected head/,
    );
    await assert.rejects(
      right.continueHistory({ head: tail.head, requestId: "r_partial_c", text: "must not run" }),
    );
  } finally {
    await left.close(trace, 5_000);
    await middle.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
    await c.cleanup();
  }
});

test("re-import repairs an old archive receipt without record docs before a pure delta after reopen", async () => {
  const bench = await createBench();
  const source = await Harness.open(
    await openNodeSqliteStorage(join(bench.dir, "legacy-source.sqlite")),
    { registry: createRegistry(), models: createModels() },
    ctx,
  );
  const path = join(bench.dir, "legacy-target.sqlite");
  let target = await Harness.open(
    await openNodeSqliteStorage(path),
    { registry: createRegistry(), models: createModels() },
    ctx,
  );
  try {
    const root = await source.root(ctx);
    await source.commit(async (tx) => {
      await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "legacy ancestor user", timestamp: 0 }],
      });
      await tx.appendEntry(root.id, {
        kind: "pi.assistant",
        model: [text("legacy ancestor answer")],
      });
    }, ctx);
    const feed = new NativeHistory(source, root.id, "b_legacy");
    const archive = await feed.export();
    const snapshot = await feed.exportPage();
    const nativeRoot = (await target.root(ctx)).id;
    await new NativeHistory(target, nativeRoot, "b_legacy").import(archive);
    // Real native docs model the old receipt format; the committed entries and receipt remain intact.
    const LegacyRecord = defineDocFamily({
      kind: "bots.history.record",
      version: 1,
      scope: "session",
      family: true,
      initial: (_seed: null) => ({ body: "", nativeId: 0, conversationId: 0 }),
      checkpointWhen: () => true,
    });
    await target.commit(async (tx) => {
      for (const entry of archive.entries)
        Object.assign(await tx.doc(LegacyRecord, entry.id, null), {
          body: "",
          nativeId: 0,
          conversationId: 0,
        });
    }, ctx);
    await target.close(ctx);
    target = await Harness.open(
      await openNodeSqliteStorage(path),
      { registry: createRegistry(), models: createModels() },
      ctx,
    );
    const receiver = new NativeHistory(target, nativeRoot, "b_legacy");
    await receiver.import(archive);
    await source.commit(async (tx) => {
      await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "new pure delta user", timestamp: 1 }],
      });
      await tx.appendEntry(root.id, {
        kind: "pi.assistant",
        model: [text("new pure delta answer")],
      });
    }, ctx);
    assert.ok(snapshot.snapshot);
    const delta = await feed.exportPage({ after: snapshot.snapshot });
    assert.equal(delta.records.length, 2);
    assert.doesNotMatch(JSON.stringify(delta.records), /legacy ancestor/);
    await receiver.importPage(delta);
    assert.equal((await receiver.assessHead(delta.head)).usable, true);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) n FROM entries").get()?.n,
        4,
        "repair indexes existing entries instead of copying the archive",
      );
    } finally {
      db.close();
    }
  } finally {
    await source.close(ctx);
    await target.close(ctx);
    await bench.cleanup();
  }
});

test("an inherited A cursor cannot advance an old head of B's branch while valid received cursors still work", async () => {
  const bench = await createBench();
  const harnesses = await Promise.all(
    ["cross-a", "cross-b", "cross-c"].map(async (name) =>
      Harness.open(
        await openNodeSqliteStorage(join(bench.dir, `${name}.sqlite`)),
        { registry: createRegistry(), models: createModels() },
        ctx,
      ),
    ),
  );
  const [a, b, c] = harnesses;
  assert.ok(a && b && c);
  try {
    const rootA = await a.root(ctx);
    await a.commit(async (tx) => {
      for (let turn = 0; turn < 2; turn += 1) {
        await tx.appendEntry(rootA.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `ancestor ${turn}`, timestamp: turn }],
        });
        await tx.appendEntry(rootA.id, {
          kind: "pi.assistant",
          model: [text(`inherited answer ${turn}`)],
        });
      }
    }, ctx);
    const feedA = new NativeHistory(a, rootA.id, "b_cross");
    const rootB = await b.root(ctx);
    await new NativeHistory(b, rootB.id, "b_cross").import(await feedA.export());
    const imported = (await b.commit((tx) => tx.scanConversations({}, 32), ctx)).items.find(
      (value) => value.id !== rootB.id,
    );
    assert.ok(imported);
    const shared = (
      await b.commit(
        (tx) => tx.scanEntries({ conversationId: imported.id, order: "ascending" }, 32),
        ctx,
      )
    ).items;
    const first = shared[0];
    const last = shared.at(-1);
    assert.ok(first && last);
    const fork = await b.commit(
      (tx) =>
        tx.forkConversation(first.conversationId, last.id, { ownership: { kind: "ownerless" } }),
      ctx,
    );
    const branch = await new NativeHistory(b, fork.id, "b_cross").exportPage();
    const olderTip = branch.records[1]?.entry.id;
    const newerTip = branch.records[3]?.entry.id;
    assert.ok(olderTip && newerTip && branch.records[0]?.entry.originId);
    assert.notEqual(branch.branchId.split("/c")[0], branch.records[0].entry.originId);
    const receiver = new NativeHistory(c, (await c.root(ctx)).id, "b_cross");
    const older = {
      ...branch,
      tip: olderTip,
      head: pageHead(branch.branchId, olderTip),
      records: branch.records.slice(1, 2),
    };
    const newer = {
      ...branch,
      tip: newerTip,
      head: pageHead(branch.branchId, newerTip),
      records: branch.records.slice(2, 4),
    };
    await receiver.importPage(older);
    await receiver.importPage(newer);
    const forwarded = await receiver.exportPage({ selection: newer.head, limit: 1 });
    assert.ok(forwarded.snapshot && forwarded.cursor);
    await assert.rejects(
      receiver.exportPage({ selection: older.head, until: forwarded.snapshot }),
      /selected head/,
    );
    const old = await receiver.exportPage({ selection: older.head, limit: 1 });
    assert.deepEqual(old.records, older.records);
    const valid = await receiver.exportPage({
      selection: newer.head,
      before: forwarded.cursor,
      limit: 1,
    });
    assert.deepEqual(valid.records, newer.records.slice(0, 1));
  } finally {
    for (const harness of harnesses) await harness.close(ctx);
    await bench.cleanup();
  }
});

test("an immutable raw head bounds inherited records from two other origins by ancestry", async () => {
  const bench = await createBench();
  const source = await Harness.open(
    await openNodeSqliteStorage(join(bench.dir, "mixed-source.sqlite")),
    { registry: createRegistry(), models: createModels() },
    ctx,
  );
  const target = await Harness.open(
    await openNodeSqliteStorage(join(bench.dir, "mixed-target.sqlite")),
    { registry: createRegistry(), models: createModels() },
    ctx,
  );
  try {
    const root = await source.root(ctx);
    await source.commit(async (tx) => {
      for (let turn = 0; turn < 2; turn++) {
        await tx.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `mixed user ${turn}`, timestamp: turn }],
        });
        await tx.appendEntry(root.id, {
          kind: "pi.assistant",
          model: [text(`mixed answer ${turn}`)],
        });
      }
    }, ctx);
    const original = await new NativeHistory(source, root.id, "b_mixed").exportPage();
    const originB = randomUUID();
    const branchId = `${randomUUID()}/c1`;
    const identities = new Map(
      original.records.map(({ entry }, index) => [
        entry.id,
        index < 2 ? entry.id : `${originB}/e${index + 1}`,
      ]),
    );
    const records = original.records.map(({ entry, previous }, index) => ({
      previous: previous === null ? null : (identities.get(previous) ?? null),
      entry:
        index < 2
          ? entry
          : {
              ...entry,
              id: identities.get(entry.id) as string,
              originId: originB,
              conversationId: `${originB}/c1`,
            },
    }));
    const oldTip = records[1]?.entry.id;
    const newTip = records[3]?.entry.id;
    assert.ok(oldTip && newTip);
    const old = {
      ...original,
      branchId,
      conversationId: branchId,
      tip: oldTip,
      head: pageHead(branchId, oldTip),
      records: records.slice(1, 2),
    };
    const newer = {
      ...old,
      tip: newTip,
      head: pageHead(branchId, newTip),
      records: records.slice(2),
    };
    const receiver = new NativeHistory(target, (await target.root(ctx)).id, "b_mixed");
    await receiver.importPage(old);
    await receiver.importPage(newer);
    const forward = await receiver.exportPage({ selection: newer.head, limit: 1 });
    assert.ok(forward.snapshot);
    await assert.rejects(
      receiver.exportPage({ selection: old.head, until: forward.snapshot }),
      /selected head/,
    );
    const oldCursor = await receiver.exportPage({ selection: old.head, limit: 1 });
    assert.ok(oldCursor.snapshot);
    let escaped: Awaited<ReturnType<typeof receiver.exportPage>> | undefined;
    try {
      escaped = await receiver.exportPage({
        selection: newer.head,
        before: forward.cursor ?? "",
        until: oldCursor.snapshot,
        limit: 1,
      });
    } catch (error) {
      assert.match(String(error), /selected head/);
    }
    if (escaped?.cursor)
      await assert.rejects(
        receiver.exportPage({ selection: old.head, until: escaped.cursor }),
        /selected head/,
        "a narrowed export must never issue a false old-head witness",
      );
    assert.equal(
      escaped,
      undefined,
      "incompatible before/until cannot export beyond the narrowed cap",
    );
    assert.equal(
      (await receiver.exportPage({ selection: newer.head, until: oldCursor.snapshot })).tip,
      oldTip,
    );
    await receiver.importPage({ ...newer, records });
    assert.deepEqual(
      (
        await receiver.exportPage({
          selection: newer.head,
          ...(forward.cursor ? { before: forward.cursor } : {}),
        })
      ).records,
      records.slice(0, 3),
    );
  } finally {
    await source.close(ctx);
    await target.close(ctx);
    await bench.cleanup();
  }
});

for (const emptyLast of [true, false]) {
  test(`concurrent empty/backfill receives retain pending work with empty ${emptyLast ? "last" : "first"}`, async () => {
    const bench = await createBench();
    const source = await Harness.open(
      await openNodeSqliteStorage(join(bench.dir, "race-source.sqlite")),
      { registry: createRegistry(), models: createModels() },
      ctx,
    );
    const target = await Harness.open(
      await openNodeSqliteStorage(join(bench.dir, "race-target.sqlite")),
      { registry: createRegistry(), models: createModels() },
      ctx,
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused!: () => void;
    const held = new Promise<void>((resolve) => {
      paused = resolve;
    });
    try {
      const root = await source.root(ctx);
      await source.commit(async (tx) => {
        for (let turn = 0; turn < 40; turn += 1) {
          await tx.appendEntry(root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: `race user ${turn}`, timestamp: turn }],
          });
          await tx.appendEntry(root.id, {
            kind: "pi.assistant",
            model: [text(`race answer ${turn}`)],
          });
        }
      }, ctx);
      const feed = new NativeHistory(source, root.id, "b_race");
      const receiver = new NativeHistory(target, (await target.root(ctx)).id, "b_race");
      const newest = await feed.exportPage();
      assert.ok(newest.cursor && newest.snapshot);
      await receiver.importPage(newest);
      const middle = await feed.exportPage({ before: newest.cursor, until: newest.snapshot });
      assert.ok(middle.cursor);
      await receiver.importPage(middle);
      const oldest = await feed.exportPage({ before: middle.cursor, until: newest.snapshot });
      assert.equal(oldest.records.length, 16);
      let commits = 0;
      const interleaved = new NativeHistory(
        new Proxy(target, {
          get(harness, property) {
            if (property === "commit")
              return async (...args: unknown[]) => {
                if (++commits === (emptyLast ? 2 : 34)) {
                  paused();
                  await blocked;
                }
                return Reflect.apply(harness.commit, harness, args);
              };
            const value = Reflect.get(harness, property);
            return typeof value === "function" ? value.bind(harness) : value;
          },
        }),
        (await target.root(ctx)).id,
        "b_race",
      );
      const delayed = interleaved.importPage(emptyLast ? { ...newest, records: [] } : oldest);
      await held;
      const other = await receiver.importPage(emptyLast ? oldest : { ...newest, records: [] });
      if (emptyLast) assert.equal(other.pending, true);
      release();
      await delayed;
      for (let drain = 0; drain < 4; drain += 1) {
        if (!(await receiver.importPage({ ...newest, records: [] })).pending) break;
      }
      assert.equal(
        (await receiver.assessHead(newest.head)).usable,
        true,
        "the native progress pointer must survive a stale empty receive, then drain without resending records",
      );
    } finally {
      release();
      await source.close(ctx);
      await target.close(ctx);
      await bench.cleanup();
    }
  });
}

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
    assert.match(
      JSON.stringify((await right.history({ limit: 50 })).messages),
      /B concurrent answer/,
    );
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
  const scanLimits: number[] = [];
  const b = await createBench({
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      return new Proxy(storage, {
        get(target, property) {
          if (property === "scanEntries")
            return (...args: Parameters<typeof storage.scanEntries>) => {
              reads += 1;
              scanLimits.push(args[1]);
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
    scanLimits.length = 0;
    assert.equal((await right.readHistoryHead(initial.head)).usable, true);
    assert.equal(reads, 1, "a materialized view only checks the local native tail for ancestry");
    assert.deepEqual(scanLimits, [1], "ancestry evidence never scans the full branch");
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
