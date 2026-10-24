// Ladder row 8: the dependency rules in docs/bots/ARCHITECTURE.md, enforced by
// reading the source. A layer that imports across the arrow breaks the build here
// rather than in a later refactor.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") ? [path] : [];
  });
const sources = files(join(root, "src"));
const importsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
};

test("only the runtime adapter imports pi-durable", () => {
  for (const file of sources) {
    const rel = relative(root, file);
    const forbidden = importsOf(file).filter(
      (specifier) => specifier.startsWith("@earendil-works/") && !rel.startsWith("src/runtime/"),
    );
    assert.deepEqual(forbidden, [], `${rel} imports ${forbidden.join(", ")}`);
  }
});

test("core and protocol never import the runtime adapter", () => {
  for (const file of sources) {
    const rel = relative(root, file);
    if (!rel.startsWith("src/core/") && !rel.startsWith("src/protocol/")) continue;
    const forbidden = importsOf(file).filter((specifier) => specifier.includes("runtime/"));
    assert.deepEqual(forbidden, [], `${rel} imports ${forbidden.join(", ")}`);
  }
});

test("core does not depend on the wire layer", () => {
  for (const file of sources) {
    const rel = relative(root, file);
    if (!rel.startsWith("src/core/")) continue;
    const forbidden = importsOf(file).filter((specifier) => specifier.includes("protocol/"));
    assert.deepEqual(forbidden, [], `${rel} imports ${forbidden.join(", ")}`);
  }
});

test("the runtime adapter may only reach core's domain and port modules", () => {
  for (const file of sources) {
    const rel = relative(root, file);
    if (!rel.startsWith("src/runtime/")) continue;
    const coreImports = importsOf(file).filter((specifier) => specifier.includes("core/"));
    for (const specifier of coreImports) {
      assert.match(
        specifier,
        /core\/(domain|RuntimePort)\.ts$/,
        `${rel} imports ${specifier}, which the adapter does not own`,
      );
    }
  }
});

test("the log layer is shared infrastructure and imports nothing from features", () => {
  for (const file of sources) {
    const rel = relative(root, file);
    if (!rel.startsWith("src/log/")) continue;
    const forbidden = importsOf(file).filter((specifier) =>
      /(runtime|protocol|core\/Bot|core\/Event|core\/Conversation)/.test(specifier),
    );
    assert.deepEqual(forbidden, [], `${rel} imports ${forbidden.join(", ")}`);
  }
});
