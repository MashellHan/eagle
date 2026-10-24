import { Link } from "@nocoo/basalt/components/link";
import {
  type TerminalRun,
  terminalColor,
} from "../../../../packages/contracts/src/terminal.ts";
import { terminalLinkParts } from "../../../../packages/contracts/src/terminal-links.ts";

export function TerminalText({
  text,
  runs,
}: {
  text: string;
  runs?: TerminalRun[];
}) {
  return terminalLinkParts(text, runs).map((part) => {
    let offset = part.start;
    const content = part.runs.map((run) => {
      const key = offset;
      offset += run.text.length;
      const fg = terminalColor(run.fg),
        bg = terminalColor(run.bg);
      return (
        <span
          key={key}
          style={{
            color: run.inverse ? (bg ?? "var(--terminal-bg)") : fg,
            backgroundColor: run.inverse ? (fg ?? "var(--terminal-fg)") : bg,
            fontWeight: run.bold ? 700 : undefined,
            opacity: run.dim ? 0.7 : undefined,
            fontStyle: run.italic ? "italic" : undefined,
            textDecoration: run.underline ? "underline" : undefined,
          }}
        >
          {run.text}
        </span>
      );
    });
    return part.href ? (
      <Link
        key={part.start}
        className="live-terminal-link"
        href={part.href}
        draggable={false}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        title="在新标签页打开链接"
        onClick={(event) => {
          const selection = document.getSelection();
          if (
            selection &&
            !selection.isCollapsed &&
            selection.containsNode(event.currentTarget, true)
          )
            event.preventDefault();
        }}
      >
        {content}
      </Link>
    ) : (
      <span key={part.start}>{content}</span>
    );
  });
}
