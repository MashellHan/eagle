import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  getCurrentSystemMessage,
  getCurrentTools,
  type TranscriptContext,
  Type,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  type Cursor,
  defineExtension,
  defineTool,
  type EntryRecord,
  Harness,
  ProviderDoc,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  canonical,
  type HistoryBundle,
  HistoryReplica,
} from "../../src/runtime/pi/HistoryReplica.ts";
import { createToolRegistry, selectToolExtensions } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";
import { assistant, text, toolCall, trace } from "../support/pi.ts";

const open = async (dir: string, storage?: (path: string) => Promise<Storage>) => {
  const workspace = await openWorkspace(join(dir, "workspace"));
  const registry = createToolRegistry(workspace);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    await (storage ?? openNodeSqliteStorage)(join(dir, "session.sqlite")),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace.root }),
      settings: { compaction: { enabled: true, keepRecentTokens: 100, backgroundTokens: 0 } },
    },
    ctx,
  );
  const root = await harness.root(ctx, {
    agent: {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      cwd: workspace.root,
      extensions: selectToolExtensions(registry, ["core", "coding"]),
    },
  });
  const replica = new HistoryReplica(harness, root.id, "b_shared", workspace.root, registry);
  return {
    harness,
    registry,
    root,
    faux,
    workspace: workspace.root,
    command: (method: "export" | "import" | "run" | "status", params: unknown) =>
      replica.command({ method, params, trace }),
  };
};
const all = async (conversation: Conversation) => {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 29, cursor, ctx);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
};
const resource = (name: string, kind: "attachment" | "instructions" | "skill", value: string) => ({
  name,
  kind,
  sha256: createHash("sha256").update(value).digest("hex"),
  base64: Buffer.from(value).toString("base64"),
});

