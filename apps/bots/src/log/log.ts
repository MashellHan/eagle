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

// Every allowed detail key has a declared type. An unknown key or a wrong type is a
// shape error at the emit site, not something the sink silently drops.
const DETAIL_TYPES = {
  count: "number",
  bytes: "number",
  len: "number",
  reason: "string",
  kind: "string",
  role: "string",
  state: "string",
  messageId: "string",
  finished: "string",
  evt: "string",
  providerCode: "string",
  reattach: "boolean",
  quarantined: "boolean",
  queued: "boolean",
  propagated: "boolean",
} as const;

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
    const expected = (DETAIL_TYPES as Record<string, string | undefined>)[key];
    if (expected === undefined) throw new Error(`undeclared log detail key: ${key}`);
    if (typeof value !== expected) {
      throw new Error(`log detail ${key} must be a ${expected}`);
    }
    clean[key] = expected === "string" ? redact(value as string) : value;
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

  emit(level: Level, layer: Layer, evt: EventName, fields: EmitFields): LogRecord {
    // The event argument is an `EventName`, so a literal typo fails typecheck as well.
    if (!isEventName(evt)) throw new Error(`undeclared log event: ${String(evt)}`);
    if (!evt.startsWith(`${layer}.`)) {
      throw new Error(`event ${evt} does not belong to layer ${layer}`);
    }
    const needsFailure = /\.(fail|degrade|reject|classify)$/.test(evt) || level === "error";
    if (needsFailure && fields.failure === undefined) {
      throw new Error(`event ${evt} requires a failure`);
    }
    if (fields.failure !== undefined && fields.failure.id.trim().length === 0) {
      throw new Error(`event ${evt} needs a non-empty failure identity`);
    }
    if (level === "error") {
      if (fields.origin !== true) {
        throw new Error(`only the originating layer logs at error (${evt})`);
      }
      if (fields.failure?.layer !== layer) {
        throw new Error(
          `error record for ${evt} must originate at ${String(fields.failure?.layer)}`,
        );
      }
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
