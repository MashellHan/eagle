import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleDaemon } from "../../scripts/bundle.ts";

test("the bundled daemon starts outside its checkout with only production dependencies", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "bots-packaged-daemon-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const target = join(temporary, "App", "Contents", "Resources", "Bots");
    const artifact = bundleDaemon(target);
    assert.equal(existsSync(join(target, ".env")), false);
    assert.equal(existsSync(join(target, "test")), false);
    assert.equal(existsSync(join(target, "node_modules", "typescript")), false);
    const root = join(temporary, "private-state");
    child = spawn(process.execPath, [artifact.entry, "--root", root, "--port", "0"], {
      cwd: target,
      env: { PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(temporary, "config") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data;
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data;
    });
    const deadline = Date.now() + 10_000;
    while (!stdout.includes("\n") && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(stdout.includes("\n"), `packaged daemon must start: ${stderr}`);
    const start = JSON.parse(stdout.split("\n")[0] ?? "") as { port: number };
    const origin = `http://127.0.0.1:${start.port}`;
    const health = (await fetch(`${origin}/v1/health`, {
      signal: AbortSignal.timeout(5000),
    }).then((response) => response.json())) as {
      version: string;
    };
    assert.equal(health.version, artifact.version);
    const token = readFileSync(join(root, "token"), "utf8").trim();
    assert.equal(
      (
        await fetch(`${origin}/v1/bots`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      200,
    );
    assert.equal(stdout.includes(token) || stderr.includes(token), false);
    const exit = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
    child.kill("SIGTERM");
    assert.deepEqual(await exit, [0, null]);
    child = undefined;
    assert.throws(() => bundleDaemon(target), /already exists/);
    assert(existsSync(artifact.entry), "a rejected second build preserves the completed artifact");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit", { signal: AbortSignal.timeout(5000) });
      child.kill("SIGKILL");
      await exit;
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});
