import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type EntryId, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { archiveHash, type HistoryArchive } from "../../src/runtime/pi/historyArchive.ts";
import { NativeHistory } from "../../src/runtime/pi/NativeHistory.ts";
import type { PiDurableRuntime } from "../../src/runtime/pi/PiDurableRuntime.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";

const present = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined);
  return value;
};

const settled = async (handle: RuntimeHandle, requestId: string, input: string) => {
  await handle.submit({ requestId, text: input, whenBusy: "followUp", trace });
  await waitFor(async () => (await handle.submission({ requestId }))?.status === "done", "answer");
};

test("passive history survives retry/reopen and B's actual provider continues A's tool turn", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  let left: Awaited<ReturnType<PiDurableRuntime["open"]>> | undefined;
  let right: Awaited<ReturnType<PiDurableRuntime["open"]>> | undefined;
  let calls = 0;
  try {
    left = await a.runtime.open(a.spec());
    a.faux.setResponses([
      assistant([toolCall("write", { path: "proof.txt", content: "from A" })], {
        stopReason: "toolUse",
      }),
      text("A remembers apricot"),
    ]);
    await settled(left, "r_history_a", "Remember apricot and write proof.txt");
    assert.equal(await readFile(join(a.spec().dir, "workspace/proof.txt"), "utf8"), "from A");
    b.faux.setResponses([
      () => {
        calls += 1;
        return assistant("unexpected passive execution");
      },
    ]);
    right = await b.runtime.open(b.spec());
    assert.equal(typeof left.exportHistory, "function", "a completed native history is exportable");
    const archive = (await left.exportHistory()) as HistoryArchive;
    const realResults = archive.entries
      .flatMap((entry) => entry.model ?? [])
      .filter((item) => item.role === "toolResult");
    assert.ok(realResults.length > 0);
    const imported = await right.importHistory(archive);
    assert.deepEqual(await right.importHistory(archive), imported);
    assert.deepEqual(
      (await right.history({ limit: 50 })).messages,
      [],
      "root chat stays untouched",
    );
    await assert.rejects(access(join(b.spec().dir, "workspace/proof.txt")), { code: "ENOENT" });
    assert.deepEqual(await right.busy(), { run: false, tasks: false });
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    assert.deepEqual(
      await right.importHistory(archive),
      imported,
      "native receipt survives reopen",
    );
    assert.equal(calls, 0, "import and reopen never invoke a provider");
    b.faux.setResponses([
      (context) => {
        calls += 1;
        const input = JSON.stringify(context.messages);
        assert.match(input, /Remember apricot/);
        assert.match(input, /A remembers apricot/);
        assert.match(input, /proof.txt/);
        assert.deepEqual(
          context.messages.filter((message) => message.role === "toolResult"),
          realResults,
          "actual results survive, no SDK missing_result placeholder",
        );
        return assistant("B continues apricot");
      },
    ]);
    const continued = await right.continueHistory({
      head: imported.head,
      requestId: "r_history_b",
      text: "Continue here",
    });
    assert.equal(continued.submission.status, "done");
    assert.match(JSON.stringify(continued.answer), /B continues apricot/);
    assert.deepEqual(
      await right.continueHistory({
        head: imported.head,
        requestId: "r_history_b",
        text: "Continue here",
      }),
      continued,
    );
    assert.equal(calls, 1);
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    assert.deepEqual(
      await right.continueHistory({
        head: imported.head,
        requestId: "r_history_b",
        text: "Continue here",
      }),
      continued,
      "continuation retries survive reopen",
    );
    assert.equal(calls, 1);
    const branch = (await right.exportHistory(continued.branchId)) as HistoryArchive;
    assert.equal(branch.conversationId, archive.conversationId);
    assert.notEqual(branch.branchId, archive.branchId);
    assert.deepEqual(branch.entries.slice(0, archive.entries.length), archive.entries);
    const received = await left.importHistory(branch);
    assert.deepEqual(
      await left.exportHistory(received.head),
      branch,
      "forwarded IDs and branch stay stable",
    );
    await assert.rejects(access(join(b.spec().dir, "workspace/proof.txt")), { code: "ENOENT" });
  } finally {
    await left?.close(trace, 5_000);
    await right?.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

const rehash = (archive: HistoryArchive): HistoryArchive => {
  const { head: _head, ...payload } = archive;
  return { ...payload, head: archiveHash(payload) };
};

test("head export cannot rebind a continued branch or execute its request twice", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  let calls = 0;
  try {
    a.faux.setResponses([text("ancestor")]);
    await settled(left, "r_ancestor_rebind", "ancestor");
    const receipt = await right.importHistory(await left.exportHistory());
    b.faux.setResponses(
      Array.from({ length: 4 }, (_, index) => () => {
        calls += 1;
        return index % 2 === 0
          ? assistant([toolCall("bash", { command: "printf x >> executions.txt" })], {
              stopReason: "toolUse",
            })
          : text("continued once");
      }),
    );
    const input = { head: receipt.head, requestId: "r_pinned_branch", text: "continue" };
    const continued = await right.continueHistory(input);
    const branch = (await right.exportHistory(continued.branchId)) as HistoryArchive;
    const forwarded = rehash({ ...branch, botId: "forwarded-metadata" });
    const other = await right.importHistory(forwarded);
    assert.deepEqual(await right.exportHistory(other.head), forwarded);
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    const retried = await right.continueHistory(input);
    assert.equal(calls, 2, "one provider tool round and one answer, including retry/reopen");
    assert.equal(await readFile(join(b.spec().dir, "workspace/executions.txt"), "utf8"), "x");
    assert.deepEqual(retried, continued);
    assert.deepEqual(await right.exportHistory(continued.branchId), branch);
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("a post-admission history read failure is unknown and reopen retries the same native submission", async () => {
  let armed = false;
  let faults = 0;
  let calls = 0;
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({
    settings: { compaction: { enabled: false } },
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      return new Proxy(storage, {
        get(target, key, receiver) {
          if (key === "submission")
            return async (...args: Parameters<Storage["submission"]>) => {
              const value = await target.submission(...args);
              if (armed && value?.status === "done") {
                armed = false;
                faults += 1;
                throw new Error("lost the admitted submission read");
              }
              return value;
            };
          return Reflect.get(target, key, receiver);
        },
      });
    },
  });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  try {
    a.faux.setResponses([text("ancestor")]);
    await settled(left, "r_admission_ancestor", "ancestor");
    const receipt = await right.importHistory(await left.exportHistory());
    b.faux.setResponses([
      () => {
        calls += 1;
        return text("durably answered");
      },
    ]);
    const input = { head: receipt.head, requestId: "r_uncertain_history", text: "continue" };
    armed = true;
    await assert.rejects(right.continueHistory(input), (cause) => {
      assert.ok(cause instanceof ClassifiedFailure);
      assert.equal(cause.disposition, "unknown", "never tell a caller to discard an admitted ID");
      return true;
    });
    assert.equal(faults, 1);
    await right.close(trace, 5_000);
    right = await b.runtime.open(b.spec());
    const retried = await right.continueHistory(input);
    assert.equal(retried.submission.status, "done");
    assert.equal(calls, 1, "the durable admission answers without another provider invocation");
    await assert.rejects(
      right.continueHistory({ ...input, requestId: "r_invalid_head", head: "0".repeat(64) }),
      (cause) => {
        assert.ok(cause instanceof ClassifiedFailure);
        assert.equal(cause.disposition, "not_admitted");
        return true;
      },
    );
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

for (const damage of ["duplicate calls", "omit answer", "replace answer with user"] as const) {
  test(`effective edited context rejects ${damage}`, async () => {
    const bench = await createBench({ settings: { compaction: { enabled: false } } });
    const handle = await bench.runtime.open(bench.spec());
    try {
      bench.faux.setResponses([
        assistant([toolCall("list", {})], { stopReason: "toolUse" }),
        text("finished"),
      ]);
      await settled(handle, "r_edit_boundary", "list");
      const archive = (await handle.exportHistory()) as HistoryArchive;
      const caller = present(
        archive.entries.find((entry) =>
          entry.model?.some((item) => item.role === "assistant" && item.stopReason === "toolUse"),
        ),
      );
      const target =
        damage === "duplicate calls"
          ? caller
          : present(archive.entries.findLast((entry) => entry.kind === "pi.assistant"));
      const replacement = structuredClone(present(caller.model));
      const assistantMessage = present(replacement.find((item) => item.role === "assistant"));
      assert.ok(assistantMessage.role === "assistant");
      assistantMessage.content.push(present(assistantMessage.content[0]));
      archive.entries.push({
        id: `${caller.originId}/e999999`,
        originId: caller.originId,
        conversationId: caller.conversationId,
        kind: "review.edit",
        edits: [
          damage === "omit answer"
            ? { target: target.id, action: "omit" }
            : {
                target: target.id,
                action: "replace",
                messages:
                  damage === "duplicate calls"
                    ? replacement
                    : [{ role: "user", content: "unanswered", timestamp: 1 }],
              },
        ],
      });
      await assert.rejects(
        handle.importHistory(rehash(archive)),
        damage === "duplicate calls" ? /duplicated/ : /complete turn/,
      );
    } finally {
      await handle.close(trace, 5_000);
      await bench.cleanup();
    }
  });
}

test("trust boundary refuses missing/orphaned raw tool results, broken references and partial turns", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench();
  const left = await a.runtime.open(a.spec());
  const right = await b.runtime.open(b.spec());
  try {
    a.faux.setResponses([
      assistant([toolCall("list", {})], { stopReason: "toolUse" }),
      text("finished"),
    ]);
    await settled(left, "r_validate", "list files");
    const archive = (await left.exportHistory()) as HistoryArchive;
    for (const mutate of [
      (value: HistoryArchive) => {
        value.entries = value.entries.filter((entry) => entry.kind !== "pi.tool-result");
      },
      (value: HistoryArchive) => {
        value.entries = value.entries.filter(
          (entry) =>
            !entry.model?.some(
              (item) => item.role === "assistant" && item.stopReason === "toolUse",
            ),
        );
      },
      (value: HistoryArchive) => {
        value.entries.pop();
      },
      (value: HistoryArchive) => {
        present(value.entries[0]).head = `${present(value.entries[0]).originId}/e999999`;
      },
      (value: HistoryArchive) => {
        present(value.entries[0]).edits = [
          { target: `${present(value.entries[0]).originId}/e999999`, action: "omit" },
        ];
      },
      (value: HistoryArchive) => {
        value.entries.push(present(value.entries[0]));
      },
      (value: HistoryArchive) => {
        present(value.entries.at(-1)).edits = [
          {
            target: present(value.entries.find((entry) => entry.kind === "pi.tool-result")).id,
            action: "omit",
          },
        ];
      },
    ]) {
      const damaged = structuredClone(archive);
      mutate(damaged);
      await assert.rejects(right.importHistory(rehash(damaged)));
    }
    await assert.rejects(right.importHistory({ ...archive, head: "0".repeat(64) }), /digest/);
    await assert.rejects(right.importHistory({ ...archive, extra: true }));
    const receipt = await right.importHistory(archive);
    assert.deepEqual(
      await right.exportHistory(receipt.head),
      archive,
      "failed imports leave no partial native records",
    );
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("active work and a committed unfinished turn cannot be exported", async () => {
  const bench = await createBench({
    provider: { tokensPerSecond: 1 },
    settings: { compaction: { enabled: false } },
  });
  const handle = await bench.runtime.open(bench.spec());
  try {
    bench.faux.setResponses([text("still running for a long time")]);
    await handle.submit({ requestId: "r_active", text: "active", whenBusy: "followUp", trace });
    await assert.rejects(handle.exportHistory(), /active/);
    await handle.abort(trace);
    await assert.rejects(handle.exportHistory(), /complete turn/);
  } finally {
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("completed assistant tool groups can reuse call_1 while duplicates inside one group are refused", async () => {
  const bench = await createBench({ settings: { compaction: { enabled: false } } });
  const handle = await bench.runtime.open(bench.spec());
  try {
    bench.faux.setResponses([
      assistant([toolCall("list", {}, { id: "call_1" })], { stopReason: "toolUse" }),
      assistant([toolCall("list", {}, { id: "call_1" })], { stopReason: "toolUse" }),
      text("two completed rounds"),
    ]);
    await settled(handle, "r_reuse_id", "list twice");
    const archive = (await handle.exportHistory()) as HistoryArchive;
    const results = archive.entries
      .flatMap((entry) => entry.model ?? [])
      .filter((item) => item.role === "toolResult");
    assert.equal(results.length, 2);
    assert.ok(results.every((item) => item.toolCallId === "call_1"));
    const damaged = structuredClone(archive);
    const caller = damaged.entries
      .flatMap((entry) => entry.model ?? [])
      .find((item) => item.role === "assistant" && item.stopReason === "toolUse");
    assert.ok(caller?.role === "assistant");
    caller.content.push(present(caller.content[0]));
    await assert.rejects(handle.importHistory(rehash(damaged)), /duplicated/);
  } finally {
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("native compaction heads and edits survive import and B keeps its own configuration", async () => {
  const a = await createBench({
    provider: { models: [{ id: "A-tiny", contextWindow: 1200, maxTokens: 200 }] },
    settings: {
      compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 150, backgroundTokens: 0 },
    },
  });
  const b = await createBench({
    provider: { models: [{ id: "B-local" }] },
    settings: { compaction: { enabled: false } },
    toolGroups: ["core", "coding"],
  });
  const left = await a.runtime.open(a.spec());
  const right = await b.runtime.open(b.spec());
  let reopened: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    a.faux.setResponses(
      Array.from({ length: 30 }, () =>
        text("The build remains green and remembers apricot. ".repeat(18)),
      ),
    );
    for (let turn = 0; turn < 5; turn += 1)
      await settled(
        left,
        `r_compact_${turn}`,
        `Turn ${turn}: ${"please retain the build context ".repeat(15)}`,
      );
    const compacted = (await left.exportHistory()) as HistoryArchive;
    assert.ok(
      compacted.entries.some((entry) => entry.kind === "pi.compaction" && entry.head !== undefined),
    );
    await left.close(trace, 5_000);
    // Apply a public native context edit, then export its raw reference as well as compaction.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    reopened = await Harness.open(
      await openNodeSqliteStorage(join(a.spec().dir, "session.sqlite")),
      { models, registry: createRegistry() },
      ctx,
    );
    const root = await reopened.root(ctx);
    await root.commit(async (tx) => {
      const page = await tx.scanEntries({ conversationId: root.id, order: "descending" }, 128);
      const target = page.items.find((entry) => entry.kind === "pi.user")?.id;
      assert.ok(target !== undefined);
      await tx.appendEntry(root.id, {
        kind: "history.test.edit",
        edits: [
          {
            target: target as EntryId,
            action: "replace",
            messages: [{ role: "user", content: "edited context apricot", timestamp: 1 }],
          },
        ],
      });
    }, ctx);
    const archive = await new NativeHistory(reopened, root.id, a.spec().id).export();
    const receipt = await right.importHistory(archive);
    assert.deepEqual(await right.exportHistory(receipt.head), archive);
    b.faux.setResponses([
      (context) => {
        const input = JSON.stringify(context.messages);
        assert.match(input, /edited context apricot/);
        assert.match(input, /build remains green/);
        return text("B local configuration continued");
      },
    ]);
    const result = await right.continueHistory({
      head: receipt.head,
      requestId: "r_after_compact",
      text: "continue",
    });
    assert.equal(result.submission.status, "done");
    const branch = (await right.exportHistory(result.branchId)) as HistoryArchive;
    assert.equal(
      branch.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((item) => item.role === "assistant")
        .at(-1)?.model,
      "B-local",
    );
    assert.ok(branch.entries.some((entry) => entry.edits?.length));
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await reopened?.close(ctx);
    await a.cleanup();
    await b.cleanup();
  }
});

test("plain local open/submit/reopen create no optional-history origin or receipt documents", async () => {
  const bench = await createBench();
  let handle = await bench.runtime.open(bench.spec());
  try {
    bench.faux.setResponses([text("local chat works")]);
    await settled(handle, "r_local_only", "local");
    await handle.close(trace, 5_000);
    handle = await bench.runtime.open(bench.spec());
    const db = new DatabaseSync(join(bench.spec().dir, "session.sqlite"), { readOnly: true });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM documents WHERE json_extract(kind, '$') LIKE 'bots.history%' OR json_extract(kind, '$') LIKE 'bots.chat%'",
          )
          .get()?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("concurrent A/B continuations retain both branches and physically deduplicate shared ancestors", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  const right = await b.runtime.open(b.spec());
  try {
    a.faux.setResponses([text("common ancestor"), text("A independent branch")]);
    await settled(left, "r_common", "common");
    const ancestor = (await left.exportHistory()) as HistoryArchive;
    const receipt = await right.importHistory(ancestor);
    await settled(left, "r_a_branch", "A local continuation");
    assert.deepEqual(
      await left.exportHistory(ancestor.head),
      ancestor,
      "an immutable head does not advance with its native conversation",
    );
    b.faux.setResponses([text("B independent branch")]);
    const branch = await right.continueHistory({
      head: receipt.head,
      requestId: "r_b_branch",
      text: "B local continuation",
    });
    const branchA = (await left.exportHistory()) as HistoryArchive;
    const branchB = (await right.exportHistory(branch.branchId)) as HistoryArchive;
    assert.notEqual(branchA.branchId, branchB.branchId);
    assert.equal(branchA.conversationId, branchB.conversationId);
    await left.importHistory(branchB);
    await right.importHistory(branchA);
    for (const handle of [left, right]) {
      assert.deepEqual(await handle.exportHistory(branchA.head), branchA);
      assert.deepEqual(await handle.exportHistory(branchB.head), branchB);
      assert.deepEqual(await handle.importHistory(ancestor), receipt);
    }
    const distinct = new Set([...branchA.entries, ...branchB.entries].map((entry) => entry.id));
    for (const bench of [a, b]) {
      const db = new DatabaseSync(join(bench.spec().dir, "session.sqlite"), { readOnly: true });
      try {
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM entries").get()?.count,
          distinct.size,
          "shared entries live once in native SQLite",
        );
      } finally {
        db.close();
      }
    }
  } finally {
    await left.close(trace, 5_000);
    await right.close(trace, 5_000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("explicit local continuation keeps ordinary sends and reopen on its chosen native conversation", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  let originalCalls = 0;
  try {
    a.faux.setResponses([text("A original context")]);
    await settled(left, "r_active_source", "A original question");
    b.faux.setResponses([
      () => {
        originalCalls++;
        return text("B old root answer");
      },
    ]);
    await settled(right, "r_active_old_root", "B old root question");
    const imported = await right.importHistory(await left.exportHistory());
    b.faux.setResponses([
      text("B selected branch answer"),
      (context) => {
        assert.match(JSON.stringify(context.messages), /A original context/);
        assert.match(JSON.stringify(context.messages), /B selected branch answer/);
        assert.doesNotMatch(JSON.stringify(context.messages), /B old root answer/);
        return text("B second branch answer");
      },
    ]);
    const branch = await right.continueHistory({
      head: imported.head,
      requestId: "r_active_fork",
      text: "B selects this history",
    });
    assert.equal(branch.submission.status, "done");
    await settled(right, "r_active_next", "B stays here");
    await right.close(trace, 5000);
    right = await b.runtime.open(b.spec());
    b.faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /B second branch answer/);
        return text("B reopened branch answer");
      },
    ]);
    await settled(right, "r_active_reopen", "B remains here after reopen");
    assert.equal(
      (await right.submission({ requestId: "r_active_old_root" }))?.status,
      "done",
      "lookup still finds a pre-selection root admission after reopen",
    );
    const oldRoot = present(await right.submission({ requestId: "r_active_old_root" }));
    assert.match(
      JSON.stringify(await right.entryById(present(oldRoot.answerEntryId))),
      /B old root answer/,
      "peer readers can still resolve the old root's answer by its native entry ID",
    );
    await right.submit({
      requestId: "r_active_old_root",
      text: "B old root question",
      whenBusy: "followUp",
      trace,
    });
    assert.equal(
      originalCalls,
      1,
      "an old root request cannot execute on the newly selected conversation",
    );
    const history = await right.history({ limit: 50 });
    assert.match(JSON.stringify(history.messages), /B reopened branch answer/);
    assert.doesNotMatch(JSON.stringify(history.messages), /B old root answer/);
  } finally {
    await left.close(trace, 5000);
    await right.close(trace, 5000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("a continuation request stays indexed after selecting another branch and reopening", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let right = await b.runtime.open(b.spec());
  let calls = 0;
  try {
    a.faux.setResponses([text("common request ancestor")]);
    await settled(left, "r_route_ancestor", "common request question");
    const imported = await right.importHistory(await left.exportHistory());
    b.faux.setResponses(
      ["X original answer", "Y selected answer", "duplicate must not execute"].map(
        (answer) => () => {
          calls++;
          return text(answer);
        },
      ),
    );
    const first = await right.continueHistory({
      head: imported.head,
      requestId: "r_route_x",
      text: "X original question",
    });
    await right.continueHistory({
      head: imported.head,
      requestId: "r_route_y",
      text: "Y selected question",
    });
    await right.close(trace, 5000);
    right = await b.runtime.open(b.spec());
    const queried = await right.submission({ requestId: "r_route_x" });
    const retried = await right.submit({
      requestId: "r_route_x",
      text: "X original question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await right.submission({ submissionId: retried.id }))?.status === "done",
      "retried original admission",
    );
    assert.deepEqual(
      { queried: queried?.id, retried: retried.id, calls },
      { queried: first.submission.id, retried: first.submission.id, calls: 2 },
      "query and ordinary retry must find X rather than executing again on Y",
    );
    assert.match(
      JSON.stringify(await right.entryById(present(queried?.answerEntryId))),
      /X original answer/,
      "an old continuation answer remains readable after selection changes",
    );
    assert.doesNotMatch(
      JSON.stringify((await right.history({ limit: 50 })).messages),
      /X original/,
    );
  } finally {
    await left.close(trace, 5000);
    await right.close(trace, 5000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("a delayed acquired watch cannot replace a newer selected branch or emit its baseline", async (t) => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  let kernel!: Harness & { readOnLine<T>(job: () => Promise<T>): Promise<T> };
  const open = Harness.open;
  t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
    const harness = await open(...args);
    kernel = harness as typeof kernel;
    return harness;
  });
  const right = await b.runtime.open(b.spec());
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let acquired = false;
  let armed = false;
  const read = kernel.readOnLine;
  // Delay only the return of a real acquired SDK observer, after its Session line is free.
  t.mock.method(kernel, "readOnLine", async function <
    T,
  >(this: typeof kernel, job: () => Promise<T>): Promise<T> {
    const value = (await read.call(this, job)) as T;
    if (armed && value !== null && typeof value === "object" && "observer" in value) {
      armed = false;
      acquired = true;
      await held;
    }
    return value;
  });
  const events: RuntimeEvent[] = [];
  const subscription = await right.subscribe(trace, (event) => events.push(event));
  try {
    a.faux.setResponses([text("watch ancestor")]);
    await settled(left, "r_watch_ancestor", "watch ancestor question");
    const imported = await right.importHistory(await left.exportHistory());
    b.faux.setResponses([
      text("newer watch answer"),
      text("older watch answer"),
      text("newer live follow-up answer"),
    ]);
    armed = true;
    const older = right.continueHistory({
      head: imported.head,
      requestId: "r_watch_x",
      text: "older watch question",
    });
    await waitFor(() => acquired, "X's real watch acquisition before baseline delivery");
    await right.continueHistory({
      head: imported.head,
      requestId: "r_watch_y",
      text: "newer watch question",
    });
    await waitFor(() => JSON.stringify(right.snapshot()).includes("newer watch answer"), "Y watch");
    const beforeRelease = events.length;
    release();
    await older;
    const stale = events.slice(beforeRelease).filter((event) => event.type === "snapshot");
    assert.deepEqual(stale, [], "X's delayed baseline must never be published after Y");
    assert.match(JSON.stringify(right.snapshot()), /newer watch answer/);
    await settled(right, "r_watch_next", "newer branch follow-up");
    await waitFor(
      () => events.some((event) => JSON.stringify(event).includes("newer live follow-up answer")),
      "the newer subscription still receives live commits",
    );
    assert.doesNotMatch(
      JSON.stringify(right.snapshot()),
      /older watch question|older watch answer/,
    );
  } finally {
    release();
    subscription.detach();
    await left.close(trace, 5000);
    await right.close(trace, 5000);
    await a.cleanup();
    await b.cleanup();
  }
});

test("continuation selection follows new intent instead of slow completion or an older retry", async () => {
  const a = await createBench({ settings: { compaction: { enabled: false } } });
  const b = await createBench({ settings: { compaction: { enabled: false } } });
  const left = await a.runtime.open(a.spec());
  const right = await b.runtime.open(b.spec());
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let started!: () => void;
  const entered = new Promise<void>((done) => {
    started = done;
  });
  let actualInput = "";
  try {
    a.faux.setResponses([text("common intent ancestor")]);
    await settled(left, "r_intent_source", "common question");
    const imported = await right.importHistory(await left.exportHistory());
    b.faux.setResponses([
      async () => {
        started();
        await held;
        return text("older slow continuation");
      },
      text("newer selected continuation"),
      (context) => {
        actualInput = JSON.stringify(
          context.messages.filter((message) => message.role !== "system"),
        );
        return text("ordinary selected answer");
      },
    ]);
    const older = { head: imported.head, requestId: "r_intent_old", text: "older branch prompt" };
    const slow = right.continueHistory(older);
    await entered;
    await right.continueHistory({
      head: imported.head,
      requestId: "r_intent_new",
      text: "newer branch prompt",
    });
    release();
    await slow;
    await right.continueHistory(older);
    await settled(right, "r_intent_next", "ordinary input after both finish");
    assert.match(actualInput, /newer selected continuation/);
    assert.doesNotMatch(actualInput, /older slow continuation/);
  } finally {
    release();
    await left.close(trace, 5000);
    await right.close(trace, 5000);
    await a.cleanup();
    await b.cleanup();
  }
});
