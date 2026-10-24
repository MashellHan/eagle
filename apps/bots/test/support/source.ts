// A minimal, syntax-aware dependency extractor for the architecture test. It walks the
// source once, tracking comments, strings and templates, so a mention of `from "./x"`
// inside a comment or a plain string is not mistaken for an import, and dynamic
// imports with options are still found.
type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string };

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: Token["kind"], value: string) => tokens.push({ kind, value });
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
          // Skip an interpolation: it cannot contain a module specifier we want.
          let depth = 1;
          index += 2;
          while (index < source.length && depth > 0) {
            if (source[index] === "{") depth += 1;
            if (source[index] === "}") depth -= 1;
            index += 1;
          }
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      push("string", value);
      continue;
    }
    if (/[A-Za-z_$]/.test(char ?? "")) {
      let value = "";
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? "")) {
        value += source[index];
        index += 1;
      }
      push("ident", value);
      continue;
    }
    if (/[(){};,]/.test(char ?? "")) {
      push("punct", char as string);
      index += 1;
      continue;
    }
    index += 1;
  }
  return tokens;
}

/** Every module specifier the source depends on, in any import form. */
export function dependenciesOf(source: string): string[] {
  const tokens = tokenize(source);
  const found = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "ident") continue;
    if (token.value === "import") {
      const after = tokens[index + 1];
      if (after?.kind === "string") {
        found.add(after.value); // side-effect import
        continue;
      }
      if (after?.kind === "punct" && after.value === "(") {
        const argument = tokens[index + 2];
        if (argument?.kind === "string") found.add(argument.value); // dynamic import
        continue;
      }
    }
    if ((token.value === "import" || token.value === "export") && tokens[index + 1]) {
      // Walk to `from "..."` before the statement ends.
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const current = tokens[cursor];
        if (current?.kind === "punct" && (current.value === ";" || current.value === ")")) break;
        if (current?.kind === "ident" && current.value === "from") {
          const specifier = tokens[cursor + 1];
          if (specifier?.kind === "string") found.add(specifier.value);
          break;
        }
      }
    }
  }
  return [...found];
}
