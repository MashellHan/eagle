import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleAgent } from "../scripts/bundle-agent.ts";

test("a bundle contender cannot remove a directory claimed between its check and mkdir", (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "eagle-bundle-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = join(root, "Agent");
  const mkdir = fs.mkdirSync;
  let injected = false;
  t.mock.method(
    fs,
    "mkdirSync",
    (path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(path) === target && !injected) {
        injected = true;
        mkdir(target);
        fs.writeFileSync(join(target, "other-owner"), "retained");
      }
      return mkdir(path, options);
    },
  );
  t.mock.method(childProcess, "execFileSync", () => {
    throw new Error("Injected packaging failure");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => bundleAgent(target));
    assert.equal(
      fs.readFileSync(join(target, "other-owner"), "utf8"),
      "retained",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent assembly refuses an installed dependency that differs from the repository lock", (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "eagle-bundle-dependency-"));
  const target = join(root, "Agent");
  const execute = childProcess.execFileSync;
  let changed = false;
  t.mock.method(
    childProcess,
    "execFileSync",
    (...args: Parameters<typeof execute>) => {
      const output = Reflect.apply(execute, childProcess, args);
      const command = args[1];
      if (
        args[0] === "npm" &&
        Array.isArray(command) &&
        (command[0] === "install" || command[0] === "ci") &&
        !command.includes("--package-lock-only")
      ) {
        const manifest = join(target, "node_modules/zod/package.json");
        const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
        value.version = "0.0.0-fixture-unlocked";
        fs.writeFileSync(manifest, JSON.stringify(value));
        changed = true;
      }
      return output;
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(() => bundleAgent(target), /locked dependency/i);
    assert(
      changed,
      "the actual private install was changed, not the source or npm cache",
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
