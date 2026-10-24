// Ladder row 8: the dependency arrows in docs/bots/ARCHITECTURE.md, enforced by
// reading the source. Imports are parsed in every form (static, re-export,
// side-effect, dynamic) and checked against an explicit allowlist per layer, so a
// new edge is a build failure rather than a convention.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import test from "node:test";
import { dependenciesOf } from "./support/source.ts";

const root = process.cwd();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });

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

test("only real import nodes count as dependencies", () => {
  const source = [
    'import { a } from "./a.ts";',
    'export { b } from "./b.ts";',
    'import "./side-effect.ts";',
    'const c = await import("./c.ts", { with: { type: "json" } });',
    'import type { D } from "@earendil-works/pi-durable";',
    '// import "./commented.ts";',
    '/* from "./block-commented.ts" */',
    "const text = 'import(\"./in-a-string.ts\")';",
    'const template = `from "./in-a-template.ts"`;',
    'const metadata = { import: "../protocol/version.ts" };',
    'export const alsoMetadata = { from: "../protocol/version.ts" };',
    `const lazy = \`${"$"}{await import("./in-interpolation.ts")}\`;`,
    "const templateOnly = await import(`./in-a-template-literal.ts`);",
    'export type Pi = typeof import("@earendil-works/pi-durable");',
    'export type Wire = typeof import("../protocol/version.ts");',
  ].join("\n");
  assert.deepEqual(dependenciesOf(source).sort(), [
    "../protocol/version.ts",
    "./a.ts",
    "./b.ts",
    "./c.ts",
    "./in-a-template-literal.ts",
    "./in-interpolation.ts",
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

test("type-only imports are caught end to end", () => {
  const source = ['export type PiModule = typeof import("@earendil-works/pi-durable");'].join("\n");
  const graph = [
    { file: "src/core/domain.ts", dependencies: dependenciesOf(source) },
    {
      file: "src/core/domain.ts",
      dependencies: dependenciesOf('export type T = typeof import("../protocol/version.ts");'),
    },
  ];
  const found = violations(graph);
  assert.equal(found.length, 2, "both a type import of pi-durable and of the wire layer must fail");
  assert.deepEqual(
    found.map((entry) => entry.file),
    ["src/core/domain.ts", "src/core/domain.ts"],
  );
});
