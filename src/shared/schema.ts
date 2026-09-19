import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w.:/-]+$/);
const text = z.string().max(2000);
const timestamp = z.iso
  .datetime({ offset: false })
  .transform((value) => new Date(value).toISOString());
export const EvidenceSchema = z.strictObject({
  kind: z.enum(["summary", "goal", "git", "test", "process", "deployment"]),
  status: z.enum(["success", "failure", "running", "waiting", "unknown"]),
  summary: text,
  source: z.string().min(1).max(240),
  observedAt: timestamp,
  taskId: id,
  revision: z.string().max(100).optional(),
});
export const PaneSchema = z.strictObject({
  id,
  title: z.string().max(240),
  agent: z.string().max(80),
  hint: z.enum(["working", "idle", "done", "blocked", "unknown"]),
  task: z.strictObject({
    id,
    title: z.string().max(500),
    requiresDeployment: z.boolean(),
  }),
  rect: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    })
    .refine(
      (r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001,
      "Pane lies outside tab",
    ),
  evidence: z.array(EvidenceSchema).max(30),
});
export const SpaceSchema = z.strictObject({
  availability: z.literal("unavailable").optional(),
  id,
  name: z.string().min(1).max(240),
  session: z.string().min(1).max(100),
  objective: z.string().max(1000),
  tabs: z
    .array(
      z.strictObject({
        id,
        name: z.string().max(240),
        panes: z.array(PaneSchema).max(100),
      }),
    )
    .max(50),
});
export const ReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reportId: id,
    capturedAt: timestamp,
    machine: z.strictObject({
      id: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9_-]*$/),
      name: z.string().min(1).max(120),
      platform: z.string().max(80),
      collectorVersion: z.string().max(80),
    }),
    spaces: z.array(SpaceSchema).max(200),
    warnings: z.array(z.string().max(500)).max(100),
  })
  .superRefine((report, ctx) => {
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    if (!unique(report.spaces.map((s) => s.id)))
      ctx.addIssue({ code: "custom", message: "Duplicate space ID" });
    let count = 0;
    for (const space of report.spaces) {
      const panes = space.tabs.flatMap((t) => t.panes);
      count += panes.length;
      if (
        !unique(space.tabs.map((t) => t.id)) ||
        !unique(panes.map((p) => p.id))
      )
        ctx.addIssue({ code: "custom", message: "Duplicate tab/pane ID" });
    }
    if (count > 1000)
      ctx.addIssue({ code: "custom", message: "Too many panes" });
  });
export const HeartbeatSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineId: id,
  sentAt: timestamp,
  warning: z.string().max(500).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Pane = z.infer<typeof PaneSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type State = "verified" | "active" | "attention" | "unverified";
export const STATE_LABEL: Record<State, string> = {
  verified: "已验证完成",
  active: "进行中",
  attention: "需关注",
  unverified: "待核实",
};
export type MachineView = {
  id: string;
  name: string;
  lastSeen: string;
  receivedAt: string;
  warning: string | null;
  report: Report;
};
export type Overview = { now: string; machines: MachineView[] };
export type HistoryEntry = {
  seq: number;
  receivedAt: string;
  report: Report;
  changes: string[];
};
