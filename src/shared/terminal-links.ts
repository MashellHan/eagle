import type { TerminalRun } from "./terminal.ts";

export interface TerminalLinkPart {
  start: number;
  href?: string;
  runs: TerminalRun[];
}

/** Only link visible, already-redacted HTTP(S) text. Never join terminal lines. */
export function terminalLinkParts(
  text: string,
  styled?: TerminalRun[],
): TerminalLinkPart[] {
  const links: { start: number; end: number; href: string }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    if (links.length >= 128) break;
    const raw = match[0];
    if (match.index && /[\p{L}\p{N}_@:/\\.+-]/u.test(text[match.index - 1]))
      continue;
    if (raw.length > 4096 || /[\p{Cc}\p{Cf}\\*]|\[REDACTED\b/iu.test(raw))
      continue;
    let candidate = raw;
    const pairs = [
      [")", "("],
      ["]", "["],
      ["}", "{"],
    ] as const;
    const excess = new Map(
      pairs.map(([close, open]) => [
        close,
        raw.split(close).length - raw.split(open).length,
      ]),
    );
    while (candidate) {
      const last = candidate.at(-1) ?? "";
      const closer = pairs.find(([close]) => close === last)?.[0];
      if (/[.,;!，。；！]/u.test(last)) candidate = candidate.slice(0, -1);
      else if (closer && (excess.get(closer) ?? 0) > 0) {
        candidate = candidate.slice(0, -1);
        excess.set(closer, (excess.get(closer) ?? 0) - 1);
      } else break;
    }
    try {
      const url = new URL(candidate);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        continue;
      links.push({
        start: match.index,
        end: match.index + candidate.length,
        href: candidate,
      });
    } catch {
      /* Malformed addresses stay ordinary terminal text. */
    }
  }
  // Use only validated matching styles; every emitted character comes from text.
  const source =
    styled?.map((run) => run.text).join("") === text ? styled : [{ text }];
  const parts: TerminalLinkPart[] = [];
  let cursor = 0,
    runIndex = 0,
    runOffset = 0;
  const take = (end: number, href?: string) => {
    if (end <= cursor) return;
    const part: TerminalLinkPart = {
      start: cursor,
      ...(href ? { href } : {}),
      runs: [],
    };
    while (cursor < end) {
      const run = source[runIndex];
      const size = Math.min(end - cursor, run.text.length - runOffset);
      const { text: _original, ...style } = run;
      part.runs.push({ ...style, text: text.slice(cursor, cursor + size) });
      cursor += size;
      runOffset += size;
      if (runOffset === run.text.length) {
        runIndex++;
        runOffset = 0;
      }
    }
    parts.push(part);
  };
  for (const link of links) {
    take(link.start);
    take(link.end, link.href);
  }
  take(text.length);
  return parts;
}
