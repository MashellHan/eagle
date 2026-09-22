import { DurableObject } from "cloudflare:workers";
import { changesBetween } from "../shared/assessment.ts";
import type { Registration } from "../shared/connect.ts";
import {
  compactHour,
  type HourlyContent,
  type HourlyJob,
  type HourlyReport,
  TEMPLATE_VERSION,
  utcHour,
  validHour,
} from "../shared/hourly.ts";
import type { MachineView, Report } from "../shared/schema.ts";
import {
  canonical,
  type ManagerState,
  type PaneSummary,
  paneKey,
  type SummaryBatch,
  semanticContent,
  taskKey,
} from "../shared/summaries.ts";
import { agentTokens } from "./auth.ts";
import { LiveRelay, scheduleEarlier } from "./realtime.ts";

type Facts = Record<string, import("../shared/schema.ts").Evidence>;
type HourWork = Omit<HourlyJob, "hour" | "status"> & {
  version: string;
  fingerprint: string | null;
  failures: number;
  blocked: boolean;
};
type HourLease = {
  version: string;
  lease: string | null;
  expires: number;
  pending: string | null;
  completed_version: string | null;
};
type SemanticRow = {
  seq: number;
  hour: string;
  content_hash: string;
  source: string;
  received_at: string;
  payload: string;
};
const sameHourInput = (a: string | null | undefined, b: string) =>
  a?.slice(a.indexOf(":") + 1) === b.slice(b.indexOf(":") + 1);
const RETENTION_DAYS = 30;
const MAX_RECORDS = 10000;
const unpack = (row: SemanticRow) => ({
  seq: row.seq,
  hour: row.hour,
  contentHash: row.content_hash,
  source: JSON.parse(row.source),
  receivedAt: row.received_at,
  value: JSON.parse(row.payload) as PaneSummary,
});

