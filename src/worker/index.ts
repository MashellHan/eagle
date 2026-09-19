import { version } from "../../package.json";
import { changesBetween } from "../shared/assessment.ts";
import {
  HeartbeatSchema,
  type Report,
  ReportSchema,
} from "../shared/schema.ts";
import { agentIdentity, agentTokens, viewerAuthorized } from "./auth.ts";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
async function body(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Expected application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing JSON body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new HttpError(413, "Report exceeds 1 MiB");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function timely(value: string) {
  if (Date.parse(value) > Date.now() + 300_000)
    throw new HttpError(400, "Timestamp too far in future");
}
function noSecrets(value: string, env: Env) {
  for (const token of Object.values(agentTokens(env)))
    if (token && value.includes(token))
      throw new HttpError(400, "Credential found in report");
}
async function ingest(request: Request, env: Env, machineId: string) {
  const parsed = ReportSchema.safeParse(await body(request));
  if (!parsed.success) throw new HttpError(400, "Invalid v1 report");
  const report = parsed.data;
  if (report.machine.id !== machineId)
    throw new HttpError(403, "Token does not authorize this machine");
  timely(report.capturedAt);
  const payload = canonical(report);
  noSecrets(payload, env);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reports(machine_id, report_id, captured_at, received_at, digest, payload) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(machine_id, report_id) DO NOTHING",
    ).bind(machineId, report.reportId, report.capturedAt, now, digest, payload),
    env.DB.prepare(`INSERT INTO machines(id, name, last_seen, latest_seq, latest_captured_at, latest_report_id)
      SELECT machine_id, ?, ?, seq, captured_at, report_id FROM reports WHERE machine_id = ? AND report_id = ? AND digest = ?
      ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, warning = CASE WHEN (excluded.latest_captured_at, excluded.latest_report_id) > (machines.latest_captured_at, machines.latest_report_id) THEN NULL ELSE machines.warning END,
      name = CASE WHEN (excluded.latest_captured_at, excluded.latest_report_id) > (machines.latest_captured_at, machines.latest_report_id) THEN excluded.name ELSE machines.name END,
      latest_seq = CASE WHEN (excluded.latest_captured_at, excluded.latest_report_id) > (machines.latest_captured_at, machines.latest_report_id) THEN excluded.latest_seq ELSE machines.latest_seq END,
      latest_captured_at = MAX(machines.latest_captured_at, excluded.latest_captured_at),
      latest_report_id = CASE WHEN (excluded.latest_captured_at, excluded.latest_report_id) > (machines.latest_captured_at, machines.latest_report_id) THEN excluded.latest_report_id ELSE machines.latest_report_id END`).bind(
      report.machine.name,
      now,
      machineId,
      report.reportId,
      digest,
    ),
    env.DB.prepare(
      "SELECT seq, digest FROM reports WHERE machine_id = ? AND report_id = ?",
    ).bind(machineId, report.reportId),
  ]);
  const saved = result[2].results[0] as { seq: number; digest: string };
  if (saved.digest !== digest)
    throw new HttpError(409, "reportId already used for different content");
  return json(
    { accepted: true, duplicate: result[0].meta.changes === 0, seq: saved.seq },
    result[0].meta.changes ? 201 : 200,
  );
}
function positive(
  value: string | null,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (value === null) return fallback;
  if (
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    throw new HttpError(400, "Invalid pagination parameter");
  return Number(value);
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    request.method !== "GET" &&
    request.headers.has("origin") &&
    request.headers.get("origin") !== url.origin
  )
    throw new HttpError(403, "Origin not allowed");
  if (path === "/api/live" && request.method === "GET") {
    await env.DB.prepare("SELECT 1").first();
    return json({
      status: "ok",
      service: "eagle",
      version,
      schemaVersion: 1,
      revision: env.BUILD_REVISION,
    });
  }
  if (path === "/api/v1/reports" || path === "/api/v1/heartbeat") {
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed");
    const identity = await agentIdentity(request, env);
    if (!identity) throw new HttpError(401, "Invalid agent token");
    if (path.endsWith("reports")) return ingest(request, env, identity);
    const parsed = HeartbeatSchema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Invalid v1 heartbeat");
    if (parsed.data.machineId !== identity)
      throw new HttpError(403, "Token does not authorize this machine");
    timely(parsed.data.sentAt);
    noSecrets(JSON.stringify(parsed.data), env);
    const result = await env.DB.prepare(
      "UPDATE machines SET last_seen = ?, warning = COALESCE(?, warning) WHERE id = ?",
    )
      .bind(new Date().toISOString(), parsed.data.warning ?? null, identity)
      .run();
    if (!result.meta.changes)
      throw new HttpError(409, "Upload initial report first");
    return json({ alive: true });
  }
  if (!(await viewerAuthorized(request, env)))
    throw new HttpError(401, "Sign in required");
  if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
  if (path === "/api/v1/overview") {
    const { results } = await env.DB.prepare(
      "SELECT m.id, m.name, m.last_seen, m.warning, r.received_at, r.payload FROM machines m JOIN reports r ON r.seq = m.latest_seq ORDER BY m.name, m.id",
    ).all<{
      id: string;
      name: string;
      last_seen: string;
      warning: string | null;
      received_at: string;
      payload: string;
    }>();
    return json({
      now: new Date().toISOString(),
      machines: results.map((r) => ({
        id: r.id,
        name: r.name,
        lastSeen: r.last_seen,
        warning: r.warning,
        receivedAt: r.received_at,
        report: JSON.parse(r.payload),
      })),
    });
  }
  if (path === "/api/v1/history") {
    const machine = url.searchParams.get("machine");
    const space = url.searchParams.get("space");
    const limit = positive(url.searchParams.get("limit"), 20, 100);
    const before = positive(
      url.searchParams.get("before"),
      Number.MAX_SAFE_INTEGER,
    );
    const { results } = await env.DB.prepare(
      `SELECT seq, machine_id, captured_at, report_id, received_at, payload FROM reports WHERE seq < ? AND (? IS NULL OR machine_id = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(payload, '$.spaces') WHERE json_extract(value, '$.id') = ?)) ORDER BY seq DESC LIMIT ?`,
    )
      .bind(before, machine, machine, space, space, limit + 1)
      .all<{
        seq: number;
        machine_id: string;
        captured_at: string;
        report_id: string;
        received_at: string;
        payload: string;
      }>();
    const entries = await Promise.all(
      results.slice(0, limit).map(async (row) => {
        const previous = await env.DB.prepare(
          "SELECT payload FROM reports WHERE machine_id = ? AND (captured_at, report_id) < (?, ?) ORDER BY captured_at DESC, report_id DESC LIMIT 1",
        )
          .bind(row.machine_id, row.captured_at, row.report_id)
          .first<{ payload: string }>();
        const report = JSON.parse(row.payload) as Report;
        return {
          seq: row.seq,
          receivedAt: row.received_at,
          report,
          changes: changesBetween(
            previous ? JSON.parse(previous.payload) : null,
            report,
          ),
        };
      }),
    );
    return json({
      entries,
      nextCursor: results.length > limit ? entries.at(-1)?.seq : null,
    });
  }
  throw new HttpError(404, "Not found");
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.hostname === "eagle-ingest.hexly.ai" &&
      !["/api/v1/reports", "/api/v1/heartbeat", "/api/live"].includes(
        url.pathname,
      )
    )
      return json({ error: "Not found" }, 404);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message }, error.status);
      console.error(
        JSON.stringify({
          event: "request_failed",
          category: error instanceof Error ? error.name : "unknown",
          path: new URL(request.url).pathname,
        }),
      );
      return json({ error: "Service unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
