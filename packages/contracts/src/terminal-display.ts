import type { LiveFrame } from "./realtime.ts";
import type { TerminalRun } from "./terminal.ts";

/** Display-only cleanup; never alters the actual terminal or submitted input. */
export function compactTerminalText(text: string): string {
  const lines = text.split(/\r?\n/);
  let footer = lines.length - 1;
  while (footer >= 0 && !lines[footer].trim()) footer--;
  if (footer < 0) return text;
  const model = lines[footer].match(
    /^\s*(gpt-[\w.-]+(?:\s+(?:low|medium|high|xhigh|max|ultra))?)\s+·\s+((?:~[/\\]|\/|[A-Za-z]:[/\\])[^·]+?)(?:\s+·.*)?\s*$/,
  );
  if (!model) return text;
  let prompt = footer - 1;
  while (prompt >= 0 && !lines[prompt].trim()) prompt--;
  // Never hide typed input or placeholders quoted within ordinary output.
  if (prompt < 0 || !/^\s*› Ask Codex to do anything\s*$/.test(lines[prompt]))
    return text;
  let bodyEnd = prompt - 1;
  while (bodyEnd >= 0 && !lines[bodyEnd].trim()) bodyEnd--;
  return [
    ...lines.slice(0, bodyEnd + 1),
    ...(bodyEnd >= 0 ? [""] : []),
    `${model[1]} · ${model[2].trim()}`,
  ].join("\n");
}

/** Preserve text styles while omitting idle UI chrome from the displayed frame. */
export function compactRenderedFrame(frame: LiveFrame): LiveFrame {
  const text = compactTerminalText(frame.text);
  if (text === frame.text) return frame;
  if (!frame.runs) return { ...frame, text };
  let end = 0;
  const source = frame.runs.map((run) => {
    end += run.text.length;
    const { text: _text, ...style } = run;
    return { end, style };
  });
  const runs: TerminalRun[] = [];
  const append = (value: string, style: Omit<TerminalRun, "text"> = {}) => {
    if (!value) return;
    const previous = runs.at(-1);
    const { text: _text, ...previousStyle } = previous ?? { text: "" };
    if (previous && JSON.stringify(style) === JSON.stringify(previousStyle))
      previous.text += value;
    else runs.push({ ...style, text: value });
  };
  let cursor = 0,
    index = 0;
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (lineIndex) append("\n");
    if (!line) continue;
    const at = frame.text.indexOf(line, cursor);
    if (at < 0) {
      append(line);
      continue;
    }
    let offset = at;
    while (offset < at + line.length) {
      while (index < source.length && source[index].end <= offset) index++;
      const run = source[index];
      const next = Math.min(at + line.length, run?.end ?? at + line.length);
      append(line.slice(offset - at, next - at), run?.style);
      offset = next;
    }
    cursor = offset;
  }
  return { ...frame, text, runs };
}
