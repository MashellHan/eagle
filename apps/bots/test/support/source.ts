// Dependency extraction for the architecture test, using a real parser (@babel/parser)
// rather than a hand-rolled scanner: only import/export nodes and dynamic imports count,
// so a look-alike inside a comment, a string, a template body or an object key is not a
// dependency, while a dynamic import inside a template interpolation still is.
import { parse } from "@babel/parser";

type Node = {
  readonly type: string;
  readonly source?: { readonly value?: unknown } | null;
  readonly arguments?: readonly Node[];
  readonly callee?: Node;
  readonly expressions?: readonly Node[];
  readonly quasis?: readonly Node[];
  readonly body?: readonly Node[] | Node | null;
  readonly [key: string]: unknown;
};

const specifier = (node: Node | undefined | null): string | undefined => {
  const value = node?.source?.value;
  return typeof value === "string" ? value : undefined;
};

export function dependenciesOf(source: string): string[] {
  const file = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
    errorRecovery: false,
  }) as unknown as Node;
  const found = new Set<string>();

  const visit = (node: Node | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const value = specifier(node);
      if (value !== undefined) found.add(value);
    }
    if (node.type === "CallExpression" && node.callee?.type === "Import") {
      const argument = node.arguments?.[0];
      const value =
        argument?.type === "StringLiteral" ? (argument as { value?: unknown }).value : undefined;
      if (typeof value === "string") found.add(value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child as Node);
      } else if (value && typeof value === "object") visit(value as Node);
    }
  };

  visit(file);
  return [...found];
}
