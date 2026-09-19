import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactHour,
  eligibleHour,
  HourlySettingsSchema,
  parseHourlyReport,
  REPORT_SECTIONS,
  reportPrompt,
  utcHour,
} from "../src/shared/hourly.ts";
import { sealAiKey, unsealAiKey } from "../src/worker/ai-secret.ts";
import { report } from "./fixtures.ts";

test("UI credentials use authenticated encryption bound to their AI endpoint", async () => {
  const key = "unique-test-credential";
  const master = "isolated-encryption-master-at-least-32-characters";
  const sealed = await sealAiKey(key, master, "custom:https://ai.example/v1");
  assert(!JSON.stringify(sealed).includes(key));
  assert.equal(await unsealAiKey(sealed, master), key);
  assert.notEqual(
    (await sealAiKey(key, master, sealed.endpoint)).data,
    sealed.data,
  );
  await assert.rejects(
    unsealAiKey(
      { ...sealed, endpoint: "custom:https://another.example/v1" },
      master,
    ),
  );
  await assert.rejects(
    unsealAiKey(sealed, "different-encryption-master-at-least-32-characters"),
  );
  await assert.rejects(sealAiKey(key, undefined, sealed.endpoint));
});

test("hour inputs keep closed panes, task changes, every evidence and independent semantic times", () => {
  const first = report("start", "2026-09-19T09:01:00.000Z");
  const second = structuredClone(first);
  second.reportId = "end";
  second.capturedAt = "2026-09-19T09:59:00.000Z";
  second.spaces[0].tabs[0].panes = [];
  const input = compactHour(
    [first, second],
    [
      {
        seq: 7,
        hour: utcHour(first.capturedAt),
        value: {
          observedAt: "2026-09-19T09:17:00.000Z",
          taskId: "task-1",
          summary: "完成代码检查",
        },
      },
    ],
  );
  assert(
    input.records.some(
      (r) => r.kind === "pane" && JSON.stringify(r.value).includes("w1:p1"),
    ),
  );
  assert.equal(input.records.filter((r) => r.kind === "inventory").length, 2);
  assert.equal(input.records.filter((r) => r.kind === "semantic").length, 1);
  assert.equal(input.snapshots, 2);
  const repeated = compactHour(
    [first, { ...first, reportId: "again", capturedAt: second.capturedAt }],
    [],
  );
  const pane = repeated.records.find((r) => r.kind === "pane");
  assert.deepEqual(pane?.observations, [first.capturedAt, second.capturedAt]);
  assert.equal(repeated.records.filter((r) => r.kind === "pane").length, 1);
});

test("UTC hourly boundaries, defaults and locked Chinese template are explicit", () => {
  assert.equal(
    utcHour("2026-09-20T00:59:59+08:00"),
    "2026-09-19T16:00:00.000Z",
  );
  assert.equal(HourlySettingsSchema.parse({}).intervalHours, 1);
  assert.equal(
    HourlySettingsSchema.safeParse({ intervalHours: 0 }).success,
    false,
  );
  const prompt = reportPrompt("mac-one", "2026-09-19T09:00:00.000Z", "[]");
  for (const key of Object.keys(REPORT_SECTIONS)) assert(prompt.includes(key));
  assert(prompt.includes("中文"));
  assert(prompt.includes("不能"));
  const valid = {
    ...Object.fromEntries(
      Object.keys(REPORT_SECTIONS).map((k) => [k, "暂无可靠证据，待确认。"]),
    ),
    evidenceIds: ["F1"],
  };
  assert.deepEqual(
    parseHourlyReport(JSON.stringify(valid), new Set(["F1"])),
    valid,
  );
  assert.throws(() =>
    parseHourlyReport(
      JSON.stringify({ ...valid, evidenceIds: ["invented"] }),
      new Set(["F1"]),
    ),
  );
  assert.throws(() =>
    parseHourlyReport(JSON.stringify({ executiveSummary: "完成" }), new Set()),
  );
  assert.throws(() =>
    parseHourlyReport(
      JSON.stringify({ ...valid, evidenceIds: [] }),
      new Set(["F1"]),
    ),
  );
});

test("long cadences keep the last due boundary open for catch-up and semantic-only coverage stays explicit", () => {
  assert.equal(
    eligibleHour(Date.parse("2026-09-19T13:05:00Z"), 2),
    "2026-09-19T12:00:00.000Z",
  );
  assert.equal(
    eligibleHour(Date.parse("2026-09-19T14:05:00Z"), 2),
    "2026-09-19T14:00:00.000Z",
  );
  const observedAt = "2026-09-19T09:17:00.000Z";
  const input = compactHour(
    [],
    [{ value: { observedAt, summary: "语义记录" } }],
  );
  assert.equal(input.firstObservedAt, observedAt);
  assert.equal(input.lastObservedAt, observedAt);
  assert.deepEqual(input.records[0].observations, [observedAt]);
});
