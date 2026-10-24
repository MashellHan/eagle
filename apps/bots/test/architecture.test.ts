// Ladder row 8: the dependency arrows in docs/bots/ARCHITECTURE.md, enforced by
// reading the source. Imports are parsed in every form (static, re-export,
// side-effect, dynamic) and checked against an explicit allowlist per layer, so a
// new edge is a build failure rather than a convention.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import test from "node:test";

const root = process.cwd();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });

/** Every specifier a file depends on, in any import form. */
export const dependenciesOf = (source: string): string[] => {
  const patterns = [
    /from\s*["']([^"']+)["']/g, // static import and re-export
    /import\s*["']([^"']+)["']/g, // side-effect import
    /import\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
};

const PACKAGE_IMPORT = /^@earendil-works\//;
const ALWAYS_ALLOWED = (target: string): boolean =>
  target === "src/core/domain.ts" || target.startsWith("src/log/");

/** Which local modules each layer may reach. Anything not listed cannot be reached. */
const EDGES: ReadonlyArray<{
  readonly prefix: string;
  readonly allows: (target: string) => boolean;
}> = [
  { prefix: "src/core/", allows: (target) => target.startsWith("src/core/") },
  {
    prefix: "src/protocol/",
    allows: (target) => target.startsWith("src/core/") || target.startsWith("src/protocol/"),
  },
  {
    prefix: "src/server/",
    allows: (target) =>
      target.startsWith("src/core/") ||
      target.startsWith("src/protocol/") ||
      target.startsWith("src/server/"),
  },
  {
    prefix: "src/runtime/",
    allows: (target) =>
      target.startsWith("src/runtime/") ||
      target === "src/core/domain.ts" ||
      target === "src/core/RuntimePort.ts",
  },
  { prefix: "src/log/", allows: (target) => target.startsWith("src/log/") },
];

const layerOf = (path: string) =>
  EDGES.find((edge) => path.startsWith(edge.prefix)) ?? { prefix: "", allows: () => true }; // entrypoint, config and test helpers may compose

/** Resolve a specifier to a repo-relative module path, or undefined when external. */
export const localTarget = (importer: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const dir = posix.dirname(importer);
  return posix.normalize(posix.join(dir, specifier));
};

export type Violation = {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
};

/** The whole rule set, as a pure function so the tests can feed it a synthetic graph. */
export const violations = (
  graph: ReadonlyArray<{ readonly file: string; readonly dependencies: readonly string[] }>,
): Violation[] => {
  const found: Violation[] = [];
  for (const { file, dependencies } of graph) {
    const layer = layerOf(file);
    for (const specifier of dependencies) {
      if (PACKAGE_IMPORT.test(specifier)) {
        if (file.startsWith("src/runtime/")) continue;
        found.push({ file, specifier, reason: "pi-durable belongs to the adapter" });
        continue;
      }
      const target = localTarget(file, specifier);
      if (target === undefined) continue;
      if (ALWAYS_ALLOWED(target)) continue;
      if (!layer.allows(target)) {
        found.push({
          file,
          specifier,
          reason: `${layer.prefix || "entrypoint"} may not reach ${target}`,
        });
      }
    }
  }
  return found;
};

test("the source graph satisfies the layer allowlist", () => {
  const graph = walk(join(root, "src")).map((file) => ({
    file: relative(root, file).replaceAll("\\", "/"),
    dependencies: dependenciesOf(readFileSync(file, "utf8")),
  }));
  assert.deepEqual(violations(graph), []);
});

test("every import form is extracted", () => {
  const source = [
    'import { a } from "./a.ts";',
    'export { b } from "./b.ts";',
    'import "./side-effect.ts";',
    'const c = await import("./c.ts");',
    'import type { D } from "@earendil-works/pi-durable";',
  ].join("\n");
  assert.deepEqual(dependenciesOf(source).sort(), [
    "./a.ts",
    "./b.ts",
    "./c.ts",
    "./side-effect.ts",
    "@earendil-works/pi-durable",
  ]);
});

test("the rules reject every forbidden edge", () => {
  const cases: ReadonlyArray<{ file: string; specifier: string }> = [
    { file: "src/core/domain.ts", specifier: "../protocol/version.ts" },
    { file: "src/core/domain.ts", specifier: "@earendil-works/pi-durable" },
    { file: "src/protocol/frames.ts", specifier: "../runtime/pi/mapEvents.ts" },
    { file: "src/runtime/pi/mapEvents.ts", specifier: "../../protocol/encode.ts" },
    { file: "src/runtime/pi/mapEvents.ts", specifier: "../../core/BotDirectory.ts" },
    { file: "src/log/log.ts", specifier: "../server/auth.ts" },
    { file: "src/core/BotDirectory.ts", specifier: "../server/http.ts" },
  ];
  for (const { file, specifier } of cases) {
    const found = violations([{ file, dependencies: [specifier] }]);
    assert.equal(found.length, 1, `${file} -> ${specifier} must be rejected`);
  }
});

test("the rules allow the documented edges", () => {
  const allowed: ReadonlyArray<{ file: string; specifier: string }> = [
    { file: "src/core/BotDirectory.ts", specifier: "./domain.ts" },
    { file: "src/core/BotDirectory.ts", specifier: "../log/log.ts" },
    { file: "src/protocol/encode.ts", specifier: "../core/domain.ts" },
    { file: "src/server/http.ts", specifier: "../protocol/frames.ts" },
    { file: "src/runtime/pi/PiDurableRuntime.ts", specifier: "@earendil-works/pi-durable" },
    { file: "src/runtime/pi/PiDurableRuntime.ts", specifier: "../../core/RuntimePort.ts" },
    { file: "src/main.ts", specifier: "./server/http.ts" },
  ];
  assert.deepEqual(
    violations(allowed.map(({ file, specifier }) => ({ file, dependencies: [specifier] }))),
    [],
  );
});
