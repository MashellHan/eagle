import { DurableObject } from "cloudflare:workers";
import { changesBetween } from "../shared/assessment.ts";
import type { Registration } from "../shared/connect.ts";
import type { MachineView, Report } from "../shared/schema.ts";
import { agentTokens } from "./auth.ts";

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
    const state = this.ctx.storage.kv.get<MachineView>("current");
    const config = this.ctx.storage.kv.get<Registration>("registration");
    return state ? { ...state, name: config?.name ?? state.name } : null;
  }

  registration(id: string): Registration | null {
    const stored = this.ctx.storage.kv.get<Registration>("registration");
    return (
      (stored ? { ...stored, watchPorts: stored.watchPorts ?? [] } : null) ??
      (Object.hasOwn(agentTokens(this.env), id)
        ? {
            id,
            name: this.current()?.name ?? id,
            source: "legacy",
            enabled: true,
            credentialId: null,
            createdAt: null,
            rotatedAt: null,
            expiresAt: null,
            watchPorts:
              this.current()?.report.machine.telemetry?.ports.map(
                ({ name, host, port }) => ({ name, host, port }),
              ) ?? [],
          }
        : null)
    );
  }

  configure(
    id: string,
    action: "create" | "rotate" | "rename" | "revoke",
    name?: string,
    watchPorts?: Registration["watchPorts"],
  ): Registration | null {
    const previous = this.registration(id);
    if (action === "create" ? previous !== null : previous === null)
      return null;
    const now = new Date().toISOString();
    const issue = action === "create" || action === "rotate";
    const machine: Registration = {
      id,
      watchPorts: watchPorts ?? previous?.watchPorts ?? [],
      name: name ?? previous?.name ?? id,
      source: issue ? "managed" : (previous?.source ?? "managed"),
      enabled: issue || (action !== "revoke" && !!previous?.enabled),
      credentialId: issue
        ? crypto.randomUUID()
        : (previous?.credentialId ?? null),
      createdAt: previous?.createdAt ?? now,
      rotatedAt: issue ? now : (previous?.rotatedAt ?? null),
      expiresAt: issue
        ? new Date(Date.now() + 365 * 86400_000).toISOString()
        : (previous?.expiresAt ?? null),
    };
    this.ctx.storage.kv.put("registration", machine);
    return machine;
  }

  private authorized(credentialId: string | null): boolean {
    const config = this.ctx.storage.kv.get<Registration>("registration");
    if (!config) return credentialId === null;
    return (
      config.enabled &&
      config.credentialId === credentialId &&
      (!config.expiresAt || Date.parse(config.expiresAt) > Date.now())
    );
  }

  ingest(report: Report, digest: string, credentialId: string | null = null) {
    if (!this.authorized(credentialId)) return { unauthorized: true } as const;
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

  heartbeat(warning?: string, credentialId: string | null = null) {
    if (!this.authorized(credentialId)) return { unauthorized: true } as const;
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
