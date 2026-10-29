import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

test("installed Agent launchd service survives its caller, starts once and can stop with damaged configuration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "eagle-service-integration-"));
  const configDirectory = join(root, "private");
  mkdirSync(configDirectory, { mode: 0o700 });
  const config = join(configDirectory, "agent.json");
  const token = "isolated-launchd-machine-credential-at-least-32-characters";
  const http = createServer();
  const bridge = new WebSocketServer({ noServer: true });
  const connections: WebSocket[] = [];
  const replies: Record<string, unknown>[] = [];
  let rejectAuthentication = false;
  let rejectedHandshakes = 0;
  http.on("upgrade", (request, socket, head) => {
    assert.equal(request.url, "/api/v1/execution-agent");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["x-eagle-machine"], "service-mac");
    if (rejectAuthentication) {
      rejectedHandshakes += 1;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    bridge.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => {});
      client.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "hello") connections.push(client);
        else if (message.type === "ping")
          client.send(JSON.stringify({ type: "pong" }));
        else replies.push(message);
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const cli = join(root, "node_modules/@nocoo/eagle-agent/dist/agent/cli.js");
  const configuration = JSON.stringify({
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    token,
    ownerOrigin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    machineId: "service-mac",
    machineName: "Service fixture",
    execution: { commands: true, workingDirectory: root },
  });
  const saved = Buffer.from(configuration);
  const native = join(root, "native-service");
  async function invoke(action: string, expected = 0) {
    const child = spawn(process.execPath, [cli, "service", action], {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        EAGLE_CONFIG: config,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data;
    });
    child.stderr.on("data", (data: Buffer) => {
      error += data;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
    const [exit] = await once(child, "exit");
    clearTimeout(timeout);
    assert.equal((output + error).includes(token), false);
    assert.equal(exit, expected, output + error);
    return expected === 0
      ? (JSON.parse(output) as {
          label: string;
          installed: boolean;
          loaded: boolean;
          disabled: boolean;
          running: boolean;
          pid: number | null;
          lastExit: number | null;
        })
      : null;
  }
  let label: string | undefined;
  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "./packages/agent", "--pack-destination", root, "--json"],
        {
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    )[0];
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        root,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(root, packed.filename),
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-swift-version",
        "6",
        "-parse-as-library",
        "apps/macos/Sources/EagleFeatures/Machines/LocalAgentService.swift",
        "tests/fixtures/native-agent-service.swift",
        "-o",
        native,
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    const initialized = execFileSync(
      native,
      [process.execPath, cli, config, "initialize"],
      { input: configuration, timeout: 20_000, encoding: "utf8" },
    );
    assert.equal(initialized.trim(), "configured");
    assert.equal(readFileSync(config, "utf8").includes(token), true);
    const initial = await invoke("status");
    assert(initial);
    label = initial.label;
    assert.match(label, /^ai\.hexly\.eagle\.agent\.[0-9a-f]{24}$/);
    assert.equal(initial.installed, false);
    const installed = await invoke("install");
    assert(installed?.installed && installed.disabled && !installed.loaded);
    assert.equal(
      existsSync(join(configDirectory, "execution/operations.sqlite")),
      false,
      "status/install never claim the execution journal",
    );
    const lock = new DatabaseSync(
      join(configDirectory, "service-control.sqlite"),
    );
    try {
      lock.exec("BEGIN EXCLUSIVE");
      await invoke("start", 1);
      assert.equal((await invoke("status"))?.loaded, false);
    } finally {
      lock.close();
    }
    chmodSync(config, 0o644);
    await invoke("start", 1);
    chmodSync(config, 0o600);
    const plistPath = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
    const installedDefinition = readFileSync(plistPath);
    writeFileSync(
      plistPath,
      installedDefinition
        .toString()
        .replace("<string>serve</string>", "<string>once</string>"),
    );
    await invoke("start", 1);
    writeFileSync(plistPath, installedDefinition);
    await t.test(
      "a loaded foreign argv is refused even after the correct disk definition is restored",
      async () => {
        const target = `gui/${process.getuid?.()}/${label}`;
        const foreign = JSON.parse(
          execFileSync(
            "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", "--", plistPath],
            { encoding: "utf8" },
          ),
        );
        foreign.ProgramArguments = [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
        ];
        const definition = execFileSync(
          "/usr/bin/plutil",
          ["-convert", "xml1", "-o", "-", "--", "-"],
          { input: JSON.stringify(foreign) },
        );
        writeFileSync(plistPath, definition);
        try {
          execFileSync("/bin/launchctl", ["enable", target]);
          execFileSync("/bin/launchctl", [
            "bootstrap",
            `gui/${process.getuid?.()}`,
            plistPath,
          ]);
          writeFileSync(plistPath, installedDefinition);
          await invoke("stop", 1);
          assert.equal(
            spawnSync("/bin/launchctl", ["print", target]).status,
            0,
            "Foreign loaded job must remain untouched",
          );
        } finally {
          spawnSync("/bin/launchctl", ["disable", target], { timeout: 5000 });
          spawnSync("/bin/launchctl", ["bootout", target], { timeout: 5000 });
          writeFileSync(plistPath, installedDefinition);
        }
      },
    );
    const outputLog = join(configDirectory, "agent.stdout.log");
    rmSync(outputLog);
    symlinkSync(config, outputLog);
    await invoke("start", 1);
    rmSync(outputLog);
    const nativeStart = spawn(
      native,
      [process.execPath, cli, config, "start"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let nativeOutput = "";
    nativeStart.stdout.on("data", (bytes: Buffer) => {
      nativeOutput += bytes;
    });
    nativeStart.stderr.resume();
    const nativeTimeout = setTimeout(() => nativeStart.kill("SIGKILL"), 20_000);
    const [nativeExit] = await once(nativeStart, "exit");
    clearTimeout(nativeTimeout);
    assert.equal(nativeExit, 0);
    assert.equal(nativeOutput.includes(token), false);
    const first = JSON.parse(nativeOutput) as { running: boolean; pid: number };
    assert(first?.running && first.pid);
    const deadline = Date.now() + 5000;
    while (connections.length === 0 && Date.now() < deadline) await delay(20);
    assert.equal(connections.length, 1);
    await t.test(
      "start re-enables a running disabled job without replacing its PID",
      async () => {
        const target = `gui/${process.getuid?.()}/${label}`;
        execFileSync("/bin/launchctl", ["disable", target]);
        try {
          const resumed = await invoke("start");
          assert.equal(resumed?.pid, first.pid);
          assert.equal(resumed?.disabled, false);
        } finally {
          execFileSync("/bin/launchctl", ["enable", target]);
        }
      },
    );
    const second = await invoke("start");
    assert.equal(second?.pid, first.pid);
    assert.equal(connections.length, 1);
    const operation = {
      id: "service-once",
      machineId: "service-mac",
      tool: "command.exec",
      program: process.execPath,
      args: [
        "-e",
        "require('node:fs').appendFileSync('service-effect','x');process.stdout.write('service-result')",
      ],
    };
    connections[0].send(
      JSON.stringify({
        type: "run",
        requestId: "service-request",
        clientId: randomUUID(),
        operation,
      }),
    );
    const finished = Date.now() + 3000;
    while (replies.length === 0 && Date.now() < finished) await delay(10);
    assert.deepEqual(replies[0]?.operation, {
      id: "service-once",
      state: "succeeded",
      stdout: "service-result",
      stderr: "",
      exitCode: 0,
    });
    assert.equal(readFileSync(join(root, "service-effect"), "utf8"), "x");
    const repair = {
      machineId: "service-mac",
      url: JSON.parse(configuration).url,
      ownerOrigin: JSON.parse(configuration).ownerOrigin,
      execution: { commands: true, workingDirectory: root },
    };
    const liveRepair = spawnSync(
      native,
      [process.execPath, cli, config, "reconfigure"],
      {
        input: JSON.stringify(repair),
        timeout: 20_000,
        encoding: "utf8",
      },
    );
    assert.equal(
      liveRepair.status,
      1,
      "running service must be stopped before config replacement",
    );
    assert.equal(JSON.parse(readFileSync(config, "utf8")).token, token);
    writeFileSync(config, "damaged configuration", { mode: 0o600 });
    assert.equal((await invoke("status"))?.pid, first.pid);
    const stopped = await invoke("stop");
    assert(stopped?.disabled && !stopped.loaded && !stopped.running);
    await delay(250);
    assert.equal((await invoke("status"))?.loaded, false);
    const retainedDiagnostics = "previous service diagnostic\n".repeat(3500);
    writeFileSync(
      join(configDirectory, "agent.stderr.log"),
      retainedDiagnostics,
      { mode: 0o600 },
    );
    writeFileSync(config, saved, { mode: 0o600 });
    const resumed = await invoke("start");
    assert(resumed?.running && resumed.pid !== first.pid);
    assert.equal(
      readFileSync(
        join(configDirectory, "agent.stderr.log"),
        "utf8",
      ).startsWith(retainedDiagnostics),
      true,
    );
    assert.equal(readFileSync(join(root, "service-effect"), "utf8"), "x");
    const receipt = readFileSync(join(configDirectory, "service.json"), "utf8");
    const plist = readFileSync(
      join(homedir(), "Library/LaunchAgents", `${label}.plist`),
      "utf8",
    );
    assert.equal((receipt + plist).includes(token), false);
    assert.equal(plist.includes(cli), true);
    await invoke("stop");
    await t.test(
      "the native controller repairs a stopped same-deployment config without resetting execution evidence",
      async () => {
        const broken = JSON.parse(configuration);
        broken.execution.workingDirectory = ".";
        writeFileSync(config, JSON.stringify(broken));
        const identity = JSON.parse(
          execFileSync(process.execPath, [cli, "identity"], {
            env: { PATH: "/usr/bin:/bin", EAGLE_CONFIG: config },
            encoding: "utf8",
            timeout: 5000,
          }),
        );
        assert.equal(identity.machineId, "service-mac");
        assert.equal(identity.ownerOrigin, broken.ownerOrigin);
        assert.equal(JSON.stringify(identity).includes(token), false);
        const result = execFileSync(
          native,
          [process.execPath, cli, config, "reconfigure"],
          {
            input: JSON.stringify(repair),
            timeout: 20_000,
            encoding: "utf8",
          },
        );
        assert.equal(result.trim(), "configured");
        assert.equal(
          JSON.parse(readFileSync(config, "utf8")).execution.workingDirectory,
          root,
        );
        assert.equal(JSON.parse(readFileSync(config, "utf8")).token, token);
        const evidence = new DatabaseSync(
          join(configDirectory, "execution/operations.sqlite"),
          { readOnly: true },
        );
        try {
          assert.equal(
            evidence
              .prepare("SELECT state FROM operations WHERE id = ?")
              .get("service-once")?.state,
            "succeeded",
          );
        } finally {
          evidence.close();
        }
        assert.equal((await invoke("status"))?.disabled, true);
      },
    );
    await t.test(
      "working directories reject relative paths and accept canonical directory symlinks",
      async () => {
        const value = JSON.parse(configuration);
        try {
          value.execution.workingDirectory = ".";
          writeFileSync(config, JSON.stringify(value));
          await invoke("start", 1);
          value.execution.workingDirectory = "/tmp";
          writeFileSync(config, JSON.stringify(value));
          assert.equal((await invoke("start"))?.running, true);
        } finally {
          await invoke("stop");
          writeFileSync(config, saved);
        }
      },
    );
    rejectAuthentication = true;
    await invoke("start");
    const exitDeadline = Date.now() + 5000;
    let exited = await invoke("status");
    while (exited?.lastExit !== 1 && Date.now() < exitDeadline) {
      await delay(30);
      exited = await invoke("status");
    }
    assert.equal(exited?.lastExit, 1);
    assert.equal(exited?.running, false);
    // Cross launchd's default 10-second throttle interval: exit(1) is not a crash.
    await delay(10_500);
    assert.equal(rejectedHandshakes, 1);
    assert.equal((await invoke("status"))?.running, false);
    assert.equal(
      JSON.parse(readFileSync(config, "utf8")).token,
      JSON.parse(saved.toString()).token,
    );
  } finally {
    let remaining = false;
    try {
      if (label) {
        const target = `gui/${process.getuid?.()}/${label}`;
        const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
        if (existsSync(plist)) {
          // Independent cleanup still runs when the implementation's stop is red.
          spawnSync("/bin/launchctl", ["disable", target], { timeout: 5000 });
          spawnSync("/bin/launchctl", ["bootout", target], { timeout: 5000 });
          remaining =
            spawnSync("/bin/launchctl", ["print", target], { timeout: 5000 })
              .status !== 113;
          if (!remaining) {
            execFileSync("/bin/launchctl", ["enable", target], {
              timeout: 5000,
            });
            rmSync(plist);
          }
        }
      }
    } finally {
      for (const client of bridge.clients) client.terminate();
      bridge.close();
      await new Promise<void>((done) => http.close(() => done()));
      if (!remaining) rmSync(root, { recursive: true, force: true });
    }
    assert.equal(
      remaining,
      false,
      `Owned test service remained loaded; evidence kept at ${root}`,
    );
  }
});
