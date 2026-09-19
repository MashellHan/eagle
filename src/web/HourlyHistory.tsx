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
  type HourlyReport,
  REPORT_SECTIONS,
  utcHour,
} from "../shared/hourly.ts";
import { api, time } from "./api.ts";

function ReportCard({ report }: { report: HourlyReport }) {
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
            <time dateTime={report.hour} title={report.hour}>
              {time(report.hour).slice(0, -3)} —{" "}
              {time(
                new Date(Date.parse(report.hour) + 3600000).toISOString(),
              ).slice(-8, -3)}
            </time>
            <span>（本地时间）</span>
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
            UTC {report.hour} · {report.templateVersion}
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

export function HourlyHistory({ machine }: { machine: string }) {
  const [entries, setEntries] = useState<
    { seq: number; report: HourlyReport }[]
  >([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [localHour, setLocalHour] = useState("00");
  const hour = date ? `${date}T${localHour}:00` : "";
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
      if (hour) query.set("hour", utcHour(hour));
      if (before) query.set("before", String(before));
      try {
        const result = await api<{
          entries: { seq: number; report: HourlyReport }[];
          nextCursor: string | null;
        }>(`/api/v1/hourly-reports?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setEntries((old) =>
            before
              ? [...old, ...(result.entries ?? [])]
              : (result.entries ?? []),
          );
          setCursor(result.nextCursor);
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
    void load();
    return () => active.current?.abort();
  }, [load]);
  return (
    <SectionRule
      title="小时报告"
      hint="每台机器的中文工作报告 · 按 UTC 小时归档"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="report-date">筛选小时（本地时间）</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-44">
                <DatePicker
                  id="report-date"
                  aria-label="报告日期"
                  value={date}
                  onChange={setDate}
                  locale="zh-CN"
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
                        {value}:00
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