test("full raw history, compaction references and resource versions survive passive import, restart and local branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-replica-"));
  let a = await open(join(dir, "a"));
  let b = await open(join(dir, "b"));
  try {
    await a.root.reset("explicit handoff", ctx);
    await a.root.configure({ instructions: "first instruction 原始" }, ctx);
    a.faux.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "工具原字节\n原始 UTF-8" })], {
        stopReason: "toolUse",
      }),
      text("tool complete"),
    ]);
    const submission = await a.root.submit(
      { type: "input", content: "write exact bytes", requestId: "source-tool" },
      ctx,
    );
    await submission.wait(ctx);
    await a.root.waitForIdle(ctx);
    assert.equal(
      await readFile(join(a.workspace, "original.txt"), "utf8"),
      "工具原字节\n原始 UTF-8",
    );
    await a.root.configure({ instructions: "second instruction 保留变化", tools: [] }, ctx);
    a.faux.setResponses([text("new instructions"), text("compact original history")]);
    await (
      await a.root.submit({ type: "input", content: "second turn", requestId: "second" }, ctx)
    ).wait(ctx);
    await a.root.commit(async (tx) => {
      for (let index = 0; index < 220; index += 1) {
        await tx.appendEntry(a.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `original ${index}`, timestamp: index }],
          data: { index, opaque: ["原文", { unchanged: true }] },
        });
      }
    }, ctx);
    const prior = (await all(a.root)).at(-1);
    assert.ok(prior);
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "fixture.edit",
        edits: [
          {
            target: prior.id,
            action: "replace",
            messages: [{ role: "user", content: "edited contribution", timestamp: 0 }],
          },
        ],
        data: { original: "kept" },
      });
      await tx.appendEntry(a.root.id, {
        kind: "fixture.attachment",
        model: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from("original image bytes").toString("base64"),
              },
            ],
            timestamp: 1,
          },
        ],
      });
    }, ctx);
    const compact = await a.root.compact(undefined, ctx);
    await a.harness.waitForTask(compact, ctx);
    await a.root.waitForIdle(ctx);
    const original = await all(a.root);
    assert.ok(original.length > 220);
    assert.ok(
      original.some((entry) => entry.kind === "pi.tool-result"),
      "a tool refusal cannot masquerade as fidelity evidence",
    );
    assert.ok(original.some((entry) => entry.kind === "pi.compaction" && entry.head !== undefined));
    assert.ok(original.some((entry) => entry.kind === "pi.reset" && entry.head === entry.id));
    assert.ok(original.some((entry) => entry.byTaskId !== undefined));
    assert.ok(
      original.some((entry) =>
        entry.model?.some(
          (message) => message.role === "system" && (message.toolsRemoved?.length ?? 0) > 0,
        ),
      ),
    );
    const expected = await a.root.context(ctx);
    const resources = [
      resource("AGENTS.md", "instructions", "first version"),
      resource("AGENTS.md", "instructions", "second version"),
      resource("skills/example/SKILL.md", "skill", "complete skill"),
      resource("skills/example/scripts/run.py", "skill", "print('source')"),
      resource("image.png", "attachment", "original image bytes"),
    ];
    const bundle = (await a.command("export", { resources })) as HistoryBundle;
    assert.deepEqual(
      bundle.entries,
      original,
      "export is independently checked against all SDK pages",
    );
    const received = await b.command("import", { bundle });
    assert.deepEqual(
      await b.command("import", { bundle: JSON.parse(JSON.stringify(bundle)) }),
      received,
    );
    assert.equal(b.faux.state.callCount, 0);
    assert.deepEqual((await b.harness.inspect(ctx)).tasks, []);
    await assert.rejects(readFile(join(b.workspace, "original.txt")), { code: "ENOENT" });
    const conversations = await b.harness.commit((tx) => tx.scanConversations({}, 20), ctx);
    const importedId = conversations.items.find(
      (conversation) => conversation.id !== b.root.id,
    )?.id;
    assert.ok(importedId);
    const imported = await b.harness.conversation(importedId, ctx);
    assert.ok(imported);
    const localEntries = await all(imported);
    const mapping = new Map(original.map((entry, index) => [entry.id, localEntries[index]?.id]));
    assert.deepEqual(
      localEntries,
      original.map((entry) => {
        const { byTaskId: _sourceTask, ...record } = entry;
        return {
          ...record,
          id: mapping.get(entry.id),
          conversationId: importedId,
          ...(entry.head === undefined ? {} : { head: mapping.get(entry.head) }),
          ...(entry.edits === undefined
            ? {}
            : {
                edits: entry.edits.map((edit) => ({ ...edit, target: mapping.get(edit.target) })),
              }),
        };
      }),
      "raw model/data/edits remain exact; source task IDs never become local task ownership",
    );
    assert.deepEqual(
      (await imported.context(ctx)).messages,
      expected.messages,
      "SDK context reconstruction is checked separately from re-export",
    );
    assert.deepEqual(await b.command("export", { head: bundle.head }), bundle);
    await assert.rejects(
      b.command("run", { head: bundle.head, requestId: "unloaded-resource", text: "must not run" }),
      /resource.*install/,
    );
    const runnable = (await a.command("export", {
      resources: resources.filter((item) => item.kind === "attachment"),
    })) as HistoryBundle;
    await b.command("import", { bundle: runnable });
    const referenceRequests: TranscriptContext[] = [];
    a.faux.setResponses([
      (context) => {
        referenceRequests.push(context);
        return text("source reference continuation");
      },
    ]);
    await a.command("run", {
      head: runnable.head,
      requestId: "source-reference",
      text: "source reference input",
    });
    await a.harness.waitForIdle(ctx);
    const reference = referenceRequests[0];
    assert.ok(reference);
    const sourceSession = await a.harness.snapshot(ProviderDoc, a.root.id, ctx);
    const importedSession = await b.harness.snapshot(ProviderDoc, importedId, ctx);
    assert.notEqual(sourceSession?.sessionId, importedSession?.sessionId);

    await a.harness.close(ctx);
    await b.harness.close(ctx);
    b = await open(join(dir, "b"));
    assert.deepEqual(await b.command("import", { bundle }), received);
    assert.equal(b.faux.state.callCount, 0, "reopen plus duplicate import stays passive");
    const requests: TranscriptContext[] = [];
    b.faux.setResponses([
      (...args) => {
        requests.push(args[0]);
        return text("B first branch");
      },
      (...args) => {
        requests.push(args[0]);
        return text("B concurrent sibling");
      },
    ]);
    await Promise.all([
      b.command("run", { head: runnable.head, requestId: "branch-1", text: "continue first" }),
      b.command("run", { head: runnable.head, requestId: "branch-2", text: "continue sibling" }),
    ]);
    await b.harness.waitForIdle(ctx);
    assert.equal(requests.length, 2);
    const expectedText = canonical(expected.messages).replaceAll(a.workspace, b.workspace);
    for (const request of requests) {
      const originalMessages = JSON.parse(expectedText) as TranscriptContext["messages"];
      let originalIndex = 0;
      for (const message of request.messages.slice(0, -1)) {
        if (canonical(message) === canonical(originalMessages[originalIndex])) originalIndex += 1;
        else
          assert.equal(
            message.role,
            "system",
            "only a new local system baseline can be inserted around the exact original context",
          );
      }
      assert.equal(
        originalIndex,
        originalMessages.length,
        "every original message category stays in order",
      );
      const sourceSystem = getCurrentSystemMessage(reference.messages);
      const targetSystem = getCurrentSystemMessage(request.messages);
      assert.equal(
        canonical({ content: targetSystem?.content, sections: targetSystem?.sections }),
        canonical({ content: sourceSystem?.content, sections: sourceSystem?.sections }).replaceAll(
          a.workspace,
          b.workspace,
        ),
        "ordered system replay matches an actual A continuation from the same head, with only cwd mapped",
      );
      assert.match(targetSystem?.sections?.instructions ?? "", /second instruction 保留变化/);
      assert.deepEqual(
        getCurrentTools(request.messages),
        getCurrentTools(reference.messages),
        "full ordered effective tool declarations survive replay",
      );
      const changes = (messages: TranscriptContext["messages"]) =>
        messages
          .flatMap((message) =>
            message.role !== "system"
              ? []
              : [{ added: message.toolsAdded ?? [], removed: message.toolsRemoved ?? [] }],
          )
          .filter((change) => change.added.length > 0 || change.removed.length > 0);
      assert.deepEqual(
        changes(request.messages),
        changes(reference.messages),
        "all ordered toolsAdded/toolsRemoved declarations match the same-head source continuation",
      );
    }

    const branch1 = (await b.command("export", { branch: "branch-1" })) as HistoryBundle;
    const branch2 = (await b.command("export", { branch: "branch-2" })) as HistoryBundle;
    assert.notEqual(branch1.head, branch2.head);
    assert.deepEqual(branch1.parents, [runnable.head]);
    assert.deepEqual(branch2.parents, [runnable.head]);
    assert.ok(canonical(branch1).includes("B first branch"));
    assert.ok(canonical(branch2).includes("B concurrent sibling"));
    const c = await open(join(dir, "c"));
    try {
      for (const branch of [branch2, branch1]) {
        await c.command("import", { bundle: branch });
        const view = await c.harness.commit((tx) => tx.scanConversations({}, 20), ctx);
        const matching: Conversation[] = [];
        for (const record of view.items) {
          const conversation = await c.harness.conversation(record.id, ctx);
          if (
            conversation !== undefined &&
            (await all(conversation)).length === branch.entries.length
          )
            matching.push(conversation);
        }
        const source = await b.harness.conversation(
          branch.source.conversationId as ConversationId,
          ctx,
        );
        assert.ok(source);
        assert.ok(matching.length > 0);
        const expectedBranch = (await source.context(ctx)).messages;
        assert.ok(
          (await Promise.all(matching.map((conversation) => conversation.context(ctx)))).some(
            (context) => canonical(context.messages) === canonical(expectedBranch),
          ),
          "a clean third SQLite reconstructs fork ancestors, head and edits from branch export",
        );
      }
      assert.equal(c.faux.state.callCount, 0);
    } finally {
      await c.harness.close(ctx);
    }
    a = await open(join(dir, "a"));
    a.faux.setResponses([text("A independently continued")]);
    b.faux.setResponses([text("B independently continued")]);
    await Promise.all([
      a.command("run", {
        head: runnable.head,
        requestId: "A-concurrent",
        text: "A from same head",
      }),
      b.command("run", {
        head: runnable.head,
        requestId: "B-concurrent",
        text: "B from same head",
      }),
    ]);
    await Promise.all([a.harness.waitForIdle(ctx), b.harness.waitForIdle(ctx)]);
    const aBranch = (await a.command("export", { branch: "A-concurrent" })) as HistoryBundle;
    const bBranch = (await b.command("export", { branch: "B-concurrent" })) as HistoryBundle;
    assert.notEqual(aBranch.source.replicaId, bBranch.source.replicaId);
    assert.deepEqual(aBranch.parents, [runnable.head]);
    assert.deepEqual(bBranch.parents, [runnable.head]);
    const beforeExchange = [a.faux.state.callCount, b.faux.state.callCount];
    await Promise.all([
      a.command("import", { bundle: bBranch }),
      b.command("import", { bundle: aBranch }),
    ]);
    assert.deepEqual([a.faux.state.callCount, b.faux.state.callCount], beforeExchange);
    assert.deepEqual(await a.command("export", { head: bBranch.head }), bBranch);
    assert.deepEqual(await b.command("export", { head: aBranch.head }), aBranch);
    const count = b.faux.state.callCount;
    await b.command("run", { head: runnable.head, requestId: "branch-1", text: "continue first" });
    assert.equal(b.faux.state.callCount, count, "duplicate acceptance does not regenerate");
    await assert.rejects(
      b.command("run", { head: runnable.head, requestId: "branch-1", text: "changed binding" }),
      /conflict/,
    );
    await b.harness.close(ctx);
    b = await open(join(dir, "b"));
    assert.equal(
      ((await b.command("status", { requestId: "branch-1" })) as { submission: { status: string } })
        .submission.status,
      "done",
    );
    assert.deepEqual(
      await b.command("export", { branch: "branch-1" }),
      branch1,
      "output committed before export remains reconstructible after restart",
    );
    assert.deepEqual(await b.command("export", { branch: "branch-2" }), branch2);
  } finally {
    await Promise.all([a.harness.close(ctx), b.harness.close(ctx)]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real SDK nested tool call cannot be exported as a complete P0 head, including through fork ancestry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-nested-history-"));
  const source = await open(dir);
  try {
    const extension = defineExtension({
      name: "nested-fixture",
      tools: [
        defineTool({
          name: "nested_fixture",
          description: "Calls another real SDK tool",
          parameters: Type.Object({}),
          async execute(_args, api, context) {
            const result = await api.executeTool(
              "write",
              { path: "nested.txt", content: "nested original output" },
              context,
              { key: "nested-write" },
            );
            return { output: [{ type: "text", text: JSON.stringify(result) }] };
          },
        }),
      ],
    });
    source.registry.install(extension);
    await source.root.configure({ extensions: { add: [extension] } }, ctx);
    source.faux.setResponses([
      assistant([toolCall("nested_fixture", {})], { stopReason: "toolUse" }),
      text("nested done"),
    ]);
    await (
      await source.root.submit(
        { type: "input", content: "nested call", requestId: "nested-input" },
        ctx,
      )
    ).wait(ctx);
    await source.harness.waitForIdle(ctx);
    assert.equal(
      await readFile(join(source.workspace, "nested.txt"), "utf8"),
      "nested original output",
    );
    const original = await all(source.root);
    assert.ok(
      original.some((entry) => entry.kind === "pi.tool-result" && entry.byTaskId !== undefined),
    );
    await assert.rejects(source.command("export", {}), /nested.*unsupported/);
    const tail = original.at(-1);
    assert.ok(tail);
    const fork = await source.root.fork(tail.id, { ownership: { kind: "ownerless" } }, ctx);
    const replica = new HistoryReplica(
      source.harness,
      fork.id,
      "b_shared",
      source.workspace,
      source.registry,
    );
    await assert.rejects(
      replica.command({ method: "export", params: {}, trace }),
      /nested.*unsupported/,
    );
    assert.deepEqual(
      await all(source.root),
      original,
      "rejection preserves all original entries and source task provenance",
    );
  } finally {
    await source.harness.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
