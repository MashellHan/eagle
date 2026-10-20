import { Button } from "@nocoo/basalt";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { LiveFrame } from "../shared/realtime.ts";
import { terminalColor } from "../shared/terminal.ts";
import { compactRenderedFrame } from "../shared/terminal-display.ts";

export interface TerminalPosition {
  top: number;
  left: number;
  following: boolean;
  unread: boolean;
}

export function TerminalOutput({
  frame,
  selected,
  position,
  onPosition,
}: {
  frame?: LiveFrame;
  selected: boolean;
  position?: TerminalPosition;
  onPosition?: (position: TerminalPosition) => void;
}) {
  const screen = useRef<HTMLPreElement>(null);
  const following = useRef(position?.following ?? true);
  const initialPosition = useRef(position);
  const initialized = useRef(false);
  const [unread, setUnread] = useState(position?.unread ?? false);
  const display = frame ? compactRenderedFrame(frame) : undefined;
  const content = JSON.stringify([display?.text, display?.runs]);
  const previous = useRef(content);
  const save = useRef(onPosition);
  save.current = onPosition;
  const toBottom = () => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const restore = () => {
    const el = screen.current;
    if (!initialized.current && el?.clientHeight) {
      initialized.current = true;
      el.scrollTop = initialPosition.current?.top ?? 0;
      el.scrollLeft = initialPosition.current?.left ?? 0;
    }
  };
  useLayoutEffect(() => {
    restore();
    const changed = previous.current !== content;
    previous.current = content;
    if (following.current) {
      toBottom();
      setUnread(false);
    } else if (changed) setUnread(true);
  }, [content, selected]);
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const record = () => {
      if (!el.clientHeight) return;
      save.current?.({
        top: el.scrollTop,
        left: el.scrollLeft,
        following: following.current,
        unread,
      });
    };
    record();
    return record;
  }, [unread]);
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      restore();
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
        data-compact-footer={!!frame && display?.text !== frame.text}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Output is a keyboard-scrollable region, not an input control.
        tabIndex={0}
        onScroll={() => {
          const el = screen.current;
          if (!el?.clientHeight) return;
          following.current =
            el.scrollHeight - el.clientHeight - el.scrollTop <= 12;
          save.current?.({
            top: el.scrollTop,
            left: el.scrollLeft,
            following: following.current,
            unread: following.current ? false : unread,
          });
          if (following.current) setUnread(false);
        }}
      >
        {display?.runs
          ? display.runs.map((run) => {
              const key = offset;
              offset += run.text.length;
              const fg = terminalColor(run.fg),
                bg = terminalColor(run.bg);
              return (
                <span
                  key={key}
                  style={{
                    color: run.inverse ? (bg ?? "var(--terminal-bg)") : fg,
                    backgroundColor: run.inverse
                      ? (fg ?? "var(--terminal-fg)")
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
          : (display?.text ?? "等待画面…")}
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