/** Current state plus separate semantic and short-lived hourly input streams. */
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
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS summary_receipts (sequence INTEGER PRIMARY KEY, digest TEXT NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS summary_outbox (event_id TEXT PRIMARY KEY, machine_id TEXT, space_id TEXT, pane_id TEXT, task_id TEXT, received_at TEXT, payload TEXT)`,
    );
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS semantic_records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
      hour TEXT NOT NULL, space_id TEXT NOT NULL, pane_id TEXT NOT NULL, task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS semantic_hours ON semantic_records(hour DESC,seq DESC);
    CREATE INDEX IF NOT EXISTS semantic_pane_hours ON semantic_records(space_id,pane_id,hour DESC,observed_at DESC,seq DESC);
    CREATE TABLE IF NOT EXISTS semantic_current (space_id TEXT,pane_id TEXT,task_id TEXT,observed_at TEXT,received_at TEXT,payload TEXT,PRIMARY KEY(space_id,pane_id,task_id));
    CREATE TABLE IF NOT EXISTS fact_evidence (pane_key TEXT,hash TEXT,task_id TEXT,received_at TEXT,payload TEXT,PRIMARY KEY(pane_key,hash));
    CREATE INDEX IF NOT EXISTS fact_retention ON fact_evidence(received_at);
    CREATE INDEX IF NOT EXISTS semantic_retention ON semantic_records(received_at);`);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS live_tasks(space_id TEXT,pane_id TEXT,task_id TEXT,PRIMARY KEY(space_id,pane_id))",
    );
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS hourly_facts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT UNIQUE NOT NULL,
      hour TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS hourly_fact_hours ON hourly_facts(hour,seq);
    CREATE TABLE IF NOT EXISTS hourly_jobs (
      hour TEXT PRIMARY KEY, version TEXT, lease TEXT, expires INTEGER,
      pending TEXT, completed_version TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS hourly_steps (
      hour TEXT NOT NULL, step TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(hour,step)
    );`);
  }

  current(): MachineView | null {
    const state = this.ctx.storage.kv.get<MachineView>("current");
    const config = this.ctx.storage.kv.get<Registration>("registration");
    return state
      ? {
          ...state,
          name: config?.name ?? state.name,
          summaries: state.report.spaces.flatMap((space) =>
            space.tabs.flatMap((tab) =>
              tab.panes.flatMap((pane) => {
                const row = this.ctx.storage.sql
                  .exec<{ payload: string }>(
                    "SELECT payload FROM semantic_current WHERE space_id=? AND pane_id=? ORDER BY (task_id=?) DESC,observed_at DESC LIMIT 1",
                    space.id,
                    pane.id,
                    pane.task.id,
                  )
                  .toArray()[0];
                return row ? [JSON.parse(row.payload) as PaneSummary] : [];
              }),
            ),
          ),
          manager: this.ctx.storage.kv.get<ManagerState>("manager") ?? null,
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

  private authorized(credentialId: string | null): boolean {
    const config = this.ctx.storage.kv.get<Registration>("registration");
    if (!config) return credentialId === null;
    return (
      config.enabled &&
      config.credentialId === credentialId &&
      (!config.expiresAt || Date.parse(config.expiresAt) > Date.now())
    );
  }

  ingest(
    report: Report,
    digest: string,
    credentialId: string | null = null,
    factKeys: Record<
      string,
      Record<string, import("../shared/schema.ts").Evidence>
    > = {},
  ) {
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
      if (newer) {
        this.ctx.storage.kv.put("fact-keys", factKeys);
        this.ctx.storage.sql.exec("DELETE FROM live_tasks");
        for (const space of report.spaces.filter((s) => !s.availability))
          for (const pane of space.tabs.flatMap((t) => t.panes))
            this.ctx.storage.sql.exec(
              "INSERT INTO live_tasks VALUES(?,?,?)",
              space.id,
              pane.id,
              pane.task.id,
            );
        for (const [key, records] of Object.entries(factKeys))
          for (const [hash, evidence] of Object.entries(records))
            this.ctx.storage.sql.exec(
              "INSERT INTO fact_evidence VALUES(?,?,?,?,?) ON CONFLICT(pane_key,hash) DO UPDATE SET received_at=excluded.received_at,payload=excluded.payload",
              key,
              hash,
              evidence.taskId,
              now,
              JSON.stringify(evidence),
            );
        this.prune(now);
      }
      const { summaries: _summaries, manager: _manager, ...facts } = current;
      this.ctx.storage.kv.put("current", facts);
      return { accepted: true, duplicate: !!receipt, seq } as const;
    });
  }

  agentCurrent(credentialId: string | null) {
    return this.authorized(credentialId)
      ? this.current()
      : { unauthorized: true };
  }

  private hourVersion(hour: string) {
    const facts = this.ctx.storage.sql
      .exec<{ n: number; last: number }>(
        "SELECT count(*) n,coalesce(max(seq),0) last FROM hourly_facts WHERE hour=?",
        hour,
      )
      .one();
    const semantics = this.ctx.storage.sql
      .exec<{ n: number; last: number }>(
        "SELECT count(*) n,coalesce(max(seq),0) last FROM semantic_records WHERE hour=?",
        hour,
      )
      .one();
    return `${TEMPLATE_VERSION}:${facts.n}:${facts.last}:${semantics.n}:${semantics.last}`;
  }
  private hourWork(hour: string): HourWork | undefined {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM hourly_steps WHERE hour=? AND step='state'",
        hour,
      )
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private storeHourWork(hour: string, work: HourWork) {
    this.ctx.storage.sql.exec(
      "INSERT INTO hourly_steps VALUES(?,'state',?) ON CONFLICT(hour,step) DO UPDATE SET payload=excluded.payload",
      hour,
      JSON.stringify(work),
    );
  }
  private hourLease(hour: string) {
    return this.ctx.storage.sql
      .exec<HourLease>("SELECT * FROM hourly_jobs WHERE hour=?", hour)
      .toArray()[0];
  }
  private checkHourLease(hour: string, lease: string) {
    const job = this.hourLease(hour);
    if (!job || job.lease !== lease || job.expires <= Date.now())
      return "lease_lost" as const;
    if (job.version !== this.hourVersion(hour)) return "input_changed" as const;
    return null;
  }
  private hourDiscarded(hour: string) {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM hourly_steps WHERE hour=? AND step='discarded'",
          hour,
        )
        .toArray().length > 0
    );
  }
  discardHour(hour: string) {
    if (!validHour(hour) || Date.parse(hour) + 3600000 > Date.now() - 300000)
      throw new Error("Expected a closed UTC hour");
    return this.ctx.storage.transactionSync(() => {
      const job = this.hourLease(hour);
      if (job?.pending || job?.completed_version)
        return { hour, skipped: "has_report" } as const;
      if (this.hourVersion(hour) === `${TEMPLATE_VERSION}:0:0:0:0`)
        return { hour, skipped: "no_data" } as const;
      this.ctx.storage.sql.exec("DELETE FROM hourly_jobs WHERE hour=?", hour);
      this.ctx.storage.sql.exec("DELETE FROM hourly_steps WHERE hour=?", hour);
      this.ctx.storage.sql.exec(
        "INSERT INTO hourly_steps VALUES(?,'discarded',?)",
        hour,
        JSON.stringify({ discardedAt: new Date().toISOString() }),
      );
      return { hour, discarded: true } as const;
    });
  }
  hourJobs(at: number, before = utcHour(at - 300000)): HourlyJob[] {
    const cutoff = utcHour(at - 48 * 3600000);
    return this.ctx.storage.sql
      .exec<{ hour: string }>(
        `SELECT hour FROM hourly_facts WHERE hour>=? AND hour<? UNION SELECT hour FROM semantic_records WHERE hour>=? AND hour<? UNION SELECT hour FROM hourly_jobs WHERE pending IS NOT NULL ORDER BY hour`,
        cutoff,
        before,
        cutoff,
        before,
      )
      .toArray()
      .map(({ hour }) => {
        const job = this.hourLease(hour);
        const version =
          job?.pending && hour < cutoff ? job.version : this.hourVersion(hour);
        const saved = this.hourWork(hour);
        const work = saved?.version === version ? saved : undefined;
        return {
          hour,
          status: this.hourDiscarded(hour)
            ? "discarded"
            : job && job.expires > at
              ? "running"
              : sameHourInput(job?.completed_version, version)
                ? "complete"
                : work?.blocked
                  ? "blocked"
                  : work?.error
                    ? "retrying"
                    : "pending",
          attempts: work?.attempts ?? 0,
          completedParts: work?.completedParts ?? 0,
          totalParts: work?.totalParts ?? 0,
          stage: work?.stage ?? "input",
          error: work?.error ?? null,
          lastAttemptAt: work?.lastAttemptAt ?? 0,
          retryAt: work?.retryAt ?? 0,
          lastSuccessAt: saved?.lastSuccessAt ?? null,
        };
      });
  }
  pendingHours(at: number, before = utcHour(at - 300000)): string[] {
    const cutoff = utcHour(at - 48 * 3600000);
    this.ctx.storage.sql.exec(
      "DELETE FROM hourly_facts WHERE hour < ?",
      cutoff,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM hourly_jobs WHERE hour < ? AND pending IS NULL",
      cutoff,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM hourly_steps WHERE hour < ? AND hour NOT IN (SELECT hour FROM hourly_jobs WHERE pending IS NOT NULL)",
      cutoff,
    );
    return this.hourJobs(at, before)
      .filter(
        (job) =>
          (job.status === "pending" || job.status === "retrying") &&
          job.retryAt <= at,
      )
      .sort(
        (a, b) =>
          a.lastAttemptAt - b.lastAttemptAt || b.hour.localeCompare(a.hour),
      )
      .map((job) => job.hour);
  }
  claimHour(hour: string, force = false) {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (this.hourDiscarded(hour)) return { skipped: "discarded" } as const;
      const previous = this.hourLease(hour);
      if (previous?.expires > Date.now())
        return { skipped: "in_progress" } as const;
      const expiredPending =
        previous?.pending && hour < utcHour(Date.now() - 48 * 3600000);
      const version = expiredPending
        ? previous.version
        : this.hourVersion(hour);
      if (version === `${TEMPLATE_VERSION}:0:0:0:0`)
        return { skipped: "no_data" } as const;
      if (sameHourInput(previous?.completed_version, version))
        return { skipped: "unchanged" } as const;
      const saved = this.hourWork(hour);
      const work = saved?.version === version ? saved : undefined;
      if (!force && work?.blocked) return { skipped: "blocked" } as const;
      if (!force && work && work.retryAt > Date.now())
        return { skipped: "backoff" } as const;
      const lease = crypto.randomUUID();
      sql.exec(
        `INSERT INTO hourly_jobs(hour,version,lease,expires) VALUES(?,?,?,?) ON CONFLICT(hour) DO UPDATE SET pending=CASE WHEN hourly_jobs.version=excluded.version THEN hourly_jobs.pending ELSE NULL END,version=excluded.version,lease=excluded.lease,expires=excluded.expires,last_error=NULL`,
        hour,
        version,
        lease,
        Date.now() + 5 * 60000,
      );
      if (!work) sql.exec("DELETE FROM hourly_steps WHERE hour=?", hour);
      this.storeHourWork(hour, {
        version,
        fingerprint: work?.fingerprint ?? null,
        attempts: (work?.attempts ?? 0) + 1,
        failures: work?.failures ?? 0,
        lastAttemptAt: Date.now(),
        retryAt: 0,
        stage: previous?.pending ? "archive" : "input",
        error: null,
        blocked: false,
        completedParts: work?.completedParts ?? 0,
        totalParts: work?.totalParts ?? 0,
        lastSuccessAt: saved?.lastSuccessAt ?? null,
      });
      const pending =
        previous?.pending && previous.version === version
          ? (JSON.parse(previous.pending) as HourlyReport)
          : null;
      return { lease, version, pending };
    });
  }
  hourInput(hour: string) {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<{ payload: string }>(
      "SELECT payload FROM hourly_facts WHERE hour=? ORDER BY captured_at,seq",
      hour,
    );
    function* reports() {
      for (const row of rows) yield JSON.parse(row.payload) as Report;
    }
    const semantic = sql
      .exec<SemanticRow>(
        "SELECT * FROM semantic_records WHERE hour=? ORDER BY observed_at,seq",
        hour,
      )
      .toArray()
      .map(unpack);
    return {
      ...compactHour(reports(), semantic),
      machineName: this.current()?.name ?? "",
      version: this.hourVersion(hour),
    };
  }
  prepareHour(
    hour: string,
    lease: string,
    fingerprint: string,
    totalParts: number,
  ) {
    return this.ctx.storage.transactionSync(() => {
      const skipped = this.checkHourLease(hour, lease);
      if (skipped) return { skipped };
      const work = this.hourWork(hour);
      if (!work) return { skipped: "lease_lost" } as const;
      if (work.fingerprint !== fingerprint) {
        this.ctx.storage.sql.exec(
          "DELETE FROM hourly_steps WHERE hour=? AND step<>'state'",
          hour,
        );
        work.completedParts = 0;
        work.fingerprint = fingerprint;
      }
      work.totalParts = totalParts;
      this.storeHourWork(hour, work);
      return { ready: true } as const;
    });
  }
  hourPart(hour: string, lease: string, step: string, stage: string) {
    const skipped = this.checkHourLease(hour, lease);
    if (skipped) return { skipped };
    const work = this.hourWork(hour);
    if (!work) return { skipped: "lease_lost" } as const;
    work.stage = stage;
    this.storeHourWork(hour, work);
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM hourly_steps WHERE hour=? AND step=?",
        hour,
        step,
      )
      .toArray()[0];
    return { content: row ? (JSON.parse(row.payload) as HourlyContent) : null };
  }
  saveHourPart(
    hour: string,
    lease: string,
    step: string,
    content: HourlyContent,
  ) {
    return this.ctx.storage.transactionSync(() => {
      const skipped = this.checkHourLease(hour, lease);
      if (skipped) return { skipped };
      const work = this.hourWork(hour);
      if (!work) return { skipped: "lease_lost" } as const;
      const inserted = this.ctx.storage.sql
        .exec(
          "INSERT OR IGNORE INTO hourly_steps VALUES(?,?,?) RETURNING step",
          hour,
          step,
          JSON.stringify(content),
        )
        .toArray().length;
      if (step.startsWith("chunk:")) work.completedParts += inserted;
      work.failures = 0;
      this.storeHourWork(hour, work);
      return { saved: true } as const;
    });
  }
  cacheHour(hour: string, lease: string, result: HourlyReport) {
    if (this.checkHourLease(hour, lease)) return false;
    return (
      this.ctx.storage.sql
        .exec(
          "UPDATE hourly_jobs SET pending=? WHERE hour=? AND lease=? RETURNING hour",
          JSON.stringify(result),
          hour,
          lease,
        )
        .toArray().length === 1
    );
  }
  finishHour(
    hour: string,
    lease: string,
    outcome: {
      status: "complete" | "deferred" | "failed";
      stage: string;
      error?: string;
      blocked?: boolean;
    },
  ) {
    return this.ctx.storage.transactionSync(() => {
      const job = this.hourLease(hour);
      if (!job || job.lease !== lease || job.expires <= Date.now())
        return false;
      if (outcome.status === "complete" && !job.pending) return false;
      const complete = outcome.status === "complete";
      this.ctx.storage.sql.exec(
        `UPDATE hourly_jobs SET expires=0,lease=NULL,last_error=?,completed_version=CASE WHEN ? THEN version ELSE completed_version END,pending=CASE WHEN ? THEN NULL ELSE pending END WHERE hour=? AND lease=?`,
        outcome.error ?? null,
        complete ? 1 : 0,
        complete ? 1 : 0,
        hour,
        lease,
      );
      const work = this.hourWork(hour);
      if (work) {
        work.stage = outcome.stage;
        work.error = outcome.error ?? null;
        work.blocked = outcome.blocked ?? false;
        work.failures = outcome.status === "failed" ? work.failures + 1 : 0;
        work.retryAt =
          outcome.status === "failed"
            ? Date.now() +
              Math.min(3600000, 60000 * 2 ** Math.min(work.failures - 1, 6))
            : 0;
        if (complete) {
          work.lastSuccessAt = new Date().toISOString();
          this.ctx.storage.sql.exec(
            "DELETE FROM hourly_steps WHERE hour=? AND step<>'state'",
            hour,
          );
        }
        this.storeHourWork(hour, work);
      }
      return true;
    });
  }

  private latest(
    spaceId: string,
    paneId: string,
    taskId: string,
  ): PaneSummary | undefined {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM semantic_current WHERE space_id=? AND pane_id=? AND task_id=?",
        spaceId,
        paneId,
        taskId,
      )
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private storeLatest(value: PaneSummary) {
    this.ctx.storage.sql.exec(
      `INSERT INTO semantic_current VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,pane_id,task_id) DO UPDATE SET observed_at=excluded.observed_at,received_at=excluded.received_at,payload=excluded.payload WHERE excluded.observed_at>=semantic_current.observed_at AND json_extract(excluded.payload,'$.checkedAt')>=json_extract(semantic_current.payload,'$.checkedAt')`,
      value.spaceId,
      value.paneId,
      value.taskId,
      value.observedAt,
      value.receivedAt,
      JSON.stringify(value),
    );
  }
  private prune(now: string) {
    const cutoff = new Date(
      Date.parse(now) - RETENTION_DAYS * 86400000,
    ).toISOString();
    const sql = this.ctx.storage.sql;
    sql.exec(
      "DELETE FROM semantic_records WHERE (received_at < ? OR seq IN (SELECT seq FROM semantic_records ORDER BY seq DESC LIMIT -1 OFFSET ?)) AND event_id NOT IN (SELECT event_id FROM summary_outbox)",
      cutoff,
      MAX_RECORDS,
    );
    sql.exec(
      "DELETE FROM semantic_current WHERE (received_at < ? OR rowid IN (SELECT rowid FROM semantic_current ORDER BY received_at DESC LIMIT -1 OFFSET ?)) AND NOT EXISTS(SELECT 1 FROM live_tasks WHERE live_tasks.space_id=semantic_current.space_id AND live_tasks.pane_id=semantic_current.pane_id AND live_tasks.task_id=semantic_current.task_id)",
      cutoff,
      MAX_RECORDS,
    );
    sql.exec(
      "DELETE FROM fact_evidence WHERE received_at < ? OR rowid IN (SELECT rowid FROM fact_evidence ORDER BY received_at DESC LIMIT -1 OFFSET 50000)",
      cutoff,
    );
  }
  semanticHours(query: {
    spaceId?: string;
    paneId?: string;
    hour?: string;
    mode: "all" | "latest";
    limit: number;
    before?: string;
  }) {
    this.prune(new Date().toISOString());
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (query.spaceId) {
      clauses.push("space_id=?");
      args.push(query.spaceId);
    }
    if (query.paneId) {
      clauses.push("pane_id=?");
      args.push(query.paneId);
    }
    if (query.hour) {
      clauses.push("hour=?");
      args.push(query.hour);
    }
    const where = () =>
      clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const retention = {
      days: RETENTION_DAYS,
      maxRecords: MAX_RECORDS,
      timezone: "UTC",
    };
    if (query.hour) {
      if (query.before) {
        clauses.push("seq<?");
        args.push(Number(query.before));
      }
      const rows = this.ctx.storage.sql
        .exec<SemanticRow>(
          "SELECT * FROM semantic_records" +
            where() +
            (query.mode === "latest"
              ? " ORDER BY observed_at DESC,seq DESC LIMIT 1"
              : " ORDER BY seq DESC LIMIT ?"),
          ...args,
          ...(query.mode === "all" ? [query.limit + 1] : []),
        )
        .toArray();
      const more = rows.length > query.limit;
      return {
        entries: rows.slice(0, query.limit).map(unpack),
        nextCursor: more ? rows[query.limit - 1].seq : null,
        retention,
      };
    }
    if (query.before) {
      clauses.push("hour<?");
      args.push(query.before);
    }
    const groups = this.ctx.storage.sql
      .exec<{ hour: string; count: number }>(
        "SELECT hour,count(*) AS count FROM semantic_records" +
          where() +
          " GROUP BY hour ORDER BY hour DESC LIMIT ?",
        ...args,
        query.limit + 1,
      )
      .toArray();
    return {
      hours: groups.slice(0, query.limit).map((group) => ({
        hour: group.hour,
        count: group.count,
        latest: unpack(
          this.ctx.storage.sql
            .exec<SemanticRow>(
              "SELECT * FROM semantic_records" +
                where() +
                (clauses.length ? " AND" : " WHERE") +
                " hour=? ORDER BY observed_at DESC,seq DESC LIMIT 1",
              ...args,
              group.hour,
            )
            .one(),
        ),
      })),
      nextCursor:
        groups.length > query.limit ? groups[query.limit - 1].hour : null,
      retention,
    };
  }
  async summarize(
    batch: SummaryBatch,
    hash: string,
    credentialId: string | null,
    contentHashes: Record<string, string>,
  ) {
    await scheduleEarlier(this.ctx, Date.now() + 1000);
    const result = this.ctx.storage.transactionSync(() => {
      if (!this.authorized(credentialId))
        return { error: "unauthorized" } as const;
      const storage = this.ctx.storage;
      const sql = storage.sql;
      const manager = storage.kv.get<ManagerState>("manager");
      if (manager && manager.id !== batch.managerId)
        return { error: "writer_conflict" } as const;
      const receipt = sql
        .exec<{ digest: string }>(
          "SELECT digest FROM summary_receipts WHERE sequence=?",
          batch.sequence,
        )
        .toArray()[0];
      if (receipt)
        return receipt.digest === hash
          ? ({
              accepted: true,
              duplicate: true,
              sequence: batch.sequence,
            } as const)
          : ({ error: "sequence_conflict" } as const);
      if (manager && batch.sequence <= manager.sequence)
        return { error: "stale_sequence" } as const;
      const current = storage.kv.get<MachineView>("current");
      const facts = storage.kv.get<Record<string, Facts>>("fact-keys") ?? {};
      const accepted: Record<string, Facts> = {};
      const now = new Date().toISOString();
      for (const entry of batch.updates) {
        if (
          Date.parse(entry.observedAt) > Date.parse(now) + 30000 ||
          Date.parse(entry.observedAt) <
            Date.parse(now) - RETENTION_DAYS * 86400000
        )
          return {
            error: "observation_outside_retention",
            entry: taskKey(entry),
          } as const;
        const key = paneKey(entry);
        const known: Facts = {};
        for (const ref of entry.basis) {
          const record = sql
            .exec<{ payload: string }>(
              "SELECT payload FROM fact_evidence WHERE pane_key=? AND hash=? AND task_id=?",
              key,
              ref,
              entry.taskId,
            )
            .toArray()[0];
          if (!record)
            return { error: "basis_changed", entry: taskKey(entry) } as const;
          known[ref] = JSON.parse(record.payload);
        }
        if (
          [
            ...entry.summary.evidenceRefs,
            ...entry.summary.outcomes.flatMap((o) => o.evidenceRefs),
          ].some((ref) => !Object.hasOwn(known, ref))
        )
          return { error: "unknown_evidence", entry: taskKey(entry) } as const;
        accepted[taskKey(entry)] = known;
      }
      for (const entry of batch.checks) {
        const space = current?.report.spaces.find(
          (s) => s.id === entry.spaceId && !s.availability,
        );
        const pane = space?.tabs
          .flatMap((t) => t.panes)
          .find((p) => p.id === entry.paneId);
        const previous = this.latest(entry.spaceId, entry.paneId, entry.taskId);
        if (
          !current ||
          Date.parse(now) - Date.parse(current.report.capturedAt) > 90000 ||
          !pane ||
          pane.task.id !== entry.taskId ||
          canonical(Object.keys(facts[paneKey(entry)] ?? {}).sort()) !==
            canonical([...entry.basis].sort())
        )
          return { error: "basis_changed", entry: taskKey(entry) } as const;
        if (
          !previous ||
          canonical([...previous.basis].sort()) !==
            canonical([...entry.basis].sort())
        )
          return { error: "summary_required", entry: taskKey(entry) } as const;
        if (
          Date.parse(now) - Date.parse(entry.observedAt) > 300000 ||
          Date.parse(entry.observedAt) > Date.parse(now) + 30000 ||
          entry.observedAt < previous.checkedAt
        )
          return { error: "stale_observation", entry: taskKey(entry) } as const;
      }
      if (
        sql.exec<{ n: number }>("SELECT count(*) n FROM summary_outbox").one()
          .n +
          batch.updates.length >
        1000
      )
        return { error: "archive_backpressure" } as const;
      for (const entry of batch.updates) {
        const key = taskKey(entry);
        const previous = this.latest(entry.spaceId, entry.paneId, entry.taskId);
        const changed =
          !previous || semanticContent(previous) !== semanticContent(entry);
        const source = {
          managerId: batch.managerId,
          protocolVersion: batch.protocolVersion,
        };
        const hour = `${entry.observedAt.slice(0, 13)}:00:00.000Z`;
        const value: PaneSummary = {
          ...entry,
          updatedAt: changed ? entry.observedAt : previous.updatedAt,
          checkedAt: entry.observedAt,
          receivedAt: now,
          sequence: batch.sequence,
          evidence: Object.values(accepted[key]),
          hour,
          contentHash: contentHashes[key],
          source,
        };
        this.storeLatest(value);
        if (changed) {
          const eventId = `${batch.machineId}:${batch.managerId}:${batch.sequence}:${key}`;
          sql.exec(
            "INSERT INTO semantic_records(event_id,hour,space_id,pane_id,task_id,sequence,observed_at,received_at,content_hash,source,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            eventId,
            hour,
            entry.spaceId,
            entry.paneId,
            entry.taskId,
            batch.sequence,
            entry.observedAt,
            now,
            contentHashes[key],
            JSON.stringify(source),
            JSON.stringify(value),
          );
          sql.exec(
            "INSERT INTO summary_outbox VALUES(?,?,?,?,?,?,?)",
            eventId,
            batch.machineId,
            entry.spaceId,
            entry.paneId,
            entry.taskId,
            now,
            JSON.stringify(value),
          );
        }
      }
      for (const entry of batch.checks) {
        const previous = this.latest(entry.spaceId, entry.paneId, entry.taskId);
        if (previous)
          this.storeLatest({ ...previous, checkedAt: entry.observedAt });
      }
      storage.kv.put("manager", {
        id: batch.managerId,
        sequence: batch.sequence,
        lastSeen: now,
      });
      sql.exec(
        "INSERT INTO summary_receipts VALUES(?,?)",
        batch.sequence,
        hash,
      );
      sql.exec(
        "DELETE FROM summary_receipts WHERE sequence<?",
        batch.sequence - 128,
      );
      this.prune(now);
      return {
        accepted: true,
        duplicate: false,
        sequence: batch.sequence,
      } as const;
    });
    if ("error" in result) return result;
    try {
      await this.flushSummaries();
    } catch {
      /* Persistent outbox retries independently. */
    }
    return {
      ...result,
      archivePending: this.ctx.storage.sql
        .exec<{ n: number }>("SELECT count(*) n FROM summary_outbox")
        .one().n,
    };
  }

  private async flushSummaries() {
    const rows = this.ctx.storage.sql
      .exec<{
        event_id: string;
        machine_id: string;
        space_id: string;
        pane_id: string;
        task_id: string;
        received_at: string;
        payload: string;
      }>("SELECT * FROM summary_outbox ORDER BY received_at, event_id LIMIT 20")
      .toArray();
    if (!rows.length) return;
    await this.env.DB.batch(
      rows.map((r) =>
        this.env.DB.prepare(
          "INSERT OR IGNORE INTO pane_summaries(event_id,machine_id,space_id,pane_id,task_id,received_at,payload) VALUES (?,?,?,?,?,?,?)",
        ).bind(
          r.event_id,
          r.machine_id,
          r.space_id,
          r.pane_id,
          r.task_id,
          r.received_at,
          r.payload,
        ),
      ),
    );
    this.ctx.storage.transactionSync(() => {
      for (const row of rows)
        this.ctx.storage.sql.exec(
          "DELETE FROM summary_outbox WHERE event_id = ?",
          row.event_id,
        );
    });
  }

  async alarm() {
    this.live.sweep();
    try {
      await this.flushSummaries();
    } finally {
      if (
        this.ctx.storage.sql
          .exec<{ n: number }>("SELECT count(*) n FROM summary_outbox")
          .one().n
      )
        await scheduleEarlier(this.ctx, Date.now() + 30000);
      await this.live.schedule();
    }
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
