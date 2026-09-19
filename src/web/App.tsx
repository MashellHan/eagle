import {
  Badge,
  Button,
  ContentIsland,
  DialogDescription,
  DialogTitle,
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppShell,
  AppSkipLink,
} from "@nocoo/basalt/components/app-shell";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
  ChevronLeft,
  History as HistoryIcon,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { assessPane } from "../shared/assessment.ts";
import type {
  HistoryEntry,
  MachineView,
  Overview,
  Space,
} from "../shared/schema.ts";
import { AuthError, api, time } from "./api.ts";
import { FamilyActions, Mark } from "./Brand.tsx";
import {
  Dashboard,
  DashboardSkeleton,
  Status,
  Topology,
} from "./Dashboard.tsx";

declare const __APP_VERSION__: string;
function AccessGate() {
  return (
    <main className="access-gate">
      <nav
        aria-label="项目链接"
        className="absolute right-4 top-4 flex items-center gap-1"
      >
        <FamilyActions />
      </nav>
      <LayerCard className="access-card">
        <span className="access-mark">
          <Mark size={64} />
        </span>
        <Badge variant="blue">CLOUDFLARE ACCESS</Badge>
        <h1>安全连接到 Eagle</h1>
        <p>使用 nocoo 团队身份继续访问工作台。</p>
        <Button onClick={() => window.location.assign(window.location.href)}>
          通过 Cloudflare Access 继续
        </Button>
      </LayerCard>
    </main>
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
  initialPane = "",
}: {
  machine: MachineView;
  space: Space;
  initialPane?: string;
}) {
  const [paneId, setPaneId] = useState(initialPane);
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
    pane?: string;
  } | null>(null);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const [collapsed, setCollapsed] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const fetching = useRef(false);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setSyncing(true);
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
      setSyncing(false);
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
  if (!boot && !auth && !error) return <AccessGate />;
  const machines = data?.machines ?? [];
  const now = clock;
  const selectedMachine = machines.find((m) => m.id === machineId);
  const shown = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines;
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
    page === "history" ? "最近历史" : (selectedMachine?.name ?? "任务控制台");
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
                <Badge variant="blue" className="hidden sm:inline-flex">
                  {import.meta.env.DEV ? "LOCAL" : "ACCESS"}
                </Badge>
                <FamilyActions />
                {!import.meta.env.DEV && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="退出登录"
                        onClick={() =>
                          window.location.assign("/cdn-cgi/access/logout")
                        }
                      >
                        <LogOut size={16} strokeWidth={1.5} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      退出登录
                    </TooltipContent>
                  </Tooltip>
                )}
              </>
            }
          />
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
            <ContentIsland className="relative">
              <div className="space-y-5">
                <PageHeader
                  title={title}
                  description="跨机器工作态势 · 任务、拓扑与交付证据，尽在一屏。"
                  actions={
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="刷新"
                        disabled={syncing}
                        onClick={() => void refresh()}
                      >
                        <RefreshCw
                          size={14}
                          className={syncing ? "eagle-spin" : ""}
                        />
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
                />
                {error && (
                  <LayerCard>
                    <p role="alert" className="text-sm text-basalt-destructive">
                      {error}
                    </p>
                  </LayerCard>
                )}
                <div className="sync-caption">
                  <span className={syncing ? "sync-dot syncing" : "sync-dot"} />
                  {syncing ? "正在同步" : `已同步 ${time(now)}`}
                  <span>每 5 秒自动更新</span>
                </div>
                {boot ? (
                  <DashboardSkeleton />
                ) : page === "history" ? (
                  <HistoryView machine={machineId} />
                ) : (
                  <Dashboard
                    machines={shown}
                    now={now}
                    search={search}
                    onSearch={setSearch}
                    onOpen={(machine, space, pane) =>
                      setSelection({ machine, space, pane })
                    }
                  />
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
                initialPane={selection?.pane}
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
