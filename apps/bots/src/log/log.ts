// Structured layer logging (docs/bots/OBSERVABILITY.md). One JSON record per line,
// every record carries its layer and trace, and both message content and credentials
// are removed before anything is written.

import type { ErrorKind, Failure } from "../core/domain.ts";
import { type EventName, isEventName, type Layer } from "./events.ts";

export const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

export type LogRecord = {
  readonly ts: string;
  readonly level: Level;
  readonly layer: Layer;
  readonly evt: EventName;
  readonly trace: string;
  readonly botId?: string;
  readonly connId?: string;
  readonly reqId?: string;
  readonly rev?: number;
  readonly durMs?: number;
  readonly err?: { readonly kind: ErrorKind; readonly failure: string; readonly origin?: true };
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type LogSink = (record: LogRecord) => void;

const ALLOWED_DETAIL = new Set([
  "count",
  "bytes",
  "len",
  "reason",
  "kind",
  "role",
  "state",
  "messageId",
  "reattach",
  "quarantined",
  "finished",
  "evt",
  "queued",
  "propagated",
]);

const redact = (value: string): string => {
  let text = value;
  for (const secret of [process.env.BOTS_API_KEY, process.env.AGENT_SIGNING_KEY]) {
    if (secret && secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/[A-Za-z0-9_-]{0,2}sk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
  const home = process.env.HOME;
  if (home && home.length > 1) text = text.split(home).join("~");
  return text;
};

const redactDetail = (detail: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!ALLOWED_DETAIL.has(key)) continue;
    if (typeof value === "string") clean[key] = redact(value);
    else if (typeof value === "number" || typeof value === "boolean") clean[key] = value;
  }
  return clean;
};

export type EmitFields = {
  readonly trace: string;
  readonly botId?: string;
  readonly connId?: string;
  readonly reqId?: string;
  readonly rev?: number;
  readonly durMs?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Required for `*.fail`, `*.degrade` and `*.reject`. */
  readonly failure?: Failure;
  /** Set by the originating layer only; layers above record `propagated`. */
  readonly origin?: boolean;
  readonly propagated?: boolean;
};

export class Log {
  readonly #sink: LogSink;
  readonly #now: () => Date;

  constructor(sink: LogSink, now: () => Date = () => new Date()) {
    this.#sink = sink;
    this.#now = now;
  }

  emit(level: Level, layer: Layer, evt: string, fields: EmitFields): LogRecord {
    if (!isEventName(evt)) throw new Error(`undeclared log event: ${evt}`);
    if (!evt.startsWith(`${layer}.`) && evt !== "pi.report" && evt !== "pi.session.closed") {
      throw new Error(`event ${evt} does not belong to layer ${layer}`);
    }
    const needsFailure = /\.(fail|degrade|reject)$/.test(evt);
    if (needsFailure && fields.failure === undefined) {
      throw new Error(`event ${evt} requires a failure`);
    }
    if (level === "error" && fields.origin !== true) {
      throw new Error(`only the originating layer logs at error (${evt})`);
    }

    const record: LogRecord = {
      ts: this.#now().toISOString(),
      level,
      layer,
      evt,
      trace: redact(fields.trace),
      ...(fields.botId === undefined ? {} : { botId: redact(fields.botId) }),
      ...(fields.connId === undefined ? {} : { connId: redact(fields.connId) }),
      ...(fields.reqId === undefined ? {} : { reqId: redact(fields.reqId) }),
      ...(fields.rev === undefined ? {} : { rev: fields.rev }),
      ...(fields.durMs === undefined ? {} : { durMs: fields.durMs }),
      ...(fields.failure === undefined
        ? {}
        : {
            err: {
              kind: fields.failure.kind,
              failure: redact(fields.failure.id),
              ...(fields.origin === true ? { origin: true as const } : {}),
            },
          }),
      ...(fields.detail === undefined && fields.propagated === undefined
        ? {}
        : {
            detail: redactDetail({
              ...(fields.detail ?? {}),
              ...(fields.propagated === true ? { propagated: true } : {}),
            }),
          }),
    };
    this.#sink(record);
    return record;
  }
}

/** Collects records for assertions; never used in production paths. */
export const captureLog = (
  now: () => Date = () => new Date(),
): { log: Log; records: LogRecord[] } => {
  const records: LogRecord[] = [];
  return { log: new Log((record) => records.push(record), now), records };
};
