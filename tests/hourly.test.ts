import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactHour,
  eligibleHour,
  HourlySettingsSchema,
  parseHourlyReport,
  projectHour,
  REPORT_SECTIONS,
  reportPrompt,
  utcHour,
} from "../src/shared/hourly.ts";
import { sealAiKey, unsealAiKey } from "../src/worker/ai-secret.ts";
import { complete, completeReport } from "../src/worker/hourly.ts";
import { report } from "./fixtures.ts";

test("UI credentials use authenticated encryption bound to their AI endpoint", async () => {
  const key = "unique-test-credential";
  const master = "isolated-encryption-master-at-least-32-characters";
  const sealed = await sealAiKey(key, master, "custom:https://ai.example/v1");
  assert(!JSON.stringify(sealed).includes(key));
  assert.equal(await unsealAiKey(sealed, master, sealed.endpoint), key);
  await assert.rejects(
    unsealAiKey(sealed, master, "custom:https://another.example/v1"),
    { name: "AIEndpointMismatchError" },
  );
  assert.notEqual(
    (await sealAiKey(key, master, sealed.endpoint)).data,
    sealed.data,
  );
  await assert.rejects(
    unsealAiKey(
      { ...sealed, endpoint: "custom:https://another.example/v1" },
      master,
      "custom:https://another.example/v1",
    ),
  );
  await assert.rejects(
    unsealAiKey(
      sealed,
      "different-encryption-master-at-least-32-characters",
      sealed.endpoint,
    ),
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

test("model input bounds terminal repetition per task without changing raw evidence or hiding closed tasks", () => {
  const reports = Array.from({ length: 120 }, (_, i) => {
    const value = report(
      `screen-${i}`,
      new Date(Date.UTC(2026, 8, 21, 0, 0, i * 30)).toISOString(),
    );
    const pane = value.spaces[0].tabs[0].panes[0];
    pane.task.id = i < 60 ? "closed-task" : "current-task";
    pane.evidence = [
      {
        kind: "summary",
        status: "unknown",
        source: "herdr:visible (current screen, not final)",
        observedAt: value.capturedAt,
        taskId: pane.task.id,
        summary: `screen ${i}: ${"terminal text ".repeat(120)}`,
      },
    ];
    if (i === 30)
      pane.evidence.push({
        kind: "test",
        status: "failure",
        source: "native:test",
        observedAt: value.capturedAt,
        taskId: pane.task.id,
        summary: "The intermediate test failed",
      });
    if (i === 59)
      pane.evidence.push({
        kind: "summary",
        status: "unknown",
        source: "codex:final-message",
        observedAt: value.capturedAt,
        taskId: pane.task.id,
        summary: "The closed task still needs verification",
      });
    return value;
  });
  const raw = compactHour(reports, [
    {
      value: {
        observedAt: reports[70].capturedAt,
        taskId: "current-task",
        summary: "Semantic change",
      },
    },
  ]);
  const original = structuredClone(raw);
  const projected = projectHour(raw.records);
  assert.deepEqual(raw, original);
  assert.equal(projected.terminalSampling.sourceRecords, 120);
  assert.equal(projected.terminalSampling.retainedRecords, 4);
  const terminal = projected.records.filter((r) =>
    JSON.parse(r.value).source?.startsWith("herdr:visible"),
  );
  assert.deepEqual(
    terminal.map((r) => JSON.parse(r.value).summary.split(":")[0]),
    ["screen 0", "screen 59", "screen 60", "screen 119"],
  );
  assert(
    projected.records.some((r) => r.value.includes("intermediate test failed")),
  );
  assert(
    projected.records.some((r) =>
      r.value.includes("closed task still needs verification"),
    ),
  );
  assert.equal(
    projected.records.filter((r) => r.kind === "semantic").length,
    1,
  );
  assert(
    projected.records.every((r) =>
      raw.records.some(
        (source) => source.id === r.id && source.value === r.value,
      ),
    ),
  );
  assert(
    JSON.stringify(projected.records).length <
      JSON.stringify(raw.records).length / 3,
  );
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
      Object.keys(REPORT_SECTIONS).map((k) => [
        k,
        "暂无可靠证据，待确认。[F1]",
      ]),
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

test("hour reports bound the executive summary and reject fabricated inline citations", () => {
  const valid = {
    ...Object.fromEntries(
      Object.keys(REPORT_SECTIONS).map((key) => [key, "任务等待核实。[F1]"]),
    ),
    evidenceIds: ["F1"],
  };
  for (const changes of [
    { executiveSummary: "长".repeat(601) },
    { deliveries: "本小时发布成功。[F999]" },
    { workspaces: "任务已完成。[S999]" },
  ])
    assert.throws(() =>
      parseHourlyReport(
        JSON.stringify({ ...valid, ...changes }),
        new Set(["F1", "S2"]),
      ),
    );
  const omittedFromIndex = { ...valid, workspaces: "另有待核实记录。[S2]" };
  assert.deepEqual(
    parseHourlyReport(JSON.stringify(omittedFromIndex), new Set(["F1", "S2"])),
    { ...omittedFromIndex, evidenceIds: ["F1", "S2"] },
    "A real inline citation omitted from the index is added without rewriting content",
  );
});

test("truncated model responses fail explicitly before partial JSON can be archived", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      id: "truncated",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: {
            role: "assistant",
            content: '{"executiveSummary":"截断的报告',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
    }),
  );
  await assert.rejects(
    complete(
      HourlySettingsSchema.parse({
        provider: "custom",
        model: "test",
        baseURL: "https://api.ai.example/v1",
      }),
      { AI_API_KEY: "isolated-test-key" } as Env,
      "测试",
    ),
    { name: "AIOutputTruncatedError" },
  );
});

test("oversized reports get one bounded rewrite; invalid evidence never gets repaired", async (t) => {
  const original = {
    ...Object.fromEntries(
      Object.keys(REPORT_SECTIONS).map((key) => [
        key,
        "其余证据保持原样。[F1]",
      ]),
    ),
    executiveSummary: `${"仅 Manager 声称已发布，尚未验证。".repeat(60)}[F1]`,
    evidenceIds: ["F1"],
  };
  let calls = 0;
  let short = "Manager 报告已发布，缺少独立证据，需核对部署。[F1]";
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      id: "rewrite",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(
              calls % 2 ? original : { ...original, executiveSummary: short },
            ),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  });
  const settings = HourlySettingsSchema.parse({
    provider: "custom",
    model: "test",
    baseURL: "https://api.ai.example/v1",
  });
  const env = { AI_API_KEY: "isolated-test-key" } as Env;
  assert.deepEqual(
    await completeReport(settings, env, "测试", new Set(["F1"])),
    { ...original, executiveSummary: short },
  );
  assert.equal(calls, 2);
  short = original.executiveSummary;
  await assert.rejects(completeReport(settings, env, "测试", new Set(["F1"])));
  assert.equal(calls, 4, "Never retry compression in a loop");
  original.evidenceIds = ["invented"];
  await assert.rejects(completeReport(settings, env, "测试", new Set(["F1"])));
  assert.equal(calls, 5, "Unknown evidence fails before compression");
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

test("hourly final sections and total text are bounded, including citations", () => {
  const brief = Object.fromEntries(
    Object.keys(REPORT_SECTIONS).map((key) => [key, "待核实。[F1]"]),
  );
  for (const changes of [
    { workspaces: "长".repeat(1801) },
    { executiveSummary: "长".repeat(201) },
    { deliveries: "长".repeat(801) },
    { resources: "长".repeat(301) },
    { risks: "长".repeat(501) },
    { nextSteps: "长".repeat(301) },
    { evidence: "长".repeat(301) },
  ]) {
    assert.throws(() =>
      parseHourlyReport(
        JSON.stringify({ ...brief, ...changes, evidenceIds: ["F1"] }),
        new Set(["F1"]),
      ),
    );
  }
});

test("oversized workspace composition is compressed once with validated original citations", async (t) => {
  const brief = {
    ...Object.fromEntries(
      Object.keys(REPORT_SECTIONS).map((key) => [
        key,
        "Manager 报告待核实。[F1]",
      ]),
    ),
    evidenceIds: ["F1"],
  };
  const original = {
    ...brief,
    workspaces: `${"尚未独立验证。".repeat(2400)}[F1]`,
  };
  let calls = 0;
  let compressed: Record<string, unknown> = brief;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      id: "bounded",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(calls % 2 ? original : compressed),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  });
  const settings = HourlySettingsSchema.parse({
    provider: "custom",
    model: "test",
    baseURL: "https://api.ai.example/v1",
  });
  const env = { AI_API_KEY: "isolated-test-key" } as Env;
  assert.deepEqual(
    await completeReport(settings, env, "测试", new Set(["F1", "F2"])),
    brief,
  );
  assert.equal(calls, 2);
  compressed = original;
  await assert.rejects(completeReport(settings, env, "测试", new Set(["F1"])));
  assert.equal(calls, 4);
  compressed = { ...brief, workspaces: "捏造来源。[F2]", evidenceIds: ["F2"] };
  await assert.rejects(
    completeReport(settings, env, "测试", new Set(["F1", "F2"])),
  );
  assert.equal(calls, 6);
});
