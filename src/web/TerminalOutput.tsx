import { Button } from "@nocoo/basalt";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { LiveFrame } from "../shared/realtime.ts";
import { compactRenderedFrame } from "../shared/terminal-display.ts";
import { TerminalText } from "./TerminalText.tsx";

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
  const display = frame ? compactRenderedFrame(frame) : undefined;
  const content = JSON.stringify([display?.text, display?.runs]);
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
  return (
    <div className="live-output">
      <pre
        ref={screen}
        data-compact-footer={!!frame && display?.text !== frame.text}
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
        <TerminalText
          text={display?.text ?? "等待画面…"}
          runs={display?.runs}
        />
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
