import { z } from "zod";

const channel = z.number().int().min(0).max(255);
export const TerminalColorSchema = z.union([
  channel,
  z.tuple([channel, channel, channel]),
]);
export const TerminalRunSchema = z.strictObject({
  text: z.string().min(1).max(32000),
  fg: TerminalColorSchema.optional(),
  bg: TerminalColorSchema.optional(),
  bold: z.literal(true).optional(),
  dim: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
  inverse: z.literal(true).optional(),
});
export type TerminalRun = z.infer<typeof TerminalRunSchema>;
export type TerminalColor = z.infer<typeof TerminalColorSchema>;

/** Parse styling only: OSC, cursor commands and all executable controls are discarded. */
export function parseTerminalScreen(value: string) {
  let style: Omit<TerminalRun, "text"> = {};
  let hidden = false;
  const runs: TerminalRun[] = [];
  const append = (text: string) => {
    const clean = text.replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove terminal control bytes, preserving tabs and line breaks.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
      "",
    );
    if (clean)
      runs.push({
        ...style,
        text: hidden ? clean.replace(/[^\n\t]/g, "•") : clean,
      });
  };
  // Unterminated OSC/DCS strings are discarded through the end, never rendered as links/HTML.
  const escapes =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Recognize ANSI escapes in untrusted terminal text.
    /\u001b(?:\][\s\S]*?(?:\u0007|\u001b\\|$)|[PX^_][\s\S]*?(?:\u001b\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~]|$)/g;
  let offset = 0;
  for (const match of value.matchAll(escapes)) {
    append(value.slice(offset, match.index));
    offset = match.index + match[0].length;
    const code = match[0];
    if (!code.startsWith("\u001b[") || !code.endsWith("m")) continue;
    const raw = code.slice(2, -1);
    if (!/^[\d;]*$/.test(raw)) continue;
    const params = raw.split(";").map(Number);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        style = {};
        hidden = false;
      } else if (p === 1) style.bold = true;
      else if (p === 2) style.dim = true;
      else if (p === 3) style.italic = true;
      else if (p === 4) style.underline = true;
      else if (p === 7) style.inverse = true;
      else if (p === 8) hidden = true;
      else if (p === 22) {
        delete style.bold;
        delete style.dim;
      } else if (p === 23) delete style.italic;
      else if (p === 24) delete style.underline;
      else if (p === 27) delete style.inverse;
      else if (p === 28) hidden = false;
      else if (p === 39) delete style.fg;
      else if (p === 49) delete style.bg;
      else if (p >= 30 && p <= 37) style.fg = p - 30;
      else if (p >= 90 && p <= 97) style.fg = p - 90 + 8;
      else if (p >= 40 && p <= 47) style.bg = p - 40;
      else if (p >= 100 && p <= 107) style.bg = p - 100 + 8;
      else if (p === 38 || p === 48) {
        const field = p === 38 ? "fg" : "bg";
        const mode = params[++i];
        const size = mode === 5 ? 1 : mode === 2 ? 3 : 0;
        const values = params.slice(i + 1, i + 1 + size);
        if (
          size &&
          values.length === size &&
          values.every((v) => v >= 0 && v <= 255)
        )
          style[field] =
            size === 1 ? values[0] : (values as [number, number, number]);
        i += size;
      }
    }
  }
  append(value.slice(offset));
  return { text: runs.map((r) => r.text).join(""), runs };
}

/** Standard terminal palette; only validated integers can reach CSS. */
export function terminalColor(
  color: TerminalColor | undefined,
): string | undefined {
  if (color === undefined) return undefined;
  if (Array.isArray(color)) return `rgb(${color.join(", ")})`;
  const basic = [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
  ];
  if (color < 16) return basic[color];
  if (color >= 232)
    return `rgb(${Array(3)
      .fill(8 + (color - 232) * 10)
      .join(", ")})`;
  const n = color - 16,
    levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${[levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]].join(", ")})`;
}
