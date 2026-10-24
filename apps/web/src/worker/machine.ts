import { DurableObject } from "cloudflare:workers";
import { changesBetween } from "../../../../packages/contracts/src/assessment.ts";
import type { Registration } from "../../../../packages/contracts/src/connect.ts";
import {
  type DailyJob,
  type DailyReport,
  dailyCutoff,
  dailyStart,
  sampleHour,
} from "../../../../packages/contracts/src/daily.ts";
import {
  compactHour,
  utcHour,
} from "../../../../packages/contracts/src/report-input.ts";
import {
  MAX_RESOURCE_SAMPLES,
  RESOURCE_RETENTION_SECONDS,
  type ResourceSample,
  resourceSample,
} from "../../../../packages/contracts/src/resources.ts";
import type {
  MachineView,
  Report,
} from "../../../../packages/contracts/src/schema.ts";
import { agentTokens } from "./auth.ts";
import { LiveRelay } from "./realtime.ts";

type DailyState = DailyJob & {
  lease: string | null;
  expires: number;
  version: string;
  pending: DailyReport | null;
  completedVersion: string | null;
};

/** Current deterministic state plus short-lived daily input. */
export class MachineState extends DurableObject<Env> {
  private live = new LiveRelay(this.ctx, this.env, (id) => this.authorized(id));
  fetch(request: Request) {
    const role = request.headers.get("x-live-role");
    if (role !== "agent" && role !== "viewer")
      return new Response(null, { status: 403 });
    const expires = Number(request.headers.get("x-live-expires"));
    const credentialId = request.headers.get("x-live-credential");
    const spaceId = request.headers.get("x-live-space") ?? undefined;
    if (role === "viewer") {
      const current = this.current();
      const config = this.ctx.storage.kv.get<Registration>("registration");
      if (
        config?.enabled === false ||
        !current?.report.spaces.some((s) => s.id === spaceId && !s.availability)
      )
        return new Response(null, { status: 404 });
    }
    return this.live.connect(
      role,
      expires,
      credentialId,
      spaceId,
      request.headers.get("x-live-format") === "styled-text-v1",
    );
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    this.live.message(socket, message);
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      // Reserved local-only codes (notably abrupt-disconnect 1006) cannot be sent.
      socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    } finally {
      this.live.close(socket);
    }
  }
  webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, "Connection failed");
    } finally {
      this.live.close(socket);
    }
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS resource_samples (observed_at TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(`DROP TABLE IF EXISTS summary_receipts;
    DROP TABLE IF EXISTS summary_outbox;
    DROP TABLE IF EXISTS semantic_records;
    DROP TABLE IF EXISTS semantic_current;
    DROP TABLE IF EXISTS fact_evidence;
    DROP TABLE IF EXISTS live_tasks;`);
    ctx.storage.kv.delete("fact-keys");
    ctx.storage.kv.delete("manager");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS hourly_facts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT UNIQUE NOT NULL,
      hour TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS hourly_fact_hours ON hourly_facts(hour,seq);
    CREATE TABLE IF NOT EXISTS daily_jobs (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
    DROP TABLE IF EXISTS hourly_jobs;
    DROP TABLE IF EXISTS hourly_steps;`);
  }

  current(): MachineView | null {
    const state = this.ctx.storage.kv.get<MachineView>("current");
    const config = this.ctx.storage.kv.get<Registration>("registration");
    return state
      ? {
          ...state,
          name: config?.name ?? state.name,
        }
      : null;
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
    if (issue || action === "revoke") this.live.revoke();
    return machine;
  }

  forget(): boolean {
    const stored = this.ctx.storage.kv.get<Registration>("registration");
    if (!stored || stored.enabled) return false;
    this.ctx.storage.kv.delete("registration");
    return true;
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
      if (
        !receipt &&
        Date.parse(report.capturedAt) >= Date.now() - 48 * 3600000
      )
        sql.exec(
          "INSERT OR IGNORE INTO hourly_facts(report_id,hour,captured_at,payload) VALUES(?,?,?,?)",
          report.reportId,
          utcHour(report.capturedAt),
          report.capturedAt,
          JSON.stringify(report),
        );
      sql.exec(
        "DELETE FROM hourly_facts WHERE hour < ?",
        utcHour(Date.now() - 48 * 3600000),
      );
      const telemetry = report.machine.telemetry;
      if (
        !receipt &&
        telemetry &&
        Date.parse(telemetry.observedAt) >=
          Date.now() - RESOURCE_RETENTION_SECONDS * 1000
      )
        sql.exec(
          "INSERT OR IGNORE INTO resource_samples VALUES (?, ?)",
          telemetry.observedAt,
          JSON.stringify(resourceSample(telemetry)),
        );
      this.pruneResources();
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

  private pruneResources() {
    this.ctx.storage.sql.exec(
      "DELETE FROM resource_samples WHERE observed_at < ?",
      new Date(Date.now() - RESOURCE_RETENTION_SECONDS * 1000).toISOString(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM resource_samples WHERE observed_at IN (SELECT observed_at FROM resource_samples ORDER BY observed_at DESC LIMIT -1 OFFSET ?)",
      MAX_RESOURCE_SAMPLES,
    );
  }
  resources() {
    this.pruneResources();
    return {
      retentionSeconds: RESOURCE_RETENTION_SECONDS,
      samples: this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM resource_samples WHERE observed_at <= ? ORDER BY observed_at",
          new Date().toISOString(),
        )
        .toArray()
        .map((row) => JSON.parse(row.payload) as ResourceSample),
    };
  }

  private dailyVersion(date: string) {
    const start = dailyStart(date);
    const cutoff = dailyCutoff(date);
    const facts = this.ctx.storage.sql
      .exec<{ n: number; last: number }>(
        "SELECT count(*) n,coalesce(max(seq),0) last FROM hourly_facts WHERE captured_at>=? AND captured_at<?",
        start,
        cutoff,
      )
      .one();
    return `${facts.n}:${facts.last}`;
  }
  private dailyState(date: string): DailyState | undefined {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM daily_jobs WHERE date=?",
        date,
      )
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private saveDailyState(job: DailyState) {
    this.ctx.storage.sql.exec(
      "INSERT INTO daily_jobs VALUES(?,?) ON CONFLICT(date) DO UPDATE SET payload=excluded.payload",
      job.date,
      JSON.stringify(job),
    );
  }
  dailyJobs(): DailyJob[] {
    return this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM daily_jobs ORDER BY date DESC LIMIT 60",
      )
      .toArray()
      .map(({ payload }) => {
        const {
          lease: _lease,
          expires,
          version: _version,
          pending: _pending,
          completedVersion: _completed,
          ...job
        } = JSON.parse(payload) as DailyState;
        return job.status === "running" && expires <= Date.now()
          ? { ...job, status: "failed" as const, error: "interrupted" }
          : job;
      });
  }
  pendingDailyArchives(): string[] {
    return this.ctx.storage.sql
      .exec<{ date: string }>(
        "SELECT date FROM daily_jobs WHERE json_extract(payload,'$.pending') IS NOT NULL ORDER BY date",
      )
      .toArray()
      .map(({ date }) => date);
  }
  claimDay(date: string, manual: boolean) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.dailyState(date);
      if (previous && previous.expires > Date.now())
        return { skipped: "in_progress" } as const;
      if (previous && !manual && !previous.pending)
        return { skipped: "already_attempted" } as const;
      const version = previous?.pending
        ? previous.version
        : this.dailyVersion(date);
      if (
        !previous?.pending &&
        Date.parse(dailyStart(date)) < Date.now() - 48 * 3600000
      )
        return { skipped: "input_expired" } as const;
      if (version === "0:0") return { skipped: "no_data" } as const;
      if (previous?.completedVersion === version)
        return { skipped: "unchanged" } as const;
      const job: DailyState = {
        date,
        lease: crypto.randomUUID(),
        expires: Date.now() + 5 * 60000,
        version,
        pending: previous?.pending ?? null,
        completedVersion: previous?.completedVersion ?? null,
        status: "running",
        stage: previous?.pending ? "archive" : "input",
        attempts: (previous?.attempts ?? 0) + 1,
        error: null,
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: previous?.lastSuccessAt ?? null,
      };
      this.saveDailyState(job);
      this.ctx.storage.sql.exec(
        "DELETE FROM daily_jobs WHERE date<? AND json_extract(payload,'$.pending') IS NULL",
        new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      );
      return {
        lease: job.lease as string,
        version,
        pending: job.pending,
        dataReceivedBy: job.lastAttemptAt,
      };
    });
  }
  dayHourInput(date: string, hour: number, lease: string) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now())
      throw new Error("Daily lease unavailable");
    const [, factSeq] = job.version.split(":").map(Number);
    const start = new Date(
      Date.parse(dailyStart(date)) + hour * 3600000,
    ).toISOString();
    const end =
      hour === 23
        ? dailyCutoff(date)
        : new Date(Date.parse(start) + 3600000).toISOString();
    const rows = this.ctx.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM hourly_facts WHERE hour=? AND captured_at<? AND seq<=? ORDER BY captured_at,seq",
      start,
      end,
      factSeq,
    );
    function* reports() {
      for (const row of rows) yield JSON.parse(row.payload) as Report;
    }
    const input = compactHour(reports());
    const sampled = sampleHour(input.records, hour);
    return {
      hour,
      records: sampled.records,
      coverage: {
        hour,
        snapshots: input.snapshots,
        inputRecords: input.records.length,
        retainedRecords: sampled.records.length,
        omittedRecords: sampled.omittedRecords,
        excerptedRecords: sampled.excerptedRecords,
        firstObservedAt: input.firstObservedAt,
        lastObservedAt: input.lastObservedAt,
      },
    };
  }
  dailyStage(date: string, lease: string, stage: string) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now()) return false;
    job.stage = stage;
    this.saveDailyState(job);
    return true;
  }
  cacheDay(date: string, lease: string, result: DailyReport) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now())
      return "lease_lost" as const;
    job.pending = result;
    job.stage = "archive";
    this.saveDailyState(job);
    return null;
  }
  finishDay(date: string, lease: string, error: string | null = null) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now()) return false;
    if (!error && !job.pending) return false;
    job.status = error ? "failed" : "complete";
    job.error = error;
    job.expires = 0;
    job.lease = null;
    if (!error) {
      job.completedVersion = job.version;
      job.lastSuccessAt = new Date().toISOString();
      job.pending = null;
      job.stage = "complete";
    }
    this.saveDailyState(job);
    return true;
  }

  async alarm() {
    this.live.sweep();
    await this.live.schedule();
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
