import { Badge, Button, Label, LayerCard } from "@nocoo/basalt";
import { DatePicker } from "@nocoo/basalt/components/date-picker";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nocoo/basalt/components/select";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import {
  CalendarDays,
  ChevronDown,
  Clock3,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type HourlyJobView,
  type HourlyReport,
  REPORT_SECTIONS,
} from "../shared/hourly.ts";
import { api } from "./api.ts";
import { useTimezone } from "./Timezone.tsx";

function ReportCard({ report }: { report: HourlyReport }) {
  const { time, zone } = useTimezone();
  const [expanded, setExpanded] = useState(false);
  return (
    <LayerCard
      role="article"
      aria-label={`${report.machineName} 小时报告`}
      className="hourly-report"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="purple">
              <Sparkles size={11} />
              AI 小时报告
            </Badge>
            <span className="text-sm font-medium">{report.machineName}</span>
          </div>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-basalt-muted-foreground">
            <Clock3 size={12} />
            <time dateTime={report.hour} title={`${time(report.hour)} ${zone}`}>
              {time(report.hour).slice(0, -3)} —{" "}
              {time(
                new Date(Date.parse(report.hour) + 3600000).toISOString(),
              ).slice(-8, -3)}
            </time>
            <span>（{zone}）</span>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown
            size={14}
            className={
              expanded
                ? "rotate-180 transition-transform"
                : "transition-transform"
            }
          />
          {expanded ? "收起报告" : "展开报告"}
        </Button>
      </div>
      <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap">
        {report.content.executiveSummary}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-basalt-muted-foreground">
        <span>{report.snapshots} 次采集</span>
        <span>{report.semanticRecords} 条语义记录</span>
        <span>{report.model}</span>
        <span>生成于 {time(report.generatedAt)}</span>
      </div>
      {expanded && (
        <div className="hourly-report-sections">
          {Object.entries(REPORT_SECTIONS).map(([key, title]) => (
            <section key={key}>
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-7 whitespace-pre-wrap break-words text-basalt-muted-foreground">
                {report.content[key as keyof typeof REPORT_SECTIONS]}
              </p>
            </section>
          ))}
          <p className="text-xs break-all text-basalt-muted-foreground">
            {time(report.hour)} {zone} · {report.templateVersion}
            <br />
            数据覆盖：
            {report.firstObservedAt
              ? time(report.firstObservedAt)
              : "无确定性快照"}{" "}
            —{" "}
            {report.lastObservedAt
              ? time(report.lastObservedAt)
              : "无确定性快照"}
            <br />
            输入指纹：{report.inputHash}
          </p>
        </div>
      )}
    </LayerCard>
  );
}

