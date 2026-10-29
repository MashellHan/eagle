import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleAgent } from "../scripts/bundle-agent.ts";

test("the App receives a self-contained local candidate without a published candidate dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "eagle-app-agent-bundle-"));
  try {
    const destination = join(root, "Eagle.app/Contents/Resources/Agent");
    const result = bundleAgent(destination);
    const version = JSON.parse(
      readFileSync("packages/agent/package.json", "utf8"),
    ).version;
    assert.equal(result.version, version);
    assert.equal(
      result.cli,
      join(destination, "node_modules/@nocoo/eagle-agent/dist/agent/cli.js"),
    );
    assert.equal(
      execFileSync(process.execPath, [result.cli, "--version"], {
        cwd: root,
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      }).trim(),
      version,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(destination, "node_modules/@nocoo/eagle-agent/package.json"),
          "utf8",
        ),
      ).version,
      version,
    );
    const rootLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const bundledLock = JSON.parse(
      readFileSync(join(destination, "package-lock.json"), "utf8"),
    );
    for (const name of ["ws", "zod"]) {
      const expected = rootLock.packages[`node_modules/${name}`];
      const locked = bundledLock.packages[`node_modules/${name}`];
      assert.equal(locked.version, expected.version);
      assert.equal(locked.integrity, expected.integrity);
      assert.equal(
        JSON.parse(
          readFileSync(
            join(destination, "node_modules", name, "package.json"),
            "utf8",
          ),
        ).version,
        expected.version,
      );
    }
    assert.throws(() => bundleAgent(destination), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
