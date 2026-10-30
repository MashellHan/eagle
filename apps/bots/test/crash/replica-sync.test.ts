import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { text, waitFor } from "../support/pi.ts";
import { openReplica, pull } from "../support/replica.ts";

const childEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (!["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR"].includes(key))
      delete env[key];
  return env;
};
const killAtCommit = async (input: unknown) => {
  const child = spawn(
    process.execPath,
    [new URL("./support/replica-child.ts", import.meta.url).pathname],
    { env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    output += value;
  });
  child.stderr.on("data", (value: string) => {
    error = (error + value).slice(-10_000);
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`child exited before durable barrier: ${error}`);
      return output.includes("durable-replica-barrier\n");
    }, "actual owned child commit barrier");
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  assert.equal(child.signalCode, "SIGKILL");
};

test("SIGKILL across local intent/admission/output commits restores original IDs and fills the durable outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-outbox-crash-"));
  try {
    for (const mode of ["intent", "admission", "output"]) {
      const target = join(dir, mode);
      await killAtCommit({ dir: target, mode });
      const replica = await openReplica(target, "b_replica", [
        text("one committed original output"),
      ]);
      try {
        await replica.harness.waitForIdle(ctx);
        const page = await pull(replica);
        const records = page.events.filter((event) => event.body.kind === "entry");
        assert.equal(
          records.filter(
            (event) => event.body.kind === "entry" && event.body.content.kind === "pi.user",
          ).length,
          1,
          mode,
        );
        assert.equal(
          records.filter(
            (event) => event.body.kind === "entry" && event.body.content.kind === "pi.assistant",
          ).length,
          1,
          mode,
        );
        assert.equal(replica.sync.store.run("crash-local")?.admitted, true);
        assert.equal(
          replica.faux.state.callCount,
          mode === "output" ? 0 : 1,
          "committed output is not regenerated",
        );
        const count = replica.faux.state.callCount;
        await replica.sync.root(
          {
            requestId: "crash-local",
            text: "one local input",
            whenBusy: "followUp",
            trace: "tr_sync_crash",
          },
          () =>
            replica.root.submit(
              { type: "input", requestId: "crash-local", content: "one local input" },
              ctx,
            ),
        );
        assert.equal(replica.faux.state.callCount, count);
        assert.equal(
          (await pull(replica, page.nextAfter)).events.filter(
            (event) => event.body.kind === "entry",
          ).length,
          0,
        );
      } finally {
        await replica.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL after incoming log save or SDK passive commit confirms only durable materialization and never executes foreign input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-incoming-crash-"));
  const source = await openReplica(join(dir, "source"));
  try {
    source.faux.setResponses([text("source output")]);
    await (
      await source.sync.root(
        {
          requestId: "source-id",
          text: "foreign input",
          whenBusy: "followUp",
          trace: "tr_sync_crash",
        },
        () =>
          source.root.submit(
            { type: "input", requestId: "source-id", content: "foreign input" },
            ctx,
          ),
      )
    ).wait(ctx);
    await source.harness.waitForIdle(ctx);
    const page = await pull(source);
    const head = page.events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(head?.kind === "head");
    const expected = await source.root.context(ctx);
    for (const mode of ["incoming", "materialized"]) {
      const target = join(dir, mode);
      await killAtCommit({ dir: target, mode, sharedBotId: page.sharedBotId, page });
      const replica = await openReplica(target);
      try {
        assert.equal(replica.sync.store.stream(page.source).applied, page.nextAfter);
        assert.equal(replica.sync.store.ready(head.head), true);
        const receipt = await replica.history.receipt(head.head);
        assert.ok(receipt);
        const conversation = await replica.harness.conversation(
          receipt.conversationId as import("@earendil-works/pi-durable").ConversationId,
          ctx,
        );
        assert.ok(conversation);
        assert.deepEqual((await conversation.context(ctx)).messages, expected.messages);
        const before = replica.sync.store.status();
        await replica.command("apply", { page });
        assert.deepEqual(replica.sync.store.status(), before);
        assert.equal(replica.sync.store.pending().length, 0);
        assert.equal(replica.faux.state.callCount, 0);
        assert.equal((await pull(replica)).events.length, 0);
      } finally {
        await replica.close();
      }
    }
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
