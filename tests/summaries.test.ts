import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceKeys,
  paneKey,
  SummaryBatchSchema,
  semanticContent,
  summaryFreshness,
} from "../src/shared/summaries.ts";
import { evidence, report } from "./fixtures.ts";

test("summary protocol separates semantic changes, observation, and deterministic evidence", async () => {
  const fact = evidence("git", "success", {
    source: "git:HEAD+status",
    revision: "a".repeat(40),
  });
  const first = await evidenceKeys([fact]);
  assert.deepEqual(
    Object.keys(
      await evidenceKeys([{ ...fact, observedAt: "2026-09-19T05:51:00Z" }]),
    ),
    Object.keys(first),
  );
  assert.notDeepEqual(
    await evidenceKeys([{ ...fact, revision: "b".repeat(40) }]),
    first,
  );
  assert.deepEqual(
    await evidenceKeys([{ ...fact, source: "manager:claimed-git" }]),
    {},
  );
  const input = {
    protocolVersion: 1,
    machineId: "mac-one",
    managerId: "cherry",
    sequence: 1,
    sentAt: new Date().toISOString(),
    updates: [
      {
        spaceId: "default:w1",
        paneId: "w1:p1",
        taskId: "task-1",
        basis: [],
        observedAt: new Date().toISOString(),
        summary: {
          task: "Ship",
          phase: "verify",
          progress: "Checking",
          outcomes: [],
          blocker: null,
          nextStep: "Verify",
          rationale: "Native reply",
          evidenceRefs: [],
        },
      },
    ],
    checks: [],
  };
  const batch = SummaryBatchSchema.parse(input);
  assert.equal(
    SummaryBatchSchema.safeParse({ ...input, protocolVersion: 2 }).success,
    false,
  );
  assert.equal(
    SummaryBatchSchema.safeParse({
      ...input,
      updates: [input.updates[0], input.updates[0]],
    }).success,
    false,
  );
  assert.equal(
    semanticContent(batch.updates[0]),
    semanticContent({
      ...batch.updates[0],
      observedAt: "2026-09-19T05:51:00Z",
    }),
  );
  const pane = report().spaces[0].tabs[0].panes[0];
  const current = {
    ...batch.updates[0],
    updatedAt: input.sentAt,
    checkedAt: input.sentAt,
    receivedAt: input.sentAt,
    sequence: 1,
    evidence: [],
  };
  assert.equal(
    summaryFreshness(current, pane, input.sentAt, input.sentAt),
    "current",
  );
  assert.equal(
    summaryFreshness(
      current,
      { ...pane, task: { ...pane.task, id: "new-task" } },
      input.sentAt,
      input.sentAt,
    ),
    "superseded",
  );
  assert.equal(
    summaryFreshness(
      current,
      pane,
      input.sentAt,
      new Date(Date.parse(input.sentAt) + 100000).toISOString(),
    ),
    "disconnected",
  );
});

test("opaque space and pane IDs cannot alias across binding boundaries", () => {
  assert.notEqual(
    paneKey({ spaceId: "a/b", paneId: "c" }),
    paneKey({ spaceId: "a", paneId: "b/c" }),
  );
});

test("native activity changes immediately invalidate semantic freshness", async () => {
  const now = new Date().toISOString();
  const pane = report().spaces[0].tabs[0].panes[0];
  const current = {
    spaceId: "default:w1",
    paneId: pane.id,
    taskId: pane.task.id,
    basis: [],
    observedAt: now,
    updatedAt: now,
    checkedAt: now,
    receivedAt: now,
    sequence: 1,
    evidence: [],
    summary: {
      task: "Ship",
      phase: "complete" as const,
      progress: "claimed done",
      outcomes: [],
      blocker: null,
      nextStep: "Verify",
      rationale: "terminal claim",
      evidenceRefs: [],
    },
  };
  pane.evidence = [
    evidence("process", "running", {
      source: "codex:turn-event",
      observedAt: now,
    }),
  ];
  assert.equal(summaryFreshness(current, pane, now, now), "stale");
});
