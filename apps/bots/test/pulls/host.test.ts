// The pull-request host (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group): composition only —
// the store keeps the reports, the host hands the tools what they may see.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PullStore, pullJournalPath } from "../../src/core/PullStore.ts";
import { composePulls, pullHostFor, pullPublisher } from "../../src/pulls/host.ts";

const withHost = async (run: (host: ReturnType<typeof pullHostFor>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "bots-pulls-host-"));
  try {
    const store = await PullStore.open(pullJournalPath(root));
    await run(pullHostFor("b_self", store));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("the host names its bot and hands back the reported row", async () => {
  await withHost(async (host) => {
    assert.equal(host.botId, "b_self");
    const { pull, created } = await host.register({
      opId: "task-1",
      url: "https://github.com/nocoo/eagle/pull/490",
      title: "v3.1.1 补丁版",
      status: "open",
    });
    assert.equal(created, true);
    assert.deepEqual(pull, {
      url: "https://github.com/nocoo/eagle/pull/490",
      title: "v3.1.1 补丁版",
      status: "open",
      host: "github.com",
      updatedAt: pull.updatedAt,
    });
  });
});

test("the list is what the store holds, newest first", async () => {
  await withHost(async (host) => {
    await host.register({
      opId: "task-1",
      url: "https://github.com/nocoo/eagle/pull/490",
      title: "first",
      status: "open",
    });
    await host.register({
      opId: "task-2",
      url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12",
      title: "second",
      status: "merged",
    });
    const pulls = await host.list();
    assert.deepEqual(
      pulls.map((pull) => `${pull.status}@${pull.host}`),
      ["merged@dev.azure.com", "open@github.com"],
    );
  });
});

test("a refused report reaches the caller instead of being stored", async () => {
  await withHost(async (host) => {
    await assert.rejects(
      () =>
        host.register({ opId: "task-1", url: "file:///etc/passwd", title: "x", status: "open" }),
      /is not a link|must be http/,
    );
    assert.deepEqual(await host.list(), []);
  });
});

test("the composition wires a bot directory to a host, a list and one sink", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-pulls-compose-"));
  try {
    const sink = pullPublisher();
    // Before the service exists the sink drops nothing on the floor.
    sink.publish("b_self", []);
    const composed = composePulls({
      botDir: (botId) => join(root, botId),
      publish: sink,
    });
    const published: Array<readonly string[]> = [];
    sink.set((botId, pulls) => published.push(pulls.map((pull) => `${botId}:${pull.status}`)));

    const host = await composed.runtimeHost({
      id: "b_self",
      dir: join(root, "b_self"),
      model: { provider: "faux", modelId: "faux-1" },
      trace: "tr_pulls_compose",
    });
    await host.register({
      opId: "task-1",
      url: "https://github.com/nocoo/eagle/pull/490",
      title: "v3.1.1 补丁版",
      status: "merged",
    });
    assert.deepEqual(published, [["b_self:merged"]], "the sink hears every change");
    assert.deepEqual(
      (await composed.list("b_self")).map((pull) => pull.status),
      ["merged"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
