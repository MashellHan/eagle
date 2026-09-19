import { version } from "../../package.json";
import { changesBetween } from "../shared/assessment.ts";
import { MachineInput, MachineName } from "../shared/connect.ts";
import {
  type HourlySettings,
  HourlySettingsSchema,
  REPORT_SECTIONS,
  TEMPLATE_VERSION,
  validHour,
} from "../shared/hourly.ts";
import {
  HeartbeatSchema,
  type Report,
  ReportSchema,
} from "../shared/schema.ts";
import {
  digest,
  evidenceKeys,
  paneKey,
  SummaryBatchSchema,
  taskKey,
} from "../shared/summaries.ts";
import {
  agentIdentity,
  agentTokens,
  containsCredential,
  issueToken,
  viewerIdentity,
} from "./auth.ts";

export { MachineDirectory } from "./directory.ts";
export { MachineState } from "./machine.ts";

import { withAiKey } from "./ai-secret.ts";
import { aiConfig, aiReady, runHourly, testAi } from "./hourly.ts";
import { withProfile } from "./profile.ts";

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
async function noSecrets(value: string, env: Env) {
  if (containsCredential(value, await withAiKey(env)))
    throw new HttpError(400, "Credential found in report");
}
function settingsInput(input: unknown, previous: HourlySettings) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "Invalid AI settings");
  const { apiKey, ...fields } = input as Record<string, unknown>;
  if (
    apiKey !== undefined &&
    apiKey !== null &&
    (typeof apiKey !== "string" ||
      apiKey.length > 4096 ||
      /\s/.test(apiKey.trim()))
  )
    throw new HttpError(400, "Invalid API key");
  const parsed = HourlySettingsSchema.safeParse({ ...previous, ...fields });
  if (!parsed.success) throw new HttpError(400, "Invalid AI settings");
  try {
    if (parsed.data.provider) aiConfig(parsed.data, "validation-placeholder");
  } catch {
    throw new HttpError(400, "Invalid AI configuration");
  }
  const key =
    typeof apiKey === "string"
      ? apiKey.trim() || undefined
      : (apiKey as null | undefined);
  if (key && !parsed.data.provider)
    throw new HttpError(400, "Select an AI provider before saving its key");
  return { settings: parsed.data, apiKey: key };
}
async function ingest(
  request: Request,
  env: Env,
  machineId: string,
  credentialId: string | null,
) {
  const parsed = ReportSchema.safeParse(await body(request));
  if (!parsed.success) throw new HttpError(400, "Invalid v1 report");
  const report = parsed.data;
  if (report.machine.id !== machineId)
    throw new HttpError(403, "Token does not authorize this machine");
  timely(report.capturedAt);
  const payload = canonical(report);
  await noSecrets(payload, env);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const result = await env.MACHINES.getByName(machineId).ingest(
    report,
    digest,
    credentialId,
    Object.fromEntries(
      await Promise.all(
        report.spaces.flatMap((space) =>
          space.tabs.flatMap((tab) =>
            tab.panes.map(async (pane) => [
              paneKey({ spaceId: space.id, paneId: pane.id }),
              await evidenceKeys(
                pane.evidence.filter((e) => e.taskId === pane.task.id),
              ),
            ]),
          ),
        ),
      ),
    ),
  );
  if ("unauthorized" in result) throw new HttpError(401, "Invalid agent token");
  if ("conflict" in result)
    throw new HttpError(409, "reportId already used for different content");
  return json(result, result.duplicate ? 200 : 201);
}
async function registrations(env: Env) {
  const ids = [
    ...new Set([
      ...Object.keys(agentTokens(env)),
      ...(await env.DIRECTORY.getByName("fleet").ids()),
    ]),
  ].sort();
  const machines = await Promise.all(
    ids.map((id) => env.MACHINES.getByName(id).registration(id)),
  );
  return machines.filter((m) => m !== null);
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
    const [machine] = Object.keys(agentTokens(env)).sort();
    if (machine) await env.MACHINES.getByName(machine).current();
    return json({
      status: "ok",
      service: "eagle",
      version,
      schemaVersion: 1,
      revision: env.BUILD_REVISION,
      stateStore: "durable-objects",
      historyWrites: false,
      semanticStore: "durable-objects",
      semanticProtocolVersion: 1,
      semanticHours: "UTC",
      hourlyReports: {
        available: true,
        defaultIntervalHours: 1,
        templateVersion: TEMPLATE_VERSION,
      },
    });
  }
  if (path === "/api/v1/summaries" || path === "/api/v1/agent-state") {
    const identity = await agentIdentity(request, env);
    if (!identity) throw new HttpError(401, "Invalid agent token");
    const object = env.MACHINES.getByName(identity.machineId);
    if (path.endsWith("agent-state")) {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed");
      const state = await object.agentCurrent(identity.credentialId);
      if (state && "unauthorized" in state)
        throw new HttpError(401, "Invalid agent token");
      return json(state);
    }
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed");
    const parsed = SummaryBatchSchema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Invalid v1 summary batch");
    const batch = parsed.data;
    if (batch.machineId !== identity.machineId)
      throw new HttpError(403, "Token does not authorize this machine");
    timely(batch.sentAt);
    await noSecrets(JSON.stringify(batch), env);
    const result = await object.summarize(
      batch,
      await digest(batch),
      identity.credentialId,
      Object.fromEntries(
        await Promise.all(
          batch.updates.map(async (entry) => [
            taskKey(entry),
            await digest({ taskId: entry.taskId, summary: entry.summary }),
          ]),
        ),
      ),
    );
    if ("error" in result && result.error)
      return json(
        result,
        result.error === "unauthorized"
          ? 401
          : result.error === "archive_backpressure"
            ? 503
            : 409,
      );
    return json(result, result.duplicate ? 200 : 201);
  }
  if (path === "/api/v1/reports" || path === "/api/v1/heartbeat") {
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed");
    const identity = await agentIdentity(request, env);
    if (!identity) throw new HttpError(401, "Invalid agent token");
    if (path.endsWith("reports"))
      return ingest(request, env, identity.machineId, identity.credentialId);
    const parsed = HeartbeatSchema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Invalid v1 heartbeat");
    if (parsed.data.machineId !== identity.machineId)
      throw new HttpError(403, "Token does not authorize this machine");
    timely(parsed.data.sentAt);
    await noSecrets(JSON.stringify(parsed.data), env);
    const alive = await env.MACHINES.getByName(identity.machineId).heartbeat(
      parsed.data.warning,
      identity.credentialId,
    );
    if (typeof alive === "object")
      throw new HttpError(401, "Invalid agent token");
    if (!alive) throw new HttpError(409, "Upload initial report first");
    return json({ alive: true });
  }
  const viewer = await viewerIdentity(request, env);
  if (!viewer) throw new HttpError(401, "Sign in required");
  if (path === "/api/v1/settings") {
    const directory = env.DIRECTORY.getByName("fleet");
    let settings: HourlySettings = await directory.settings();
    if (request.method === "POST") {
      const input = settingsInput(await body(request), settings);
      await noSecrets(JSON.stringify(input.settings), env);
      if (
        input.apiKey &&
        (containsCredential(input.apiKey, { ...env, AI_API_KEY: undefined }) ||
          JSON.stringify(input.settings).includes(input.apiKey))
      )
        throw new HttpError(
          400,
          "Credential must only appear in the API key field",
        );
      settings = await directory.saveSettings(input.settings, input.apiKey);
    } else if (request.method !== "GET")
      throw new HttpError(405, "Method not allowed");
    const configuredEnv = await withAiKey(env, settings);
    return json({
      ...settings,
      hasApiKey: !!configuredEnv.AI_API_KEY,
      configured: aiReady(settings, configuredEnv),
      templateVersion: TEMPLATE_VERSION,
      sections: REPORT_SECTIONS,
    });
  }
  if (path === "/api/v1/settings/test" && request.method === "POST") {
    const previous = await env.DIRECTORY.getByName("fleet").settings();
    const input = settingsInput(await body(request), previous);
    const configuredEnv = await withAiKey(env, input.settings);
    if (input.apiKey !== undefined)
      configuredEnv.AI_API_KEY = input.apiKey ?? "";
    return json(await testAi(input.settings, configuredEnv));
  }
  if (path === "/api/v1/hourly-reports/run" && request.method === "POST") {
    const input = await body(request);
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((k) => !["machine", "hour"].includes(k)) ||
      (input.machine !== undefined &&
        (typeof input.machine !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.machine))) ||
      (input.hour !== undefined &&
        (typeof input.hour !== "string" ||
          !validHour(input.hour) ||
          Date.parse(input.hour) + 3600000 > Date.now() - 300000 ||
          Date.parse(input.hour) < Date.now() - 48 * 3600000))
    )
      throw new HttpError(400, "Expected a closed UTC hour within retention");
    const ids = (await registrations(env))
      .filter((m) => m.enabled)
      .map((m) => m.id);
    if (input.machine && !ids.includes(input.machine))
      throw new HttpError(404, "Machine not found");
    return json(await runHourly(env, ids, Date.now(), input));
  }
  if (path === "/api/v1/machines" && request.method === "GET")
    return json({
      machines: await registrations(env),
      canIssue: !!env.AGENT_SIGNING_KEY && env.AGENT_SIGNING_KEY.length >= 32,
    });
  if (path === "/api/v1/machines" && request.method === "POST") {
    if (!env.AGENT_SIGNING_KEY || env.AGENT_SIGNING_KEY.length < 32)
      throw new HttpError(503, "Token signing is not configured");
    const parsed = MachineInput.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Invalid machine name or ID");
    const { id, name, watchPorts } = parsed.data;
    await noSecrets(JSON.stringify(parsed.data), env);
    if (!(await env.DIRECTORY.getByName("fleet").add(id)))
      throw new HttpError(409, "Machine limit reached");
    const machine = await env.MACHINES.getByName(id).configure(
      id,
      "create",
      name,
      watchPorts,
    );
    if (!machine) throw new HttpError(409, "Machine already exists");
    return json({ machine, token: await issueToken(machine, env) }, 201);
  }
  const management = path.match(
    /^\/api\/v1\/machines\/([a-z0-9][a-z0-9_-]{0,79})\/(rotate|revoke|rename)$/,
  );
  if (management && request.method === "POST") {
    const [, id, operation] = management;
    const action = operation as "rotate" | "revoke" | "rename";
    if (
      action === "rotate" &&
      (!env.AGENT_SIGNING_KEY || env.AGENT_SIGNING_KEY.length < 32)
    )
      throw new HttpError(503, "Token signing is not configured");
    const input = await body(request);
    const parsed = MachineName.safeParse(input);
    if (action === "rename" && !parsed.success)
      throw new HttpError(400, "Invalid machine name");
    await noSecrets(JSON.stringify(input), env);
    if (!(await env.MACHINES.getByName(id).registration(id)))
      throw new HttpError(404, "Machine not found");
    // Index legacy machines before migrating, so removing their old secret is safe.
    if (!(await env.DIRECTORY.getByName("fleet").add(id)))
      throw new HttpError(409, "Machine limit reached");
    const machine = await env.MACHINES.getByName(id).configure(
      id,
      action,
      action === "rename" && parsed.success ? parsed.data.name : undefined,
    );
    if (!machine) throw new HttpError(404, "Machine not found");
    return json({
      machine,
      ...(action === "rotate" ? { token: await issueToken(machine, env) } : {}),
    });
  }
  if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
  if (path === "/api/v1/me") return json(await withProfile(viewer));
  if (path === "/api/v1/hourly-reports") {
    const machine = url.searchParams.get("machine");
    const hour = url.searchParams.get("hour");
    if (hour && !validHour(hour)) throw new HttpError(400, "Invalid UTC hour");
    const limit = positive(url.searchParams.get("limit"), 12, 100);
    const before = url.searchParams.get("before");
    const cursor = before?.split("|");
    if (
      cursor &&
      (cursor.length !== 2 ||
        !validHour(cursor[0]) ||
        !/^[1-9]\d{0,15}$/.test(cursor[1]) ||
        !Number.isSafeInteger(Number(cursor[1])))
    )
      throw new HttpError(400, "Invalid hourly cursor");
    const { results } = await env.DB.prepare(
      "SELECT seq,hour,payload FROM machine_hour_reports WHERE (hour,seq)<(?,?) AND (? IS NULL OR machine_id=?) AND (? IS NULL OR hour=?) ORDER BY hour DESC,seq DESC LIMIT ?",
    )
      .bind(
        cursor?.[0] ?? "9999-12-31T23:00:00.000Z",
        cursor ? Number(cursor[1]) : Number.MAX_SAFE_INTEGER,
        machine,
        machine,
        hour,
        hour,
        limit + 1,
      )
      .all<{ seq: number; hour: string; payload: string }>();
    const entries = results
      .slice(0, limit)
      .map((r) => ({ seq: r.seq, report: JSON.parse(r.payload) }));
    return json({
      entries,
      nextCursor:
        results.length > limit
          ? `${results[limit - 1].hour}|${results[limit - 1].seq}`
          : null,
    });
  }
  if (path === "/api/v1/overview") {
    const ids = (await registrations(env))
      .filter((m) => m.enabled)
      .map((m) => m.id);
    const states = await Promise.all(
      ids.map((id) => env.MACHINES.getByName(id).current()),
    );
    return json({
      now: new Date().toISOString(),
      machines: states.filter((state) => state !== null),
      pendingMachines: ids.filter((_, index) => states[index] === null),
    });
  }
  if (path === "/api/v1/semantic-hours") {
    const machine = url.searchParams.get("machine");
    if (!machine || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(machine))
      throw new HttpError(400, "Machine required");
    const hour = url.searchParams.get("hour") ?? undefined;
    const before = url.searchParams.get("before") ?? undefined;
    const validHour = (v: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(v) &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString() === v;
    if (hour && !validHour(hour))
      throw new HttpError(400, "Expected canonical UTC hour");
    if (before && (hour ? !/^[1-9]\d{0,15}$/.test(before) : !validHour(before)))
      throw new HttpError(400, "Invalid semantic cursor");
    const mode = url.searchParams.get("mode") ?? "all";
    if (mode !== "all" && mode !== "latest")
      throw new HttpError(400, "Invalid semantic mode");
    if (mode === "latest" && before)
      throw new HttpError(400, "Latest mode does not accept a cursor");
    return json(
      await env.MACHINES.getByName(machine).semanticHours({
        spaceId: url.searchParams.get("space") ?? undefined,
        paneId: url.searchParams.get("pane") ?? undefined,
        hour,
        mode,
        before,
        limit: positive(url.searchParams.get("limit"), 12, 100),
      }),
    );
  }
  if (path === "/api/v1/summary-history") {
    const machine = url.searchParams.get("machine");
    const space = url.searchParams.get("space");
    const pane = url.searchParams.get("pane");
    if (!machine || !space || !pane)
      throw new HttpError(400, "Machine, space and pane are required");
    const limit = positive(url.searchParams.get("limit"), 20, 100);
    const before = positive(
      url.searchParams.get("before"),
      Number.MAX_SAFE_INTEGER,
    );
    const { results } = await env.DB.prepare(
      "SELECT seq, received_at, payload FROM pane_summaries WHERE machine_id = ? AND space_id = ? AND pane_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    )
      .bind(machine, space, pane, before, limit + 1)
      .all<{ seq: number; received_at: string; payload: string }>();
    const entries = results.slice(0, limit).map((r) => ({
      seq: r.seq,
      receivedAt: r.received_at,
      value: JSON.parse(r.payload),
    }));
    return json({
      entries,
      nextCursor: results.length > limit ? entries.at(-1)?.seq : null,
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
  async scheduled(controller, env) {
    const ids = (await registrations(env))
      .filter((m) => m.enabled)
      .map((m) => m.id);
    const result = await runHourly(env, ids, controller.scheduledTime);
    if (result.results.some((r) => "error" in r))
      throw new Error("Hourly report generation failed");
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.hostname === "eagle-ingest.hexly.ai" &&
      ![
        "/api/v1/reports",
        "/api/v1/heartbeat",
        "/api/v1/summaries",
        "/api/v1/agent-state",
        "/api/live",
      ].includes(url.pathname)
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
