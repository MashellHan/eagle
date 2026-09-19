import type { Evidence, Report } from "../src/shared/schema.ts";
export const NOW = "2026-09-19T05:50:00.000Z";
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
