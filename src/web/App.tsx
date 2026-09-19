import {
  Badge,
  Button,
  ContentIsland,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  LayerCard,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarIconItem,
  SidebarItem,
  SidebarNav,
  SidebarPartition,
  SidebarProvider,
  ThemeToggle,
} from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppShell,
  AppSkipLink,
} from "@nocoo/basalt/components/app-shell";
import { LoadingScreen } from "@nocoo/basalt/components/loading-screen";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { SensitiveInput } from "@nocoo/basalt/components/sensitive-input";
import {
  Activity,
  Bird,
  ChevronLeft,
  History as HistoryIcon,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  RefreshCw,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { assessPane, summarize } from "../shared/assessment.ts";
import {
  type HistoryEntry,
  type MachineView,
  type Overview,
  type Pane,
  type Space,
  STATE_LABEL,
  type State,
} from "../shared/schema.ts";
import { AuthError, age, api, time } from "./api.ts";

declare const __APP_VERSION__: string;
const tones = {
  verified: "success",
  active: "info",
  attention: "warning",
  unverified: "secondary",
} as const;
function Status({ state }: { state: State }) {
  return (
    <Badge variant={tones[state]} dot>
      {STATE_LABEL[state]}
    </Badge>
  );
}
function Mark() {
  return (
    <Bird aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 shrink-0" />
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-basalt-background p-4">
      <div
        data-basalt-surface-root=""
        className="relative flex aspect-[54/86] w-72 flex-col overflow-hidden rounded-2xl bg-basalt-card shadow-xl ring-1 ring-basalt-border"
      >
        <div className="flex items-center justify-between bg-basalt-primary px-5 py-4 text-basalt-primary-foreground">
          <div className="h-4 w-8 rounded-full bg-basalt-background/80" />
          <span className="flex items-center gap-2 font-semibold">
            <Mark />
            Eagle
          </span>
          <span className="text-[10px] tracking-widest">PRIVATE</span>
        </div>
        <div className="flex flex-1 flex-col px-6 pt-7 pb-14">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-basalt-secondary">
            <Bird size={40} strokeWidth={1.5} />
          </div>
          <h1 className="mt-5 text-center text-lg font-semibold">
            每一台机器，尽在眼前
          </h1>
          <p className="mt-2 text-center text-xs text-basalt-muted-foreground">
            查看任务进展与真实交付证据
          </p>
          <form
            className="mt-6 space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (pending) return;
              const form = e.currentTarget;
              const token = String(new FormData(form).get("token") ?? "");
              setPending(true);
              setError("");
              try {
                await api("/api/session", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}` },
                });
                form.reset();
                onSuccess();
              } catch {
                setError("令牌无效或服务暂不可用");
              } finally {
                setPending(false);
              }
            }}
          >
            <Field label="访问令牌">
              <SensitiveInput
                name="token"
                autoComplete="current-password"
                required
                revealLabel="显示令牌"
                hideLabel="隐藏令牌"
              />
            </Field>
            {error && (
              <p role="alert" className="text-xs text-basalt-destructive">
                {error}
              </p>
            )}
            <Button className="w-full" type="submit" loading={pending}>
              进入 Eagle
            </Button>
          </form>
        </div>
        <div className="absolute inset-x-0 bottom-0 border-t border-basalt-border bg-basalt-secondary/50 py-2.5 text-center text-[10px] text-basalt-muted-foreground">
          私密工作台 · 安全会话
        </div>
      </div>
    </main>
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
    <div className="space-y-3">
      {space.tabs.map((tab) => (
        <div key={tab.id}>
          <p className="mb-2 flex items-center justify-between text-xs text-basalt-muted-foreground">
            <span>{tab.name || tab.id}</span>
            <span>{tab.panes.length} Panes</span>
          </p>
          <fieldset
            className="relative w-full"
            style={{ height: compact ? 124 : 220 }}
            aria-label={`${space.name} / ${tab.name} 拓扑`}
          >
            {tab.panes.map((pane) => (
              <div
                key={pane.id}
                className="absolute p-0.5"
                style={{
                  left: `${pane.rect.x * 100}%`,
                  top: `${pane.rect.y * 100}%`,
                  width: `${pane.rect.width * 100}%`,
                  height: `${pane.rect.height * 100}%`,
                }}
              >
                <Button
                  variant="outline"
                  className="h-full w-full min-w-0 flex-col items-start justify-start gap-1 overflow-hidden px-2 py-2 text-left"
                  onClick={() => onPane?.(pane)}
                  aria-label={`${pane.agent || "终端"} ${pane.id} 证据`}
                >
                  <span className="w-full truncate text-xs font-medium">
                    {pane.agent || "terminal"}{" "}
                    <span className="text-basalt-muted-foreground">
                      {pane.id.split(":").at(-1)}
                    </span>
                  </span>
                  {!compact && (
                    <span className="line-clamp-2 whitespace-normal text-xs font-normal">
                      {pane.task.title}
                    </span>
                  )}
                  <span className="w-full truncate text-[10px] font-normal text-basalt-muted-foreground">
                    {STATE_LABEL[assessPane(pane, at).state]}
                  </span>
                </Button>
              </div>
            ))}
          </fieldset>
        </div>
      ))}
    </div>
  );
}

function SpaceCard({
  space,
  state,
  summary,
  machine,
  onOpen,
}: {
  space: Space;
  state: State;
  summary: string;
  machine: MachineView;
  onOpen: () => void;
}) {
  const stale =
    space.availability === "unavailable" ||
    age(machine.lastSeen, new Date().toISOString()) > 90 ||
    age(machine.report.capturedAt, new Date().toISOString()) > 300;
  const latest = space.tabs
    .flatMap((t) => t.panes.flatMap((p) => p.evidence))
    .filter(
      (e) =>
        ["summary", "goal"].includes(e.kind) &&
        !e.source.startsWith("herdr:visible"),
    )
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  return (
    <LayerCard className="flex min-w-0 flex-col">
      <LayerCard.Header>
        <div className="flex w-full items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{space.name}</h3>
            <p className="mt-1 truncate text-xs text-basalt-muted-foreground">
              {machine.name} · {space.session}
            </p>
          </div>
          <Status state={stale ? "unverified" : state} />
        </div>
      </LayerCard.Header>
      <LayerCard.Body className="flex flex-1 flex-col gap-4">
        <div className="min-h-16">
          <p className="line-clamp-2 text-sm">
            {space.objective || "等待管理 Agent 补充当前目标"}
          </p>
          <p className="mt-2 line-clamp-2 text-xs text-basalt-muted-foreground">
            {stale ? "历史快照 · 等待重新采集" : latest?.summary || summary}
          </p>
        </div>
        <Topology
          space={space}
          at={machine.report.capturedAt}
          compact
          onPane={onOpen}
        />
        <Button
          variant="outline"
          size="sm"
          className="mt-auto w-full"
          onClick={onOpen}
          aria-label={`查看 ${space.name}`}
        >
          查看任务与证据
        </Button>
      </LayerCard.Body>
    </LayerCard>
  );
}

function HistoryView({
  machine,
  space,
  compact = false,
}: {
  machine: string;
  space?: string;
  compact?: boolean;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (before?: number) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ limit: compact ? "6" : "12" });
      if (machine) query.set("machine", machine);
      if (space) query.set("space", space);
      if (before) query.set("before", String(before));
      try {
        const result = await api<{
          entries: HistoryEntry[];
          nextCursor: number | null;
        }>(`/api/v1/history?${query}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setEntries((old) =>
          before ? [...old, ...(result.entries ?? [])] : (result.entries ?? []),
        );
        setCursor(result.nextCursor);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "历史加载失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [machine, space, compact],
  );
  useEffect(() => {
    setEntries([]);
    void load();
    return () => active.current?.abort();
  }, [load]);
  if (compact) {
    const changes = entries.flatMap((entry) =>
      entry.changes.map((change) => ({
        key: `${entry.seq}:${change}`,
        change,
      })),
    );
    return (
      <LayerCard>
        <h2 className="text-sm font-semibold">最近变化</h2>
        <p className="mt-2 text-xs text-basalt-muted-foreground">
          最近 {entries.length} 次采集中，
          {entries.filter((e) => e.changes.length).length}{" "}
          次出现任务或布局变化。
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-basalt-destructive">
            历史暂不可用
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {changes.slice(0, 4).map((item) => (
              <li key={item.key} className="line-clamp-2 break-words">
                {item.change}
              </li>
            ))}
          </ul>
        )}
        {!changes.length && !error && (
          <p className="mt-3 text-sm text-basalt-muted-foreground">
            {loading ? "正在核对最近变化…" : "最近任务与布局保持稳定。"}
          </p>
        )}
      </LayerCard>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-basalt-muted-foreground">
          按接收时间记录，结论与上一次采集比较。
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          刷新历史
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-basalt-destructive">
          {error}
        </p>
      )}
      {!loading && !entries.length && !error && (
        <LayerCard>暂无历史记录</LayerCard>
      )}
      {entries.map((entry) => (
        <LayerCard key={entry.seq}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {entry.report.machine.name}
            </span>
            <span className="text-xs text-basalt-muted-foreground">
              采集 {time(entry.report.capturedAt)}
            </span>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {(entry.changes.length
              ? entry.changes
              : ["任务与拓扑无变化，采集证据已刷新"]
            ).map((change) => (
              <li key={change} className="break-words">
                {change}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-basalt-muted-foreground">
            {entry.report.spaces.length} 个 Space · 接收{" "}
            {time(entry.receivedAt)} · #{entry.seq}
          </p>
        </LayerCard>
      ))}
      {cursor && (
        <Button
          variant="outline"
          loading={loading}
          onClick={() => void load(cursor)}
        >
          更早记录
        </Button>
      )}
      {loading && (
        <p role="status" className="text-sm text-basalt-muted-foreground">
          读取历史…
        </p>
      )}
    </div>
  );
}

function SpaceDetail({
  machine,
  space,
}: {
  machine: MachineView;
  space: Space;
}) {
  const [paneId, setPaneId] = useState("");
  const [history, setHistory] = useState(false);
  const panes = space.tabs.flatMap((t) => t.panes);
  const pane = panes.find((p) => p.id === paneId) ?? panes[0];
  const assessment = pane ? assessPane(pane, machine.report.capturedAt) : null;
  return (
    <>
      <SheetTitle>{space.name}</SheetTitle>
      <SheetDescription>
        {machine.name} · {space.objective || "目标待补充"}
      </SheetDescription>
      <div className="mt-5 flex gap-2">
        <Button
          size="sm"
          variant={history ? "ghost" : "secondary"}
          onClick={() => setHistory(false)}
        >
          当前任务
        </Button>
        <Button
          size="sm"
          variant={history ? "secondary" : "ghost"}
          onClick={() => setHistory(true)}
        >
          Space 历史
        </Button>
      </div>
      <div className="mt-6 space-y-6">
        {history ? (
          <HistoryView machine={machine.id} space={space.id} />
        ) : (
          <>
            <Topology
              space={space}
              at={machine.report.capturedAt}
              onPane={(p) => setPaneId(p.id)}
            />
            {pane && assessment && (
              <>
                <SectionRule title={`${pane.agent || "终端"} · ${pane.id}`}>
                  <LayerCard>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Status state={assessment.state} />
                      <span className="text-xs text-basalt-muted-foreground">
                        Herdr 弱提示：{pane.hint}
                      </span>
                    </div>
                    <h3 className="mt-3 text-sm font-medium">
                      {pane.task.title}
                    </h3>
                    <p className="mt-2 text-sm text-basalt-muted-foreground">
                      {assessment.reason}
                    </p>
                  </LayerCard>
                </SectionRule>
                <SectionRule
                  title="判断依据"
                  hint="来源、时间、任务与 revision 一起核对。"
                >
                  <div className="space-y-3">
                    {pane.evidence.length ? (
                      pane.evidence.map((e) => (
                        <LayerCard
                          key={`${e.kind}-${e.source}-${e.observedAt}-${e.taskId}`}
                        >
                          <div className="flex flex-wrap justify-between gap-2 text-xs">
                            <Badge variant="outline">
                              {e.kind} · {e.status}
                            </Badge>
                            <span className="text-basalt-muted-foreground">
                              {time(e.observedAt)}
                            </span>
                          </div>
                          <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                            {e.summary}
                          </p>
                          <p className="mt-2 break-all text-xs text-basalt-muted-foreground">
                            {e.source}
                            {e.revision ? ` · ${e.revision.slice(0, 12)}` : ""}
                          </p>
                        </LayerCard>
                      ))
                    ) : (
                      <p className="text-sm text-basalt-muted-foreground">
                        尚无可靠证据。Pane 状态不能证明任务完成。
                      </p>
                    )}
                  </div>
                </SectionRule>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function App() {
  const [clock, setClock] = useState(new Date().toISOString());
  const [data, setData] = useState<Overview | null>(null);
  const [auth, setAuth] = useState(false);
  const [boot, setBoot] = useState(true);
  const [error, setError] = useState("");
  const [machineId, setMachineId] = useState("");
  const [page, setPage] = useState<"overview" | "history">("overview");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{
    machine: string;
    space: string;
  } | null>(null);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const [collapsed, setCollapsed] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const fetching = useRef(false);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      setData(await api<Overview>("/api/v1/overview"));
      setAuth(true);
      setError("");
    } catch (e) {
      if (e instanceof AuthError) {
        setAuth(false);
        setData(null);
      } else setError(e instanceof Error ? e.message : "连接中断");
    } finally {
      setClock(new Date().toISOString());
      setBoot(false);
      fetching.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const change = () => {
      setMobile(media.matches);
      setCollapsed(media.matches);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  if (boot) return <LoadingScreen label="读取 Eagle" mark={<Mark />} />;
  if (!auth) return <Login onSuccess={() => void refresh()} />;
  const machines = data?.machines ?? [];
  const now = clock;
  const selectedMachine = machines.find((m) => m.id === machineId);
  const shown = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines;
  const allSpaces = shown.flatMap((machine) =>
    summarize(machine.report).spaces.map((s) => ({ ...s, machine })),
  );
  const filtered = allSpaces.filter((s) =>
    `${s.space.name} ${s.space.objective} ${s.panes.map((p) => p.pane.task.title).join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const counts = { active: 0, attention: 0, verified: 0, unverified: 0 };
  for (const s of allSpaces)
    counts[
      age(s.machine.lastSeen, now) > 90 ||
      age(s.machine.report.capturedAt, now) > 300
        ? "unverified"
        : s.state
    ]++;
  const online = shown.filter((m) => age(m.lastSeen, now) <= 90).length;
  const detailMachine = machines.find((m) => m.id === selection?.machine);
  const detailSpace = detailMachine?.report.spaces.find(
    (s) => s.id === selection?.space,
  );
  const navigate = (next: "overview" | "history", id = machineId) => {
    setPage(next);
    setMachineId(id);
    if (mobile) setCollapsed(true);
  };
  const NavItem = collapsed && !mobile ? SidebarIconItem : SidebarItem;
  const title =
    page === "history" ? "最近历史" : (selectedMachine?.name ?? "全局总览");
  return (
    <SidebarProvider
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      overlay={mobile}
    >
      <AppShell>
        <AppSkipLink>跳至内容</AppSkipLink>
        <Sidebar>
          {mobile && (
            <>
              <DialogTitle className="sr-only">导航</DialogTitle>
              <DialogDescription className="sr-only">
                选择机器与历史
              </DialogDescription>
            </>
          )}
          <SidebarHeader>
            <div
              className={`flex w-full items-center ${collapsed && !mobile ? "justify-center" : "justify-between"}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Mark />
                {(!collapsed || mobile) && (
                  <>
                    <strong className="font-semibold">Eagle</strong>
                    <Badge variant="secondary">{__APP_VERSION__}</Badge>
                  </>
                )}
              </span>
              {(!collapsed || mobile) && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="收起导航"
                  onClick={() => setCollapsed(true)}
                >
                  <ChevronLeft size={16} />
                </Button>
              )}
            </div>
          </SidebarHeader>
          <SidebarNav aria-label="工作台导航">
            {(!collapsed || mobile) && (
              <SidebarPartition>工作态势</SidebarPartition>
            )}
            <div
              className={`flex flex-col gap-0.5 ${collapsed && !mobile ? "items-center" : "px-3"}`}
            >
              <NavItem
                aria-label="全局总览"
                active={page === "overview" && !machineId}
                onClick={() => navigate("overview", "")}
              >
                <LayoutDashboard
                  className="h-4 w-4 shrink-0"
                  strokeWidth={1.5}
                />
                {(!collapsed || mobile) && "全局总览"}
              </NavItem>
              <NavItem
                aria-label="最近历史"
                active={page === "history"}
                onClick={() => navigate("history")}
              >
                <HistoryIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {(!collapsed || mobile) && "最近历史"}
              </NavItem>
            </div>
            {(!collapsed || mobile) && (
              <SidebarPartition className="mt-6">
                机器 · {machines.length}
              </SidebarPartition>
            )}
            <div
              className={`flex flex-col gap-0.5 ${collapsed && !mobile ? "items-center mt-6" : "px-3"}`}
            >
              {machines.map((m) => (
                <NavItem
                  key={m.id}
                  aria-label={m.name}
                  active={machineId === m.id && page === "overview"}
                  onClick={() => navigate("overview", m.id)}
                >
                  <Monitor className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  {(!collapsed || mobile) && (
                    <span className="truncate">{m.name}</span>
                  )}
                </NavItem>
              ))}
            </div>
          </SidebarNav>
          <SidebarFooter>
            {(!collapsed || mobile) && (
              <div className="space-y-1 text-xs text-basalt-muted-foreground">
                <p>证据优先，结论有据</p>
                <p>每 5 秒同步一次</p>
              </div>
            )}
          </SidebarFooter>
        </Sidebar>
        <AppMain className="relative" tabIndex={-1}>
          <AppHeader
            title={title}
            breadcrumbs={[{ label: "工作台" }]}
            leading={
              collapsed || mobile ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="展开导航"
                  onClick={() => setCollapsed(false)}
                >
                  <Menu size={18} />
                </Button>
              ) : undefined
            }
            actions={
              <>
                <ThemeToggle aria-label="切换主题" />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="退出登录"
                  onClick={async () => {
                    try {
                      await api("/api/session", { method: "DELETE" });
                      setAuth(false);
                      setData(null);
                    } catch {
                      setError("退出失败，请重试");
                    }
                  }}
                >
                  <LogOut size={16} strokeWidth={1.5} />
                </Button>
              </>
            }
          />
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
            <ContentIsland className="relative">
              <div className="space-y-7">
                <PageHeader
                  title={title}
                  description="看清每个 Space 在做什么，哪些交付已经得到验证。"
                  actions={
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="刷新"
                        onClick={() => void refresh()}
                      >
                        <RefreshCw size={14} />
                        刷新
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          navigate(page === "overview" ? "history" : "overview")
                        }
                        aria-label={
                          page === "overview" ? "查看最近历史" : "返回总览"
                        }
                      >
                        {page === "overview" ? "最近历史" : "返回总览"}
                      </Button>
                    </>
                  }
                  filters={
                    page === "overview" ? (
                      <Input
                        aria-label="搜索 Space"
                        placeholder="搜索 Space、目标或任务…"
                        className="max-w-sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    ) : undefined
                  }
                />
                {error && (
                  <LayerCard>
                    <p role="alert" className="text-sm text-basalt-destructive">
                      {error}
                    </p>
                  </LayerCard>
                )}
                {page === "history" ? (
                  <HistoryView machine={machineId} />
                ) : (
                  <>
                    <LayerCard>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h2 className="flex items-center gap-2 text-sm font-semibold">
                            <Activity size={16} strokeWidth={1.5} />
                            当前态势
                          </h2>
                          <p className="mt-3 text-sm leading-6">
                            {online} / {shown.length} 台机器在线，
                            {allSpaces.length} 个 Space。{counts.active}{" "}
                            个正在推进，{counts.attention} 个需要关注。
                          </p>
                          <p className="mt-1 text-xs text-basalt-muted-foreground">
                            {counts.unverified} 个 Space
                            尚待补足证据；已验证完成只统计结论、Goal、Git
                            与验证结果一致的任务。
                          </p>
                        </div>
                        <Badge variant={error ? "warning" : "secondary"}>
                          {error ? "同步中断" : `已同步 ${time(now)}`}
                        </Badge>
                      </div>
                    </LayerCard>
                    <HistoryView
                      compact
                      machine={machineId}
                      key={shown.map((m) => m.report.reportId).join(":")}
                    />
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      {(
                        [
                          "active",
                          "attention",
                          "verified",
                          "unverified",
                        ] as const
                      ).map((state) => (
                        <LayerCard key={state}>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-basalt-muted-foreground">
                              {STATE_LABEL[state]}
                            </span>
                            <Badge
                              variant={tones[state]}
                              dot
                              className="hidden whitespace-nowrap md:inline-flex"
                            >
                              {state === "verified" ? "证据一致" : "Spaces"}
                            </Badge>
                          </div>
                          <p className="mt-3 text-3xl font-semibold tabular-nums">
                            {counts[state]}
                          </p>
                        </LayerCard>
                      ))}
                    </div>
                    {shown.map((m) => (
                      <div
                        key={m.id}
                        className="flex flex-wrap items-center gap-3 text-xs text-basalt-muted-foreground"
                      >
                        <Server size={14} />
                        <span className="font-medium text-basalt-foreground">
                          {m.name}
                        </span>
                        <Badge
                          variant={
                            age(m.lastSeen, now) > 90 ? "warning" : "success"
                          }
                          dot
                        >
                          {age(m.lastSeen, now) > 90 ? "心跳过期" : "在线"}
                        </Badge>
                        <span>最近心跳 {time(m.lastSeen)}</span>
                        <span>采集 {time(m.report.capturedAt)}</span>
                        {(m.warning || m.report.warnings.length > 0) && (
                          <span className="text-basalt-warning-foreground">
                            {m.warning ||
                              `${m.report.warnings.length} 项采集缺口`}
                          </span>
                        )}
                      </div>
                    ))}
                    {!machines.length ? (
                      <LayerCard>
                        <h2 className="text-sm font-semibold">
                          等待第一台机器接入
                        </h2>
                        <p className="mt-2 text-sm text-basalt-muted-foreground">
                          在机器上配置 Eagle Agent 后，Space 会自动出现在这里。
                        </p>
                      </LayerCard>
                    ) : (
                      <SectionRule
                        title="全部 Space"
                        hint={`${filtered.length} 个 · 保留 Herdr 的实际布局`}
                      >
                        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                          {filtered.map((s) => (
                            <SpaceCard
                              key={`${s.machine.id}:${s.space.id}`}
                              {...s}
                              onOpen={() =>
                                setSelection({
                                  machine: s.machine.id,
                                  space: s.space.id,
                                })
                              }
                            />
                          ))}
                        </div>
                        {!filtered.length && (
                          <p className="py-8 text-sm text-basalt-muted-foreground">
                            没有匹配的 Space
                          </p>
                        )}
                      </SectionRule>
                    )}
                  </>
                )}
              </div>
            </ContentIsland>
          </div>
        </AppMain>
        <Sheet
          open={!!selection}
          onOpenChange={(open) => {
            if (!open) setSelection(null);
          }}
        >
          <SheetContent
            side="right"
            className="w-full overflow-y-auto sm:max-w-2xl"
          >
            {detailMachine && detailSpace ? (
              <SpaceDetail
                key={`${detailMachine.id}:${detailSpace.id}`}
                machine={detailMachine}
                space={detailSpace}
              />
            ) : (
              <>
                <SheetTitle>Space 已关闭</SheetTitle>
                <SheetDescription>
                  可在最近历史查看之前的任务与证据。
                </SheetDescription>
              </>
            )}
          </SheetContent>
        </Sheet>
      </AppShell>
    </SidebarProvider>
  );
}
