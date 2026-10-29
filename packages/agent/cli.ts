#!/usr/bin/env node
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ReportSchema } from "../contracts/src/schema.ts";
import {
  type AgentConfig,
  checkUrl,
  collect,
  sendReport,
  stripRetiredConfig,
} from "./collector.ts";
import { ConfigSchema } from "./config.ts";
import { executionWatch } from "./execution-service.ts";
import { FileGrants } from "./file-grants.ts";
import { realtimeWatch } from "./realtime.ts";
import {
  assertReservedIdentity,
  ensurePrivateConfiguration,
  prepareIdentity,
  serviceCommand,
  servicePaths,
  updateConfiguration,
  validateConfiguration,
} from "./service.ts";
import { drainSpool } from "./spool.ts";
import { AGENT_VERSION } from "./version.ts";

const path = servicePaths(
  process.env.EAGLE_CONFIG || join(homedir(), ".config/eagle/agent.json"),
).config;
async function stdinJSON(): Promise<unknown> {
  if (process.stdin.isTTY)
    throw new Error(
      "Pass JSON through stdin; never pass credentials as arguments",
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new Error("Configuration exceeds 64 KiB");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new Error("Invalid configuration JSON");
  }
}
async function heartbeat(config: AgentConfig, warning?: string) {
  const response = await fetch(`${checkUrl(config.url)}/api/v1/heartbeat`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      machineId: config.machineId,
      sentAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Heartbeat rejected (${response.status})`);
}
async function cycle(config: AgentConfig) {
  const spool = config.spoolDir || join(dirname(path), "spool");
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const files = (await readdir(spool))
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length >= 1000)
    await drainSpool(spool, config.machineId, (pending) =>
      sendReport(config.url, config.token, pending),
    );
  let report: Awaited<ReturnType<typeof collect>>;
  try {
    report = await collect(config);
  } catch {
    await heartbeat(
      config,
      "采集失败：保留上一次完整快照，请检查本机 Agent 日志",
    ).catch(() => {});
    throw new Error("Collection failed; previous complete inventory preserved");
  }
  const name = `${report.capturedAt.replaceAll(":", "-")}-${report.reportId}.json`;
  await writeFile(join(spool, `${name}.tmp`), JSON.stringify(report), {
    mode: 0o600,
  });
  await rename(join(spool, `${name}.tmp`), join(spool, name));
  const drained = await drainSpool(spool, config.machineId, (pending) =>
    sendReport(config.url, config.token, pending),
  );
  if (drained.rejected)
    await heartbeat(
      config,
      `${drained.rejected} 份无效上报已隔离保留，请检查本机 spool/rejected`,
    );
  console.log(
    JSON.stringify({
      event: "reported",
      at: report.capturedAt,
      spaces: report.spaces.length,
      panes: report.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes))
        .length,
      warnings: report.warnings.length,
    }),
  );
}
async function main() {
  const action = process.argv[2] || "once";
  if (action === "--help" || action === "help") {
    console.log(
      "Eagle Agent\nCommands: identity (reserve local ID), init/reconfigure (JSON on stdin), serve, service install/start/stop/status, files list/grant/revoke (changes by JSON stdin), collect <file>, upload <file>, once, watch, realtime-watch, heartbeat\nConfig: EAGLE_CONFIG or ~/.config/eagle/agent.json (0600). Node.js 24+. Herdr is required only for collection/realtime; serve is independent and commands default to disabled.",
    );
    return;
  }
  if (action === "--version") {
    console.log(AGENT_VERSION);
    return;
  }
  if (action === "service") {
    console.log(
      JSON.stringify(
        serviceCommand(
          process.argv[3] ?? "status",
          path,
          fileURLToPath(import.meta.url),
        ),
      ),
    );
    return;
  }
  if (action === "identity") {
    console.log(JSON.stringify(prepareIdentity(path)));
    return;
  }
  if (action === "files") {
    const grants = new FileGrants(path);
    const operation = process.argv[3] ?? "list";
    if (operation === "list")
      console.log(JSON.stringify({ grants: grants.list() }));
    else if (operation === "grant")
      console.log(JSON.stringify({ grant: grants.grant(await stdinJSON()) }));
    else if (operation === "revoke") {
      const request = z
        .strictObject({ id: z.string() })
        .parse(await stdinJSON());
      grants.revoke(request.id);
      console.log(JSON.stringify({ grants: grants.list() }));
    } else
      throw new Error("File commands: list, grant or revoke (JSON on stdin)");
    return;
  }
  if (action === "init" || action === "reconfigure") {
    const value = await stdinJSON();
    if (action === "reconfigure") {
      updateConfiguration(path, value);
      console.log(
        "Secure configuration updated for the same machine and deployment; start the service explicitly.",
      );
      return;
    }
    const config = validateConfiguration(value);
    ensurePrivateConfiguration(path);
    assertReservedIdentity(path, config.machineId);
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(config, null, 2));
    } finally {
      await file.close();
    }
    console.log(
      "Secure configuration created. Run eagle-agent serve to verify the independent execution connection. Optional Herdr collection: eagle-agent once.",
    );
    return;
  }
  const permissions = await stat(path);
  if (process.platform !== "win32" && (permissions.mode & 0o077) !== 0)
    throw new Error("Config must have mode 0600");
  const retired = stripRetiredConfig(JSON.parse(await readFile(path, "utf8")));
  if (retired.removed.length)
    console.error(
      JSON.stringify({ event: "retired_config_keys", keys: retired.removed }),
    );
  const config = ConfigSchema.parse(retired.value);
  checkUrl(config.url);
  if (action === "collect") {
    const output = process.argv[3];
    if (!output) throw new Error("Usage: collect <output.json>");
    const report = await collect(config);
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      JSON.stringify({
        event: "collected",
        spaces: report.spaces.length,
        warnings: report.warnings.length,
      }),
    );
  } else if (action === "upload") {
    const report = ReportSchema.parse(
      JSON.parse(await readFile(process.argv[3], "utf8")),
    );
    if (report.machine.id !== config.machineId)
      throw new Error("Machine identity mismatch");
    console.log(
      JSON.stringify(await sendReport(config.url, config.token, report)),
    );
  } else if (action === "serve") {
    const stop = new AbortController();
    process.once("SIGTERM", () => stop.abort());
    process.once("SIGINT", () => stop.abort());
    const grants = new FileGrants(path);
    await executionWatch(
      config,
      {
        journalPath: join(dirname(path), "execution", "operations.sqlite"),
        commands: config.execution?.commands ?? false,
        workingDirectory: config.execution?.workingDirectory ?? homedir(),
        files: { grants: () => grants.list(), privateRoot: dirname(path) },
        herdr: { configPath: path },
      },
      stop.signal,
    );
  } else if (action === "realtime-watch") {
    const stop = new AbortController();
    process.once("SIGTERM", () => stop.abort());
    process.once("SIGINT", () => stop.abort());
    await realtimeWatch(config, stop.signal);
  } else if (action === "heartbeat") {
    await heartbeat(config);
    console.log("Heartbeat accepted");
  } else if (action === "once") await cycle(config);
  else if (action === "watch") {
    let running = true;
    process.on("SIGTERM", () => {
      running = false;
    });
    process.on("SIGINT", () => {
      running = false;
    });
    while (running) {
      const start = Date.now();
      try {
        await cycle(config);
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "report_failed",
            message:
              e instanceof z.ZodError
                ? "Invalid config or report schema"
                : e instanceof Error
                  ? e.message
                  : "Unknown error",
          }),
        );
      }
      if (running)
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(
              1000,
              config.intervalSeconds * 1000 - (Date.now() - start),
            ),
          ),
        );
    }
  } else
    throw new Error(
      "Commands: collect <file>, upload <file>, once, watch, realtime-watch, heartbeat, serve",
    );
}
void main().catch((e: unknown) => {
  console.error(
    e instanceof z.ZodError
      ? "Invalid config or report schema"
      : e instanceof Error
        ? e.message
        : "Agent failed",
  );
  process.exitCode = 1;
});
