import { DurableObject } from "cloudflare:workers";
import { changesBetween } from "../shared/assessment.ts";
import type { MachineView, Report } from "../shared/schema.ts";

/** One named object per configured machine. No historical report payloads. */
export class MachineState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL
    )`);
  }

  current(): MachineView | null {
    return this.ctx.storage.kv.get<MachineView>("current") ?? null;
  }

  ingest(report: Report, digest: string) {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const previous = this.current();
      const now = new Date().toISOString();
      const receipt = sql
        .exec<{ seq: number; digest: string }>(
          "SELECT seq, digest FROM receipts WHERE report_id = ?",
          report.reportId,
        )
        .toArray()[0];
      if (receipt && receipt.digest !== digest)
        return { conflict: true } as const;
      const seq =
        receipt?.seq ??
        sql
          .exec<{ seq: number }>(
            "INSERT INTO receipts(report_id, digest) VALUES(?, ?) RETURNING seq",
            report.reportId,
            digest,
          )
          .one().seq;
      const newer =
        !previous ||
        report.capturedAt > previous.report.capturedAt ||
        (report.capturedAt === previous.report.capturedAt &&
          report.reportId > previous.report.reportId);
      const changes = newer
        ? changesBetween(previous?.report ?? null, report)
        : [];
      const current: MachineView = newer
        ? {
            id: report.machine.id,
            name: report.machine.name,
            report,
            receivedAt: now,
            lastSeen: now,
            warning: null,
            revision: (previous?.revision ?? 0) + 1,
            changes: changes.length ? changes : (previous?.changes ?? []),
            changedAt: changes.length
              ? report.capturedAt
              : (previous?.changedAt ?? null),
          }
        : { ...previous, lastSeen: now, revision: previous.revision + 1 };
      this.ctx.storage.kv.put("current", current);
      return { accepted: true, duplicate: !!receipt, seq } as const;
    });
  }

  heartbeat(warning?: string) {
    const current = this.current();
    if (!current) return false;
    this.ctx.storage.kv.put("current", {
      ...current,
      lastSeen: new Date().toISOString(),
      warning: warning ?? current.warning,
      revision: current.revision + 1,
    });
    return true;
  }
}
