import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("App assembly releases its lock when temporary staging cannot be created", (t) => {
  const root = mkdtempSync(join(tmpdir(), "eagle-app-assembly-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "apps/macos");
  const scripts = join(app, "Scripts");
  const binaries = join(root, "bin");
  const previous = join(app, ".build/Eagle.app");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(binaries);
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, "complete"), "last complete App");
  const script = join(scripts, "build-app.sh");
  copyFileSync(
    new URL("../../apps/macos/Scripts/build-app.sh", import.meta.url),
    script,
  );
  writeFileSync(join(binaries, "mktemp"), "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  const result = spawnSync("/bin/sh", [script], {
    cwd: root,
    env: { PATH: `${binaries}:/usr/bin:/bin` },
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(
    readFileSync(join(previous, "complete"), "utf8"),
    "last complete App",
  );
  assert.equal(existsSync(join(app, ".build/app-assembly.lock")), false);
});
