import { Button } from "@nocoo/basalt";
import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveFrame } from "../shared/realtime.ts";
import { terminalColor } from "../shared/terminal.ts";

export function TerminalOutput({
  frame,
  selected,
}: {
  frame?: LiveFrame;
  selected: boolean;
}) {
  const screen = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const wasSelected = useRef(selected);
  const previous = useRef("");
  const [unread, setUnread] = useState(false);
  const content = JSON.stringify([frame?.text, frame?.runs]);
  const toBottom = () => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    if (selected && !wasSelected.current) following.current = true;
    wasSelected.current = selected;
    const changed = previous.current !== content;
    previous.current = content;
    if (following.current) {
      toBottom();
      setUnread(false);
    } else if (changed && frame) setUnread(true);
  }, [content, selected, frame]);
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (following.current) toBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  let offset = 0;
  return (
    <div className="live-output">
      <pre
        ref={screen}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Output is a keyboard-scrollable region, not an input control.
        tabIndex={0}
        onScroll={() => {
          const el = screen.current;
          if (!el) return;
          following.current =
            el.scrollHeight - el.clientHeight - el.scrollTop <= 12;
          if (following.current) setUnread(false);
        }}
      >
        {frame?.runs
          ? frame.runs.map((run) => {
              const key = offset;
              offset += run.text.length;
              const fg = terminalColor(run.fg),
                bg = terminalColor(run.bg);
              return (
                <span
                  key={key}
                  style={{
                    color: run.inverse ? (bg ?? "#000000") : fg,
                    backgroundColor: run.inverse
                      ? (fg ?? "hsl(var(--basalt-foreground))")
                      : bg,
                    fontWeight: run.bold ? 700 : undefined,
                    opacity: run.dim ? 0.7 : undefined,
                    fontStyle: run.italic ? "italic" : undefined,
                    textDecoration: run.underline ? "underline" : undefined,
                  }}
                >
                  {run.text}
                </span>
              );
            })
          : (frame?.text ?? "等待画面…")}
      </pre>
      {unread && (
        <Button
          className="live-follow"
          size="sm"
          variant="secondary"
          aria-label="新输出，回到底部"
          onClick={() => {
            following.current = true;
            toBottom();
            setUnread(false);
          }}
        >
          <ArrowDown size={13} aria-hidden="true" />
          新输出 · 回到底部
        </Button>
      )}
    </div>
  );
}

export function OutputActivity({
  frame,
  online,
}: {
  frame?: LiveFrame;
  online: boolean;
}) {
  const [recent, setRecent] = useState(false);
  const content = frame
    ? JSON.stringify([
        frame.subscriptionId,
        frame.terminalId,
        frame.text,
        frame.runs,
      ])
    : "";
  useEffect(() => {
    setRecent(!!content && online);
    if (!content || !online) return;
    const timer = setTimeout(() => setRecent(false), 3000);
    return () => clearTimeout(timer);
  }, [content, online]);
  return (
    <div
      className="live-output-activity"
      role="status"
      aria-label="终端输出状态"
      title="仅表示画面内容变化；连接在线或暂时无输出都不能证明任务完成。"
    >
      <span
        className="live-output-pulse"
        data-active={recent && online}
        aria-hidden="true"
      />
      {!online
        ? "连接未就绪"
        : !frame
          ? "已连接 · 等待画面"
          : recent
            ? "刚有新输出"
            : "已连接 · 等待新输出"}
    </div>
  );
}
