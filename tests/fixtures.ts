import type { Evidence, Report } from "../src/shared/schema.ts";
export const NOW = "2026-09-19T05:50:00.000Z";
export function telemetry(observedAt = NOW) {
  return {
    observedAt,
    resources: {
      cpuModel: "Test CPU",
      cpuCores: 8,
      cpuUsagePercent: 25,
      cpuSampleMs: 250,
      loadAverage: [1, 2, 3],
      memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 },
      disk: { totalBytes: 500 * 1024 ** 3, availableBytes: 200 * 1024 ** 3 },
      uptimeSeconds: 90000,
    },
    ports: [
      {
        name: "Raven",
        host: "127.0.0.1",
        port: 7024,
        status: "open",
        latencyMs: 2.5,
        checkedAt: observedAt,
      },
    ],
  };
}
export function report(id = "report-1", capturedAt = NOW): Report {
  return {
    schemaVersion: 1,
    reportId: id,
    capturedAt,
    machine: {
      id: "mac-one",
      name: "Mac One",
      platform: "darwin",
      collectorVersion: "0.1.0",
    },
    spaces: [
      {
        id: "default:w1",
        name: "Eagle",
        session: "default",
        objective: "Ship Eagle",
        tabs: [
          {
            id: "w1:t1",
            name: "Build",
            panes: [
              {
                id: "w1:p1",
                title: "Eagle",
                agent: "codex",
                hint: "done",
                task: {
                  id: "task-1",
                  title: "Ship Eagle",
                  requiresDeployment: true,
                },
                rect: { x: 0, y: 0, width: 1, height: 1 },
                evidence: [],
              },
            ],
          },
        ],
      },
    ],
    warnings: [],
  };
}
export function evidence(
  kind: Evidence["kind"],
  status: Evidence["status"],
  extra: Partial<Evidence> = {},
): Evidence {
  return {
    kind,
    status,
    summary: `${kind}: ${status}`,
    source: "test fixture",
    observedAt: NOW,
    taskId: "task-1",
    ...extra,
  };
}
