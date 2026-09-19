import { z } from "zod";
import type { Evidence, Pane } from "./schema.ts";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w.:/-]+$/);
const timestamp = z.iso.datetime().transform((v) => new Date(v).toISOString());
const text = z.string().trim().min(1).max(1200);
const refs = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(30);
export const SummaryCheckSchema = z.strictObject({
  spaceId: id,
  paneId: id,
  taskId: id,
  basis: refs,
  observedAt: timestamp,
});
export const SemanticSummarySchema = z.strictObject({
  task: text,
  phase: z.enum([
    "understand",
    "implement",
    "verify",
    "deliver",
    "waiting",
    "complete",
    "unknown",
  ]),
  progress: text,
  outcomes: z
    .array(
      z.strictObject({
        kind: z.enum(["result", "test", "commit", "deployment"]),
        text,
        evidenceRefs: refs,
      }),
    )
    .max(12),
  blocker: text.nullable(),
  nextStep: text,
  rationale: text,
  evidenceRefs: refs,
});
export const SummaryUpdateSchema = SummaryCheckSchema.extend({
  summary: SemanticSummarySchema,
});
export const SummaryBatchSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    machineId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    managerId: id,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sentAt: timestamp,
    updates: z.array(SummaryUpdateSchema).max(1000),
    checks: z.array(SummaryCheckSchema).max(1000),
  })
  .refine((b) => {
    const keys = [...b.updates, ...b.checks].map(paneKey);
    return keys.length <= 1000 && new Set(keys).size === keys.length;
  }, "Duplicate or too many pane entries");
export type SummaryBatch = z.infer<typeof SummaryBatchSchema>;
export type SummaryUpdate = z.infer<typeof SummaryUpdateSchema>;
export type SummaryCheck = z.infer<typeof SummaryCheckSchema>;
export type SemanticSummary = z.infer<typeof SemanticSummarySchema>;
export type PaneSummary = SummaryUpdate & {
  hour?: string;
  contentHash?: string;
  source?: { managerId: string; protocolVersion: number };
  updatedAt: string;
  checkedAt: string;
  receivedAt: string;
  sequence: number;
  evidence: Evidence[];
};
export type ManagerState = { id: string; lastSeen: string; sequence: number };
export type SummaryHistory = {
  seq: number;
  receivedAt: string;
  value: PaneSummary;
};
export type SemanticRecord = SummaryHistory & {
  hour: string;
  contentHash: string;
  source: { managerId: string; protocolVersion: number };
};
export type SemanticHour = {
  hour: string;
  count: number;
  latest: SemanticRecord;
};
export const paneKey = (p: { spaceId: string; paneId: string }) =>
  `${encodeURIComponent(p.spaceId)}/${encodeURIComponent(p.paneId)}`;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function digest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function deterministicEvidence(evidence: Evidence[]) {
  return evidence.filter((e) =>
    /^(git:HEAD\+status$|herdr:process-info|codex:(thread-goal|final-message|turn-event|tool-event)|grok:final-message|pi:final-message)/.test(
      e.source,
    ),
  );
}
const stableEvidence = (e: Evidence) => ({
  ...e,
  observedAt: ["git", "process"].includes(e.kind) ? null : e.observedAt,
});
export async function evidenceKeys(
  evidence: Evidence[],
): Promise<Record<string, Evidence>> {
  return Object.fromEntries(
    await Promise.all(
      deterministicEvidence(evidence).map(async (e) => [
        await digest(stableEvidence(e)),
        e,
      ]),
    ),
  );
}
export function semanticContent(entry: SummaryUpdate) {
  return canonical({ taskId: entry.taskId, summary: entry.summary });
}
export const PHASE_LABEL: Record<SemanticSummary["phase"], string> = {
  understand: "梳理需求",
  implement: "实施中",
  verify: "验证中",
  deliver: "交付中",
  waiting: "等待处理",
  complete: "声称完成",
  unknown: "待判断",
};
export function summaryFreshness(
  summary: PaneSummary,
  pane: Pane,
  lastSeen: string | undefined,
  now: string,
  capturedAt = now,
  availability?: string,
) {
  if (summary.taskId !== pane.task.id) return "superseded";
  if (!lastSeen || Date.parse(now) - Date.parse(lastSeen) > 90_000)
    return "disconnected";
  if (Date.parse(now) - Date.parse(summary.checkedAt) > 300_000) return "stale";
  if (availability || Date.parse(now) - Date.parse(capturedAt) > 90_000)
    return "stale";
  const facts = (items: Evidence[]) =>
    deterministicEvidence(items)
      .filter((e) => e.taskId === pane.task.id)
      .map((e) => canonical(stableEvidence(e)))
      .sort();
  if (canonical(facts(pane.evidence)) !== canonical(facts(summary.evidence)))
    return "stale";
  return "current";
}