function GenerationStatus({ jobs }: { jobs: HourlyJobView[] }) {
  const { time } = useTimezone();
  if (!jobs.length) return null;
  const pending = jobs
    .filter((job) => job.status !== "complete")
    .sort((a, b) => b.hour.localeCompare(a.hour));
  const waiting = pending.filter((job) => job.status !== "discarded");
  const discarded = pending.length - waiting.length;
  const lastSuccess = jobs
    .flatMap((job) => (job.lastSuccessAt ? [job.lastSuccessAt] : []))
    .sort()
    .at(-1);
  const stages: Record<string, string> = {
    input: "整理输入",
    model_chunk: "整理材料",
    model_reduce: "合并材料",
    model_final: "生成报告",
    validation: "校验报告",
    archive: "保存报告",
  };
  const errors: Record<string, string> = {
    timeout: "模型响应超时",
    input_too_large: "单条材料超过处理上限",
    invalid_output: "模型结果未通过校验",
    archive_unavailable: "报告保存失败",
    generation_failed: "模型调用失败",
    storage_unavailable: "存储暂不可用",
  };
  return (
    <LayerCard role="region" aria-label="报告生成状态">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {waiting.length
            ? `${waiting.length} 个小时待生成`
            : "当前无待生成小时"}
          {discarded > 0 && ` · ${discarded} 个小时已取消（原始数据保留）`}
        </span>
        {lastSuccess && (
          <span className="text-basalt-muted-foreground">
            最近成功 {time(lastSuccess)}
          </span>
        )}
      </div>
      {pending.length > 0 && (
        <ul className="mt-2 max-h-64 divide-y divide-basalt-border overflow-y-auto">
          {pending.map((job) => (
            <li
              key={`${job.machineId}:${job.hour}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs"
            >
              <span>
                {job.machineName} · {time(job.hour).slice(0, -3)}
              </span>
              <Badge
                variant={
                  job.status === "blocked" || job.status === "retrying"
                    ? "warning"
                    : "info"
                }
              >
                {
                  {
                    pending: "等待生成",
                    running: "正在生成",
                    retrying: "等待重试",
                    blocked: "需要处理",
                    complete: "已生成",
                    discarded: "已取消",
                  }[job.status]
                }
              </Badge>
              {job.totalParts > 0 && (
                <span>
                  {job.completedParts} / {job.totalParts} 份材料已整理
                </span>
              )}
              {job.attempts > 0 && (
                <span className="text-basalt-muted-foreground">
                  已尝试 {job.attempts} 次
                </span>
              )}
              {job.error && (
                <span className="text-basalt-muted-foreground">
                  {stages[job.stage] ?? "生成报告"}：
                  {errors[job.error] ?? "生成失败"}
                </span>
              )}
              {job.retryAt > 0 && job.status === "retrying" && (
                <span className="text-basalt-muted-foreground">
                  下次重试不早于 {time(new Date(job.retryAt).toISOString())}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </LayerCard>
  );
}

export function HourlyHistory({ machine }: { machine: string }) {
  const { offset, zone } = useTimezone();
  const minute = String(((offset % 60) + 60) % 60).padStart(2, "0");
  const [entries, setEntries] = useState<
    { seq: number; report: HourlyReport }[]
  >([]);
  const [jobs, setJobs] = useState<HourlyJobView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [localHour, setLocalHour] = useState("00");
  const hour = date
    ? new Date(
        Date.parse(`${date}T${localHour}:${minute}:00Z`) - offset * 60000,
      ).toISOString()
    : "";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (before?: string) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ limit: "12" });
      if (machine) query.set("machine", machine);
      if (hour) query.set("hour", hour);
      if (before) query.set("before", String(before));
      try {
        const result = await api<{
          entries: { seq: number; report: HourlyReport }[];
          jobs: HourlyJobView[];
          nextCursor: string | null;
        }>(`/api/v1/hourly-reports?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setEntries((old) =>
            before
              ? [...old, ...(result.entries ?? [])]
              : (result.entries ?? []),
          );
          setCursor(result.nextCursor);
          setJobs(result.jobs ?? []);
        }
      } catch {
        if (!controller.signal.aborted)
          setError("小时报告读取失败，保留已显示的报告。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [machine, hour],
  );
  useEffect(() => {
    setEntries([]);
    setJobs([]);
    void load();
    return () => active.current?.abort();
  }, [load]);
  return (
    <SectionRule title="小时报告" hint={`每台机器的中文工作报告 · ${zone}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="report-date">筛选小时（{zone}）</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-44">
                <DatePicker
                  id="report-date"
                  aria-label="报告日期"
                  value={date}
                  onChange={setDate}
                  locale="zh-CN"
                  timeZone={zone.slice(3).replace("−", "-")}
                  labels={{
                    calendar: "选择报告日期",
                    placeholder: "选择日期",
                    previousMonth: "上个月",
                    nextMonth: "下个月",
                    keyboardInstructions:
                      "方向键移动日期，PageUp / PageDown 切换月份，Enter 选择日期。",
                  }}
                  className="h-9 w-full pl-9 pr-3"
                />
                <CalendarDays
                  size={16}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-basalt-muted-foreground"
                />
              </div>
              <Select
                value={localHour}
                onValueChange={setLocalHour}
                disabled={!date}
              >
                <SelectTrigger aria-label="报告小时" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[min(16rem,var(--radix-select-content-available-height))]">
                  {Array.from({ length: 24 }, (_, h) => {
                    const value = String(h).padStart(2, "0");
                    return (
                      <SelectItem key={value} value={value}>
                        {value}:{minute}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="ghost"
                aria-label="清除时间筛选"
                disabled={!date}
                onClick={() => {
                  setDate("");
                  setLocalHour("00");
                }}
              >
                清除
              </Button>
            </div>
          </div>
          <Button
            aria-label="刷新小时报告"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={14} className={loading ? "eagle-spin" : ""} />
            刷新报告
          </Button>
        </div>
        <GenerationStatus jobs={jobs} />
        {error && (
          <p role="alert" className="text-sm text-basalt-destructive">
            {error}
          </p>
        )}
        {loading && !entries.length && (
          <LayerCard>
            <div
              role="status"
              aria-label="正在加载小时报告"
              className="space-y-3"
            >
              <SkeletonLine />
              <SkeletonLine />
              <SkeletonLine />
            </div>
          </LayerCard>
        )}
        {!loading && !entries.length && !error && (
          <LayerCard>
            <p className="text-sm">暂无小时报告</p>
            <p className="mt-2 text-xs text-basalt-muted-foreground">
              在设置中配置 AI 后，Eagle 会自动生成已结束小时的报告。未配置
              AI、无数据或尚未到生成时间时自动跳过。
            </p>
          </LayerCard>
        )}
        {entries.map(({ seq, report }) => (
          <ReportCard key={seq} report={report} />
        ))}
        {cursor && (
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            加载更多小时报告
          </Button>
        )}
      </div>
    </SectionRule>
  );
}
