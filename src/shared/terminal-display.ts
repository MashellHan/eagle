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
    `${model[1]} · ${model[2].trim()}`,
  ].join("\n");
}
