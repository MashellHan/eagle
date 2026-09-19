import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("npm agent artifact installs outside the checkout and accepts credentials only through secure config", () => {
  const directory = mkdtempSync(join(tmpdir(), "eagle-agent-package-"));
  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "./agent", "--pack-destination", directory, "--json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    )[0];
    assert(
      packed.files.every(
        (file: { path: string }) =>
          !/\.ts$|\.local|\.env|\.dev.vars/.test(file.path),
      ),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        directory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(directory, packed.filename),
      ],
      { stdio: "pipe" },
    );
    const cli = join(directory, "node_modules/.bin/eagle-agent");
    assert.match(
      execFileSync(cli, ["--help"], { encoding: "utf8" }),
      /init.*once.*watch/s,
    );
    const config = {
      url: "http://127.0.0.1:37053",
      machineId: "pack-test",
      machineName: "Package test",
      token: "test-package-secret-at-least-32-characters",
      watchPorts: [{ name: "Raven", port: 7024 }],
    };
    const configPath = join(directory, "config/agent.json");
    const env = { ...process.env, EAGLE_CONFIG: configPath };
    const initialized = spawnSync(cli, ["init"], {
      env,
      input: JSON.stringify(config),
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert(!initialized.stdout.includes(config.token));
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, "config")).mode & 0o777, 0o700);
    assert.equal(
      JSON.parse(readFileSync(configPath, "utf8")).token,
      config.token,
    );
    assert.notEqual(
      spawnSync(cli, ["init"], {
        env,
        input: JSON.stringify({
          ...config,
          token: "replacement-secret-at-least-32-characters",
        }),
      }).status,
      0,
    );
    assert.equal(
      JSON.parse(readFileSync(configPath, "utf8")).token,
      config.token,
    );
    const invalid = spawnSync(cli, ["init"], {
      env: { ...env, EAGLE_CONFIG: join(directory, "bad.json") },
      input: JSON.stringify({ ...config, url: "http://untrusted.test" }),
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
    assert(!(invalid.stdout + invalid.stderr).includes(config.token));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
