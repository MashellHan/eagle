import {
  Badge,
  Button,
  Input,
  LayerCard,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import { SlotBarChart } from "@nocoo/basalt/charts/slot-bar";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCheck,
  CircleHelp,
  Clock3,
  Cpu,
  GitBranch,
  HardDrive,
  Layers3,
  ListChecks,
  MemoryStick,
  Radio,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Target,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { assessPane, summarize } from "../shared/assessment.ts";
import {
  type MachineView,
  type Pane,
  type Space,
  STATE_LABEL,
  type State,
} from "../shared/schema.ts";
import { age, time } from "./api.ts";

const states: State[] = ["active", "attention", "verified", "unverified"];
export const tones = {
  active: "info",
  attention: "warning",
  verified: "success",
  unverified: "purple",
} as const;
const stateIcons = {
  active: Activity,
  attention: TriangleAlert,
  verified: CheckCheck,
  unverified: CircleHelp,
};
const stateColors = {
  active: "hsl(var(--basalt-accent-1))",
  attention: "hsl(var(--basalt-accent-7))",
  verified: "hsl(var(--basalt-accent-4))",
  unverified: "hsl(var(--basalt-accent-10))",
};
const evidenceKinds = [
  "summary",
  "goal",
  "git",
  "test",
  "process",
  "deployment",
] as const;
const evidenceNames = {
  summary: "最终总结",
  goal: "Goal",
  git: "Git",
  test: "测试",
  process: "进程",
  deployment: "线上",
};
const evidenceIcons = {
  summary: ListChecks,
  goal: Target,
  git: GitBranch,
  test: ShieldCheck,
  process: Activity,
  deployment: Radio,
};
const agentTone = (agent: string) =>
  agent === "codex"
    ? "blue"
    : agent === "grok"
      ? "purple"
      : agent === "pi"
        ? "orange"
        : "teal";
const agentColor = (agent: string) =>
  `hsl(var(--basalt-accent-${agent === "codex" ? 1 : agent === "grok" ? 10 : agent === "pi" ? 7 : 3}))`;
const accent = (color: string): CSSProperties =>
  ({ "--eagle-color": color }) as CSSProperties;
export function Status({ state }: { state: State }) {
  return (
    <Badge variant={tones[state]} dot>
      {STATE_LABEL[state]}
    </Badge>
  );
}
export function isStale(machine: MachineView, now: string) {
  return (
    age(machine.lastSeen, now) > 90 || age(machine.report.capturedAt, now) > 300
  );
}

function MachineResources({
  machine,
  now,
}: {
  machine: MachineView;
  now: string;
}) {
  const telemetry = machine.report.machine.telemetry;
  const resources = telemetry?.resources;
  const stale =
    isStale(machine, now) || (telemetry && age(telemetry.observedAt, now) > 90);
  const gib = (value: number) =>
    new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(
      value / 1024 ** 3,
    );
  return (
    <section aria-label="机器资源" className="mb-3">
      {!telemetry ? (
        <p className="text-xs text-basalt-muted-foreground">尚未上报机器资源</p>
      ) : (
        <LayerCard className="p-3">
          {stale && (
            <Badge variant="secondary" className="mb-2">
              历史快照 · 等待更新
            </Badge>
          )}
          {resources ? (
            <dl
              className={`grid grid-cols-2 gap-x-4 gap-y-3 text-xs md:grid-cols-4 ${stale ? "opacity-60" : ""}`}
            >
              <div
                className="min-w-0"
                title={`${resources.cpuModel} · 采样 ${resources.cpuSampleMs} ms；负载为 1/5/15 分钟平均值`}
              >
                <dt className="mb-1 flex items-center gap-1.5 text-basalt-muted-foreground">
                  <Cpu size={13} />
                  CPU <span className="ml-auto">{resources.cpuCores} 核</span>
                </dt>
                <dd className="font-semibold tabular-nums">
                  {resources.cpuUsagePercent === null
                    ? "未知"
                    : `${resources.cpuUsagePercent}%`}
                </dd>
                <dd className="mt-1 truncate text-[10px] text-basalt-muted-foreground">
                  负载{" "}
                  {resources.loadAverage
                    ?.map((n) => n.toFixed(1))
                    .join(" / ") ?? "未知"}
                </dd>
              </div>
              <div title="已用量为总内存减去系统报告的空闲内存；缓存可能计入，不代表内存压力。">
                <dt className="mb-1 flex items-center gap-1.5 text-basalt-muted-foreground">
                  <MemoryStick size={13} />
                  内存
                </dt>
                <dd className="font-semibold tabular-nums">
                  {gib(
                    resources.memory.totalBytes - resources.memory.freeBytes,
                  )}{" "}
                  / {gib(resources.memory.totalBytes)} GiB
                </dd>
                <dd className="mt-1 text-[10px] text-basalt-muted-foreground">
                  空闲 {gib(resources.memory.freeBytes)} GiB
                </dd>
              </div>
              <div title="采集器用户主目录所在文件系统的容量和可用空间。">
                <dt className="mb-1 flex items-center gap-1.5 text-basalt-muted-foreground">
                  <HardDrive size={13} />
                  磁盘可用
                </dt>
                <dd className="font-semibold tabular-nums">
                  {resources.disk
                    ? `${gib(resources.disk.availableBytes)} GiB`
                    : "未知"}
                </dd>
                <dd className="mt-1 text-[10px] text-basalt-muted-foreground">
                  {resources.disk
                    ? `总计 ${gib(resources.disk.totalBytes)} GiB`
                    : "磁盘信息不可读"}
                </dd>
              </div>
              <div>
                <dt className="mb-1 flex items-center gap-1.5 text-basalt-muted-foreground">
                  <Clock3 size={13} />
                  运行时间
                </dt>
                <dd className="font-semibold tabular-nums">
                  {Math.floor(resources.uptimeSeconds / 86400)} 天{" "}
                  {Math.floor(resources.uptimeSeconds / 3600) % 24} 小时
                </dd>
                <dd className="mt-1 text-[10px] text-basalt-muted-foreground">
                  <time dateTime={telemetry.observedAt}>
                    {time(telemetry.observedAt)}
                  </time>{" "}
                  采样
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-basalt-muted-foreground">
              资源采集失败 · 等待更新
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-basalt-border pt-2 text-[10px] text-basalt-muted-foreground">
            <span title="只验证本机 TCP 连接，不代表应用业务健康。">
              关注端口 · TCP
            </span>
            {!telemetry.ports.length && <span>未配置关注端口</span>}
            {telemetry.ports.map((port) => {
              const old = stale || age(port.checkedAt, now) > 90;
              const label = {
                open: "可连接",
                closed: "未监听",
                timeout: "连接超时",
                error: "检查失败",
              }[port.status];
              return (
                <Badge
                  key={`${port.host}:${port.port}`}
                  variant={
                    old
                      ? "secondary"
                      : port.status === "open"
                        ? "success"
                        : "warning"
                  }
                  title={`${port.host}:${port.port} · ${time(port.checkedAt)} · 仅 TCP 连通性`}
                >
                  {port.name} · {port.port}
                  <span>{old ? `上次${label}` : label}</span>
                  {!old && port.latencyMs !== null && (
                    <span className="tabular-nums">{port.latencyMs} ms</span>
                  )}
                </Badge>
              );
            })}
          </div>
        </LayerCard>
      )}
    </section>
  );
}

export function Topology({
  space,
  at,
  onPane,
  compact = false,
}: {
  space: Space;
  at: string;
  onPane?: (pane: Pane) => void;
  compact?: boolean;
}) {
  return (
    <div className={`topology ${compact ? "topology-compact" : ""}`}>
      {space.tabs.map((tab) => (
        <div key={tab.id}>
          <div className="topology-label">
            <span>
              <Layers3 size={11} />
              {tab.name || tab.id}
            </span>
            <span>{tab.panes.length} PANES</span>
          </div>
          <fieldset
            className="topology-map"
            style={{ height: compact ? 88 : 210 }}
            aria-label={`${space.name} / ${tab.name} 拓扑`}
          >
            {tab.panes.map((pane) => {
              const state = assessPane(pane, at).state;
              return (
                <div
                  key={pane.id}
                  className="topology-cell"
                  style={{
                    left: `${pane.rect.x * 100}%`,
                    top: `${pane.rect.y * 100}%`,
                    width: `${pane.rect.width * 100}%`,
                    height: `${pane.rect.height * 100}%`,
                    ...accent(agentColor(pane.agent)),
                  }}
                >
                  <Button
                    variant="outline"
                    className="pane-button"
                    onClick={() => onPane?.(pane)}
                    aria-label={`${pane.agent || "终端"} ${pane.id} 证据`}
                  >
                    <span className="pane-header">
                      <span className="agent-light" />
                      <strong>{pane.agent || "terminal"}</strong>
                      <span className="pane-id">
                        {pane.id.split(":").at(-1)}
                      </span>
                    </span>
                    {!compact && (
                      <span className="line-clamp-2 whitespace-normal text-xs font-normal">
                        {pane.task.title}
                      </span>
                    )}
                    <span className="pane-state">
                      <span style={{ background: stateColors[state] }} />
                      {STATE_LABEL[state]}
                    </span>
                  </Button>
                </div>
              );
            })}
          </fieldset>
        </div>
      ))}
    </div>
  );
}

function EvidenceStrip({ panes, at }: { panes: Pane[]; at: string }) {
  const current = panes.flatMap((pane) => assessPane(pane, at).evidence);
  return (
    <fieldset className="evidence-strip" aria-label="证据覆盖">
      {evidenceKinds.map((kind) => {
        const entries = current.filter((e) => e.kind === kind);
        const status = entries.some((e) =>
          ["failure", "waiting"].includes(e.status),
        )
          ? "attention"
          : entries.some((e) => e.status === "running")
            ? "active"
            : entries.some((e) => e.status === "success")
              ? "verified"
              : "missing";
        const Icon = evidenceIcons[kind];
        return (
          <Tooltip key={kind}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className={`evidence-item h-auto p-0 evidence-${status}`}
                aria-label={`${evidenceNames[kind]}：${entries.length ? "有记录" : "缺少证据"}`}
              >
                <Icon size={12} />
                <span>{evidenceNames[kind]}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {evidenceNames[kind]} ·{" "}
              {entries.length
                ? `${entries.length} 条当前任务证据`
                : "尚无当前任务证据"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}

function SpaceCard({
  space,
  state,
  summary,
  machine,
  now,
  onOpen,
}: {
  space: Space;
  state: State;
  summary: string;
  machine: MachineView;
  now: string;
  onOpen: (pane?: Pane) => void;
}) {
  const stale = isStale(machine, now) || space.availability === "unavailable";
  const panes = space.tabs.flatMap((t) => t.panes);
  const latest = panes
    .flatMap((p) => assessPane(p, machine.report.capturedAt).evidence)
    .filter(
      (e) =>
        ["summary", "goal"].includes(e.kind) &&
        !e.source.startsWith("herdr:visible"),
    )
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const actual = stale ? "unverified" : state;
  return (
    <LayerCard
      padding="none"
      className="space-card"
      style={{
        ...accent(stateColors[actual]),
      }}
    >
      <div className="space-card-heading">
        <span className="space-symbol">
          <Workflow size={17} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{space.name}</h3>
          <span className="space-meta">
            {space.session} <span>·</span> {panes.length} panes
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => onOpen()}
          aria-label={`查看 ${space.name}`}
        >
          <ArrowUpRight size={15} />
        </Button>
      </div>
      <div className="space-copy">
        <div className="space-state-row">
          <Status state={actual} />
          <span className="mono text-[10px] text-basalt-muted-foreground">
            {space.id.split(":").at(-1)}
          </span>
        </div>
        <p className="space-objective" title={space.objective}>
          {space.objective || "等待管理 Agent 补充当前目标"}
        </p>
        <p
          className="space-summary"
          title={stale ? undefined : latest?.summary || summary}
        >
          {stale
            ? "历史快照 · 等待重新采集"
            : (latest?.summary || summary).replace(/[*#`]/g, "")}
        </p>
      </div>
      <div className="space-topology">
        <Topology
          space={space}
          at={machine.report.capturedAt}
          compact
          onPane={onOpen}
        />
      </div>
      <EvidenceStrip panes={panes} at={machine.report.capturedAt} />
    </LayerCard>
  );
}

function RecentActivity({ machines }: { machines: MachineView[] }) {
  const changes = machines
    .flatMap((machine) =>
      (machine.changes ?? []).map((change, index) => ({
        key: `${machine.id}:${index}:${change}`,
        change,
        at: machine.changedAt ?? machine.report.capturedAt,
        machine: machine.name,
      })),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <LayerCard padding="none" className="activity-card">
      <div className="panel-heading">
        <span
          className="panel-icon"
          style={accent("hsl(var(--basalt-accent-9))")}
        >
          <Sparkles size={16} />
        </span>
        <h2>最近变化</h2>
        <Badge variant="purple">{changes.length}</Badge>
      </div>
      <div className="activity-summary">
        各机器最近一次任务或拓扑变化 · 保留变化的采集时间
      </div>
      <ol className="activity-feed">
        {changes.slice(0, 7).map((item) => (
          <li key={item.key} className="eagle-change">
            <span className="timeline-node" />
            <div>
              <p className="line-clamp-2 break-words">{item.change}</p>
              <span className="activity-time">
                {time(item.at)} · {item.machine.replace(/\.local$/, "")}
              </span>
            </div>
          </li>
        ))}
        {!changes.length && (
          <li>
            <CheckCheck size={16} className="text-basalt-success-foreground" />
            <p className="text-basalt-muted-foreground">
              尚无任务或布局变化记录。
            </p>
          </li>
        )}
      </ol>
    </LayerCard>
  );
}

function EvidenceCoverage({ machines }: { machines: MachineView[] }) {
  const panes = machines.flatMap((m) =>
    m.report.spaces.flatMap((s) =>
      s.tabs.flatMap((t) =>
        t.panes.map((p) => ({ pane: p, at: m.report.capturedAt })),
      ),
    ),
  );
  return (
    <LayerCard padding="none" className="coverage-card">
      <div className="panel-heading">
        <span
          className="panel-icon"
          style={accent("hsl(var(--basalt-accent-3))")}
        >
          <ShieldCheck size={16} />
        </span>
        <h2>证据覆盖</h2>
        <span className="mono ml-auto text-xs text-basalt-muted-foreground">
          {panes.length} PANES
        </span>
      </div>
      <div className="coverage-rows">
        {evidenceKinds.map((kind, i) => {
          const count = panes.filter(({ pane, at }) =>
            assessPane(pane, at).evidence.some((e) => e.kind === kind),
          ).length;
          const Icon = evidenceIcons[kind];
          return (
            <div key={kind} className="coverage-row">
              <Icon size={13} />
              <span>{evidenceNames[kind]}</span>
              <SlotBarChart
                items={Array.from(
                  { length: Math.min(panes.length, 20) },
                  (_, n) => ({
                    color:
                      n / Math.min(panes.length, 20) < count / panes.length
                        ? `hsl(var(--basalt-accent-${[1, 10, 3, 4, 7, 9][i]}))`
                        : "hsl(var(--basalt-accent-12) / .15)",
                  }),
                )}
                ariaLabel={`${evidenceNames[kind]}覆盖 ${count} / ${panes.length} 个 Pane`}
                heightClass="h-2"
                gapClass="gap-px"
              />
              <span className="mono">
                {count}/{panes.length}
              </span>
            </div>
          );
        })}
      </div>
      <p className="coverage-note">
        覆盖表示存在记录。只有当前任务的结论、Goal、Git、测试与线上证据一致，才计入已验证完成。
      </p>
    </LayerCard>
  );
}

export function DashboardSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在同步工作空间"
      className="dashboard-skeleton"
    >
      <div className="sync-intro">
        <Radio size={16} className="eagle-pulse" />
        正在同步工作空间<span>连接机器 · 核对证据 · 绘制拓扑</span>
      </div>
      <div className="metric-grid">
        {[0, 1, 2, 3, 4].map((i) => (
          <LayerCard key={i}>
            <SkeletonLine minWidth={40} maxWidth={60} />
            <SkeletonLine height={36} />
            <SkeletonLine />
          </LayerCard>
        ))}
      </div>
      <div className="dashboard-layout">
        <div className="space-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <LayerCard key={i} className="skeleton-space">
              <SkeletonLine height={14} />
              <SkeletonLine />
              <LayerCard.Loading label="同步 Space" />
            </LayerCard>
          ))}
        </div>
        <LayerCard>
          <LayerCard.Loading label="核对最近变化" />
        </LayerCard>
      </div>
    </div>
  );
}

export function Dashboard({
  machines,
  now,
  search,
  onSearch,
  onOpen,
}: {
  machines: MachineView[];
  now: string;
  search: string;
  onSearch: (value: string) => void;
  onOpen: (machine: string, space: string, pane?: string) => void;
}) {
  const [filter, setFilter] = useState<State | "all">("all");
  const spaces = machines.flatMap((machine) =>
    summarize(machine.report).spaces.map((s) => ({
      ...s,
      machine,
      state: isStale(machine, now) ? ("unverified" as const) : s.state,
    })),
  );
  const counts = Object.fromEntries(
    states.map((state) => [
      state,
      spaces.filter((s) => s.state === state).length,
    ]),
  ) as Record<State, number>;
  const online = machines.filter((m) => age(m.lastSeen, now) <= 90).length;
  const paneCount = spaces.reduce((n, s) => n + s.panes.length, 0);
  const filtered = spaces.filter(
    (s) =>
      (filter === "all" || s.state === filter) &&
      `${s.space.name} ${s.space.objective} ${s.panes.map((p) => p.pane.task.title).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const agents = spaces
    .flatMap((s) => s.panes)
    .reduce(
      (map, p) =>
        map.set(
          p.pane.agent || "terminal",
          (map.get(p.pane.agent || "terminal") || 0) + 1,
        ),
      new Map<string, number>(),
    );
  return (
    <div className="dashboard-content eagle-enter">
      <section className="metric-grid" aria-label="当前工作态势">
        <LayerCard className="overview-metric" padding="none">
          <div className="overview-glow" />
          <div className="relative">
            <h2 className="metric-eyebrow">
              <Radio size={14} />
              当前态势
            </h2>
            <div className="overview-number">
              <span>{spaces.length.toString().padStart(2, "0")}</span>
              <div>
                工作空间<small>{paneCount} 个 Pane · 全量拓扑</small>
              </div>
            </div>
            <div className="overview-footer">
              <span className="live-dot" />
              {online}/{machines.length} 台机器在线
              <span className="ml-auto mono">LIVE FLEET</span>
            </div>
          </div>
        </LayerCard>
        {states.map((state) => {
          const Icon = stateIcons[state];
          return (
            <LayerCard
              key={state}
              className={`metric-card metric-${state}`}
              style={accent(stateColors[state])}
            >
              <div className="metric-title">
                <span>{STATE_LABEL[state]}</span>
                <Icon size={17} strokeWidth={1.5} />
              </div>
              <div className="metric-value">
                {counts[state].toString().padStart(2, "0")}
                <span>SPACES</span>
              </div>
              <SlotBarChart
                items={spaces.map((s) => ({
                  color:
                    s.state === state
                      ? stateColors[state]
                      : "hsl(var(--basalt-accent-12) / .15)",
                }))}
                ariaLabel={`${counts[state]} / ${spaces.length} 个 Space ${STATE_LABEL[state]}`}
                heightClass="h-1.5"
                gapClass="gap-1"
              />
              <p className="metric-caption">
                {state === "active"
                  ? "任务正在推进"
                  : state === "attention"
                    ? "存在阻塞或失败证据"
                    : state === "verified"
                      ? "交付证据已交叉验证"
                      : "等待补足或核对证据"}
              </p>
            </LayerCard>
          );
        })}
      </section>
      <div className="dashboard-layout">
        <div className="min-w-0 space-y-4">
          <div className="board-title">
            <div>
              <span className="section-index">01</span>
              <h2>Space 拓扑</h2>
              <Badge variant="secondary">
                {filtered.length} / {spaces.length}
              </Badge>
            </div>
            <span className="hidden text-xs text-basalt-muted-foreground sm:inline">
              需关注与进行中优先 · 点击 Pane 查看证据
            </span>
          </div>
          <div className="board-toolbar">
            <div className="board-search">
              <Search size={14} />
              <Input
                aria-label="搜索 Space"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="搜索空间、目标、任务…"
              />
            </div>
            <fieldset className="state-filters" aria-label="Space 状态筛选">
              {(["all", ...states] as const).map((state) => (
                <Button
                  key={state}
                  size="sm"
                  variant={filter === state ? "secondary" : "ghost"}
                  aria-pressed={filter === state}
                  aria-label={`筛选${state === "all" ? "全部" : STATE_LABEL[state]}`}
                  onClick={() => setFilter(state)}
                >
                  {state === "all"
                    ? "全部"
                    : state === "verified"
                      ? "已验证"
                      : STATE_LABEL[state]}
                  <span className="mono">
                    {state === "all" ? spaces.length : counts[state]}
                  </span>
                </Button>
              ))}
            </fieldset>
          </div>
          {!machines.length && (
            <LayerCard>
              <LayerCard.Empty
                icon={<Server size={28} />}
                title="等待第一台机器接入"
                description="配置本机 Eagle Agent，机器和全部 Space 会自动出现在这里。"
              />
            </LayerCard>
          )}
          {machines.map((machine) => {
            const priority = {
              attention: 0,
              active: 1,
              unverified: 2,
              verified: 3,
            };
            const group = filtered
              .filter((s) => s.machine.id === machine.id)
              .sort((a, b) => priority[a.state] - priority[b.state]);
            if (!group.length && filtered.length) return null;
            const stale = isStale(machine, now);
            return (
              <section
                key={machine.id}
                className="machine-section"
                aria-label={`${machine.name} 的工作空间`}
              >
                <div className="machine-heading">
                  <div className="machine-icon">
                    <Server size={17} />
                  </div>
                  <div className="machine-identity">
                    <h3>{machine.name.replace(/\.local$/, "")}</h3>
                    <span>
                      {machine.report.machine.platform} <span>·</span>{" "}
                      {machine.report.spaces.length} spaces <span>·</span>{" "}
                      {
                        machine.report.spaces.flatMap((s) =>
                          s.tabs.flatMap((t) => t.panes),
                        ).length
                      }{" "}
                      panes
                    </span>
                  </div>
                  <Badge variant={stale ? "warning" : "success"} dot>
                    {age(machine.lastSeen, now) > 90
                      ? "心跳过期"
                      : stale
                        ? "采集过期"
                        : "在线"}
                  </Badge>
                  <div className="machine-heartbeat">
                    <span>
                      <Clock3 size={11} />{" "}
                      <time
                        dateTime={machine.report.capturedAt}
                        title={time(machine.report.capturedAt)}
                      >
                        {time(machine.report.capturedAt).split(" ").at(-1)}
                      </time>
                    </span>
                    <small>最新完整采集</small>
                  </div>
                </div>
                {(machine.warning || machine.report.warnings.length > 0) && (
                  <p className="machine-warning">
                    <TriangleAlert size={13} />
                    {machine.warning || machine.report.warnings.join("；")}
                  </p>
                )}
                <MachineResources machine={machine} now={now} />
                <div className="space-grid">
                  {group.map((s) => (
                    <SpaceCard
                      key={s.space.id}
                      {...s}
                      now={now}
                      onOpen={(pane) =>
                        onOpen(machine.id, s.space.id, pane?.id)
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {machines.length > 0 && !filtered.length && (
            <LayerCard>
              <LayerCard.Empty
                icon={<Search size={24} />}
                title="没有匹配的 Space"
                description="尝试其它关键词或切换状态筛选。"
              />
            </LayerCard>
          )}
        </div>
        <aside className="dashboard-aside" aria-label="变化与证据摘要">
          <div className="board-title">
            <div>
              <span className="section-index">02</span>
              <h2>运行脉搏</h2>
            </div>
            <span className="live-label">
              <span className="live-dot" />
              实时
            </span>
          </div>
          <RecentActivity machines={machines} />
          <LayerCard padding="none" className="agents-card">
            <div className="panel-heading">
              <span
                className="panel-icon"
                style={accent("hsl(var(--basalt-accent-7))")}
              >
                <Bot size={16} />
              </span>
              <h2>Agent 分布</h2>
              <span className="mono ml-auto text-xs text-basalt-muted-foreground">
                {paneCount}
              </span>
            </div>
            <div className="agent-distribution">
              {[...agents]
                .sort((a, b) => b[1] - a[1])
                .map(([agent, count]) => (
                  <div key={agent}>
                    <Badge variant={agentTone(agent)} dot>
                      {agent}
                    </Badge>
                    <SlotBarChart
                      items={Array.from(
                        { length: Math.min(paneCount, 20) },
                        (_, i) => ({
                          color:
                            i / Math.min(paneCount, 20) < count / paneCount
                              ? agentColor(agent)
                              : "hsl(var(--basalt-accent-12) / .15)",
                        }),
                      )}
                      ariaLabel={`${agent}：${count} 个 Pane`}
                      heightClass="h-2"
                      gapClass="gap-px"
                    />
                    <strong className="mono">{count}</strong>
                  </div>
                ))}
            </div>
          </LayerCard>
          <EvidenceCoverage machines={machines} />
        </aside>
      </div>
    </div>
  );
}
