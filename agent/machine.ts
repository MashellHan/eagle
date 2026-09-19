import { statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  availableParallelism,
  cpus,
  freemem,
  homedir,
  loadavg,
  platform,
  totalmem,
  uptime,
} from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  type MachineTelemetry,
  MachineTelemetrySchema,
  type PortCheck,
  WatchPortsSchema,
} from "../src/shared/schema.ts";

type CpuSample = { idle: number; total: number };
export function cpuUsage(before: CpuSample, after: CpuSample): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.round((1 - idle / total) * 1000) / 10;
}
function cpuSample(values: ReturnType<typeof cpus>): CpuSample {
  return values.reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}
async function resources(): Promise<MachineTelemetry["resources"]> {
  const processors = cpus();
  const before = cpuSample(processors);
  const started = performance.now();
  // A short fresh sample also works for one-shot collectors; no process-lifetime counters.
  await delay(250);
  const after = cpus();
  const cpuSampleMs = Math.round(performance.now() - started);
  const disk = await statfs(homedir())
    .then((fs) => ({
      totalBytes: fs.blocks * fs.bsize,
      availableBytes: fs.bavail * fs.bsize,
    }))
    .catch(() => null);
  return {
    cpuModel: processors[0]?.model || "",
    cpuCores: processors.length || availableParallelism(),
    cpuUsagePercent:
      processors.length === after.length
        ? cpuUsage(before, cpuSample(after))
        : null,
    cpuSampleMs,
    loadAverage:
      platform() === "win32" ? null : (loadavg() as [number, number, number]),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    disk,
    uptimeSeconds: Math.floor(uptime()),
  };
}
function checkPort(target: {
  name: string;
  host: PortCheck["host"];
  port: number;
}): Promise<PortCheck> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = createConnection({ host: target.host, port: target.port });
    let settled = false;
    const finish = (status: PortCheck["status"]) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ...target,
        status,
        latencyMs:
          status === "open"
            ? Math.round((performance.now() - started) * 10) / 10
            : null,
        checkedAt: new Date().toISOString(),
      });
    };
    socket.setTimeout(1000, () => finish("timeout"));
    socket.once("connect", () => finish("open"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "closed"
          : error.code === "ETIMEDOUT"
            ? "timeout"
            : "error",
      ),
    );
  });
}
export async function collectTelemetry(
  watchPorts: unknown = [],
): Promise<MachineTelemetry> {
  const targets = WatchPortsSchema.parse(watchPorts);
  const [sample, ports] = await Promise.all([
    resources().catch(() => null),
    Promise.all(targets.map(checkPort)),
  ]);
  return MachineTelemetrySchema.parse({
    observedAt: new Date().toISOString(),
    resources: sample,
    ports,
  });
}
