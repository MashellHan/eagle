import { Badge, Button, Input } from "@nocoo/basalt";
import { useEffect, useRef, useState } from "react";
import {
  type LiveFrame,
  type LiveInput,
  LiveServerMessageSchema,
  type LiveTopology,
} from "../shared/realtime.ts";

export function Realtime({
  machineId,
  spaceId,
}: {
  machineId: string;
  spaceId: string;
}) {
  const socket = useRef<WebSocket | null>(null);
  const sequence = useRef(0);
  const pending = useRef<{ seq: number; at: number } | null>(null);
  const [connection, setConnection] = useState("正在连接");
  const [online, setOnline] = useState(false);
  const [control, setControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topology, setTopology] = useState<LiveTopology | null>(null);
  const [frames, setFrames] = useState<Record<string, LiveFrame>>({});
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState({ target: "", text: "" });
  const [authority, setAuthority] = useState("");
  const [receipt, setReceipt] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let backoff = 1000;
    let current: LiveTopology | null = null;
    const disconnect = () => {
      clearTimeout(retry);
      clearInterval(heartbeat);
      const ws = socket.current;
      socket.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close(1000, "View left");
      }
      if (pending.current) {
        setReceipt("连接中断，输入结果未知；不会自动重发");
        pending.current = null;
      }
      setOnline(false);
      setControl(false);
      setAuthority("");
      setDraft({ target: "", text: "" });
      setBusy(false);
      setTopology(null);
      setFrames({});
      current = null;
    };
    const connect = () => {
      if (disposed || document.hidden || socket.current) return;
      disconnect();
      setConnection("正在连接");
      const url = new URL("/api/v1/realtime", location.origin);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("machine", machineId);
      url.searchParams.set("space", spaceId);
      const ws = new WebSocket(url);
      socket.current = ws;
      let last = Date.now();
      ws.onopen = () => {
        if (!disposed && socket.current === ws)
          ws.send(JSON.stringify({ type: "ping" }));
      };
      ws.onmessage = (e) => {
        if (disposed || socket.current !== ws) return;
        last = Date.now();
        backoff = 1000;
        let raw: unknown;
        try {
          raw = JSON.parse(e.data);
        } catch {
          ws.close(1008);
          return;
        }
        const parsed = LiveServerMessageSchema.safeParse(raw);
        if (!parsed.success) {
          ws.close(1008);
          return;
        }
        const m = parsed.data;
        if (m.type === "status") {
          setOnline(m.online);
          setControl(m.control);
          setConnection(m.online ? "实时连接" : "等待本机实时服务");
        }
        if (m.type === "topology" && m.spaceId === spaceId) {
          current = m;
          setTopology(m);
          setFrames((old) =>
            Object.fromEntries(
              Object.entries(old).filter(
                ([id, f]) =>
                  f.subscriptionId === m.subscriptionId &&
                  m.tabs.some((t) =>
                    t.panes.some(
                      (p) => p.id === id && p.terminalId === f.terminalId,
                    ),
                  ),
              ),
            ),
          );
        }
        if (
          m.type === "frame" &&
          m.spaceId === spaceId &&
          m.subscriptionId === current?.subscriptionId &&
          current.tabs.some((t) =>
            t.panes.some(
              (p) => p.id === m.paneId && p.terminalId === m.terminalId,
            ),
          )
        ) {
          setFrames((old) =>
            old[m.paneId]?.revision > m.revision
              ? old
              : { ...old, [m.paneId]: m },
          );
          if (m.deliveryId)
            ws.send(
              JSON.stringify({
                type: "rendered",
                deliveryId: m.deliveryId,
                deliveryBytes: m.deliveryBytes,
              }),
            );
        }
        if (m.type === "ack" && pending.current?.seq === m.seq) {
          pending.current = null;
          setBusy(false);
          setReceipt(
            m.status === "submitted"
              ? "已提交输入；请查看终端执行结果"
              : m.status === "unknown"
                ? "输入结果未知；不会自动重发"
                : "输入未发送，请检查控制权和 Pane",
          );
        }
      };
      ws.onerror = () => setConnection("连接失败，请检查登录和本机实时服务");
      ws.onclose = (e) => {
        if (disposed || socket.current !== ws) return;
        disconnect();
        setConnection(
          e.code === 4001 ? "连接授权已过期，请重新连接" : "连接已断开",
        );
        if (![1008, 4001, 4004].includes(e.code) && !document.hidden) {
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15000);
        }
      };
      heartbeat = setInterval(() => {
        if (socket.current !== ws) return;
        if (
          Date.now() - last > 30000 ||
          (pending.current && Date.now() - pending.current.at > 10000)
        ) {
          ws.close(4000, "Response timeout");
          return;
        }
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, 5000);
    };
    const visibility = () => {
      if (document.hidden) {
        disconnect();
        setConnection("页面在后台，实时连接已暂停");
      } else connect();
    };
    const leave = () => disconnect();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", visibility);
    connect();
    return () => {
      disposed = true;
      disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", visibility);
    };
  }, [machineId, spaceId, attempt]);
  const panes = topology?.tabs.flatMap((t) => t.panes) ?? [];
  const pane = panes.find((p) => p.id === selected) ?? panes[0];
  const targetIdentity = pane ? `${pane.id}/${pane.terminalId}` : "";
  const text = draft.target === targetIdentity ? draft.text : "";
  const previousTarget = useRef("");
  useEffect(() => {
    if (previousTarget.current && previousTarget.current !== targetIdentity) {
      setDraft({ target: "", text: "" });
      setAuthority("");
      setControl(false);
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "release" }));
      if (targetIdentity) setReceipt("目标已变化，请重新选择 Pane 并接管输入");
    }
    previousTarget.current = targetIdentity;
  }, [targetIdentity]);
  const send = (keys: LiveInput["keys"], value = "") => {
    const ws = socket.current;
    if (
      !pane ||
      !online ||
      !control ||
      authority !== targetIdentity ||
      pending.current ||
      ws?.readyState !== WebSocket.OPEN
    )
      return;
    const seq = ++sequence.current;
    pending.current = { seq, at: Date.now() };
    setBusy(true);
    ws.send(
      JSON.stringify({
        type: "input",
        seq,
        paneId: pane.id,
        terminalId: pane.terminalId,
        text: value,
        keys,
      }),
    );
    if (value) setDraft({ target: "", text: "" });
  };
  const disabled =
    !online || !control || authority !== targetIdentity || busy || !pane;
  return (
    <section aria-label="Space 实时终端" className="live-space">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={online ? "success" : "warning"} dot>
          {connection}
        </Badge>
        <Button
          size="sm"
          variant="secondary"
          disabled={!online}
          onClick={() => {
            setAuthority(control ? "" : targetIdentity);
            socket.current?.send(
              JSON.stringify({ type: control ? "release" : "control" }),
            );
          }}
        >
          {control ? "释放输入" : "接管输入"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAttempt((n) => n + 1)}
        >
          重新连接
        </Button>
      </div>
      <p className="text-xs text-basalt-muted-foreground">
        {control
          ? "你正在控制此 Space；发送时会短暂附着终端，可能调整尺寸或恢复暂停的任务。"
          : "当前为观看模式；同一 Space 仅一个网页可输入。"}
      </p>
      {!online && (
        <p className="text-sm text-basalt-muted-foreground">
          需要本机运行 Eagle 实时服务。切换或关闭此视图会释放连接。
        </p>
      )}
      {topology?.tabs.map((tab) => (
        <section key={tab.id} aria-label={tab.name}>
          <h3 className="mb-2 text-sm font-medium">{tab.name}</h3>
          <div className="live-panes">
            {tab.panes.map((p) => (
              <div
                key={p.id}
                className="live-pane"
                style={{
                  gridColumn: `${Math.round(p.rect.x * 12) + 1} / span ${Math.max(1, Math.round(p.rect.width * 12))}`,
                  gridRow: `${Math.round(p.rect.y * 12) + 1} / span ${Math.max(1, Math.round(p.rect.height * 12))}`,
                }}
              >
                <Button
                  size="sm"
                  variant={pane?.id === p.id ? "secondary" : "ghost"}
                  onClick={() => setSelected(p.id)}
                  aria-pressed={pane?.id === p.id}
                >
                  {p.title} · {p.id}
                </Button>
                <pre>{frames[p.id]?.text ?? "等待画面…"}</pre>
              </div>
            ))}
          </div>
        </section>
      ))}
      <div className="space-y-2">
        <label htmlFor="live-input" className="text-sm">
          发送到当前 Pane{pane ? ` · ${pane.id}` : ""}
        </label>
        <Input
          id="live-input"
          aria-label="发送到当前 Pane"
          value={text}
          onChange={(e) =>
            setDraft({ target: targetIdentity, text: e.target.value })
          }
          maxLength={8000}
          disabled={disabled}
          placeholder="输入文字或指令"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={disabled || !text}
            onClick={() => send(["enter"], text)}
          >
            发送并回车
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || !text}
            onClick={() => send([], text)}
          >
            仅发送文字
          </Button>
          {(
            [
              ["enter", "Enter"],
              ["ctrl+c", "Ctrl+C"],
              ["ctrl+d", "Ctrl+D"],
              ["ctrl+l", "Ctrl+L"],
              ["esc", "Esc"],
              ["tab", "Tab"],
              ["shift+tab", "Shift+Tab"],
              ["backspace", "⌫"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => send([key])}
            >
              {label}
            </Button>
          ))}
        </div>
        <p role="status" className="text-xs text-basalt-muted-foreground">
          {busy ? "等待提交结果…" : receipt}
        </p>
      </div>
    </section>
  );
}
