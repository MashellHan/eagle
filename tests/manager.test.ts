import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ManagerInput, managerTick } from "../agent/manager.ts";
import type { SummaryBatch, SummaryUpdate } from "../src/shared/summaries.ts";
import { report } from "./fixtures.ts";

test("Manager calls interpretation only for changed inputs and preserves identical failed batches for retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-manager-"));
  try {
    let calls = 0;
    let fail = false;
    const batches: SummaryBatch[] = [];
    let remote: SummaryUpdate[] = [];
    const snapshot = report("manager-snapshot", new Date().toISOString());
    const config = {
      url: "http://127.0.0.1:37053",
      token: "test-token-not-for-model-at-least-32-chars",
      machineId: "mac-one",
      machineName: "Mac One",
    };
    const transport = async (
      input: string | URL | Request,
      options?: RequestInit,
    ) => {
      if (String(input).endsWith("agent-state"))
        return Response.json({
          report: snapshot,
          id: "mac-one",
          lastSeen: new Date().toISOString(),
          summaries: remote,
        });
      const batch = JSON.parse(String(options?.body));
      batches.push(batch);
      if (!fail && batch.updates.length) remote = batch.updates;
      return fail
        ? new Response("", { status: 503 })
        : Response.json({
            accepted: true,
            duplicate: false,
            sequence: batch.sequence,
          });
    };
    const analyze = async (inputs: ManagerInput[]) => {
      calls++;
      if (inputs[0].taskId === "new-task")
        assert.equal(
          inputs[0].previous,
          null,
          "Previous interpretation must not cross task boundaries",
        );
      assert(!JSON.stringify(inputs).includes(config.token));
      return inputs.map((i) => ({
        key: i.key,
        summary: {
          task: "正在实现 Eagle",
          phase: "implement",
          progress: "正在实现采集",
          outcomes: [],
          blocker: null,
          nextStep: "测试",
          rationale: "终端可见",
          evidenceRefs: [],
        },
      }));
    };
    const dependencies = {
      transport: transport as typeof fetch,
      readPane: async () => `actual output ${config.token}`,
      analyze,
    };
    await managerTick(config, directory, dependencies);
    assert.equal(calls, 1);
    await managerTick(config, directory, dependencies);
    assert.equal(calls, 1);
    assert.equal(batches[1].updates.length, 0);
    assert.equal(batches[1].checks.length, 1);
    fail = true;
    await assert.rejects(managerTick(config, directory, dependencies));
    const pending = batches.at(-1);
    fail = false;
    await managerTick(config, directory, dependencies);
    assert.deepEqual(batches.at(-1), pending);
    assert.equal(calls, 1);
    remote = [];
    await managerTick(config, directory, dependencies);
    assert.equal(
      calls,
      1,
      "Missing remote summary is restored from the matching cache without another LLM call",
    );
    assert.equal(batches.at(-1)?.updates.length, 1);
    snapshot.spaces[0].tabs[0].panes[0].task.id = "new-task";
    await managerTick(config, directory, dependencies);
    assert.equal(
      calls,
      2,
      "A new task is not delayed by the previous task cooldown",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed interpretation is durably debounced and concurrent runs are excluded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-manager-failure-"));
  try {
    const snapshot = report("failure", new Date().toISOString());
    const config = {
      url: "http://127.0.0.1:37053",
      token: "test-token-with-at-least-32-characters",
      machineId: "mac-one",
      machineName: "Mac One",
    };
    let calls = 0;
    let release: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = {
      transport: (async (url, options) =>
        String(url).endsWith("agent-state")
          ? Response.json({ report: snapshot })
          : Response.json({
              accepted: true,
              sequence: JSON.parse(String(options?.body)).sequence,
            })) as typeof fetch,
      readPane: async () => "changed input",
      analyze: async () => {
        calls++;
        await paused;
        throw new Error("provider unavailable");
      },
    };
    const first = managerTick(config, directory, dependencies);
    while (!calls) await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(
      Promise.race([
        managerTick(config, directory, dependencies),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("lock missing")), 100),
        ),
      ]),
      /already running/,
    );
    release();
    await assert.rejects(first, /provider unavailable/);
    await managerTick(config, directory, dependencies);
    assert.equal(
      calls,
      1,
      "failed calls must not repeat on every heartbeat or process restart",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one rejected Pane update is isolated without discarding valid interpretations or invoking the model again", async () => {
  const { taskKey } = await import("../src/shared/summaries.ts");
  const directory = await mkdtemp(join(tmpdir(), "eagle-isolate-"));
  try {
    const snapshot = report("isolate", new Date().toISOString());
    const second = structuredClone(snapshot.spaces[0].tabs[0].panes[0]);
    second.id = "w1:p2";
    snapshot.spaces[0].tabs[0].panes.push(second);
    let calls = 0;
    const delivered: SummaryBatch[] = [];
    const dependencies = {
      readPane: async () => "real output",
      analyze: async (inputs: ManagerInput[]) => {
        calls++;
        return inputs.map((i) => ({
          key: i.key,
          summary: {
            task: "task",
            phase: "verify",
            progress: "progress",
            outcomes: [],
            blocker: null,
            nextStep: "next",
            rationale: "reason",
            evidenceRefs: [],
          },
        }));
      },
      transport: (async (url, options) => {
        if (String(url).endsWith("agent-state"))
          return Response.json({ report: snapshot });
        const batch = JSON.parse(String(options?.body)) as SummaryBatch;
        delivered.push(batch);
        const bad = batch.updates.find((e) => e.paneId === "w1:p2");
        return bad
          ? Response.json(
              { error: "unknown_evidence", entry: taskKey(bad) },
              { status: 409 },
            )
          : Response.json({ accepted: true, sequence: batch.sequence });
      }) as typeof fetch,
    };
    await managerTick(
      {
        url: "http://127.0.0.1:37053",
        machineId: "mac-one",
        machineName: "Mac",
        token: "at-least-thirty-two-characters-token",
      },
      directory,
      dependencies,
    );
    assert.equal(calls, 1);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].updates.length, 1);
    assert.equal(delivered[1].updates[0].paneId, "w1:p1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
