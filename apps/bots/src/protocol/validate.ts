// Command validation and frame budgets. Everything here runs once, at the wire
// boundary, so every layer below can assume a well-formed command and a frame that
// fits. Budgets are measured on the encoded bytes, with the same encoder that writes
// the frame.
import { serialize } from "./encode.ts";
import { type ClientCommand, FrameError } from "./frames.ts";
import {
  BOT_ID,
  ENTRY_ID,
  MAX_BOT_SUMMARY_BYTES,
  MAX_CATALOG,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_SEND_TEXT,
  PAGE_MAX_BYTES,
  PAGE_MAX_MESSAGES,
  REQUEST_ID,
  TRACE_ID,
} from "./limits.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const check = (value: string, pattern: RegExp, what: string): string => {
  if (!pattern.test(value)) throw new FrameError("invalid_command", `${what} is malformed`);
  return value;
};

export function validateCommand(command: ClientCommand): ClientCommand {
  switch (command.type) {
    case "hello":
      if (command.protocolVersion !== PROTOCOL_VERSION) {
        throw new FrameError("version_mismatch", `server speaks protocol ${PROTOCOL_VERSION}`);
      }
      return command;
    case "subscribe":
      check(command.botId, BOT_ID, "botId");
      check(command.trace, TRACE_ID, "trace");
      return command;
    case "send": {
      check(command.requestId, REQUEST_ID, "requestId");
      check(command.trace, TRACE_ID, "trace");
      // Characters, not bytes: the contract caps user text in code points.
      if (Array.from(command.text).length > MAX_SEND_TEXT) {
        throw new FrameError("invalid_command", `text exceeds ${MAX_SEND_TEXT} characters`);
      }
      return command;
    }
    case "abort":
    case "recover":
    case "resync":
      check(command.trace, TRACE_ID, "trace");
      return command;
    case "history":
      check(command.trace, TRACE_ID, "trace");
      check(command.before, ENTRY_ID, "before");
      if (
        !Number.isInteger(command.limit) ||
        command.limit < 1 ||
        command.limit > PAGE_MAX_MESSAGES
      ) {
        throw new FrameError("invalid_command", `limit must be 1..${PAGE_MAX_MESSAGES}`);
      }
      return command;
    case "ping":
      return command;
  }
}

/** Bytes the daemon received, before any parsing. */
export function assertInboundBytes(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameError("limit_exceeded", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return bytes;
}

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const pageOf = (wire: Record<string, unknown>): readonly unknown[] | undefined => {
  if (wire.type === "history") return wire.messages as readonly unknown[] | undefined;
  if (wire.type === "snapshot") {
    const value = wire.value as Record<string, unknown> | undefined;
    return value?.messages as readonly unknown[] | undefined;
  }
  return undefined;
};

/**
 * Enforces every budget a frame must satisfy, deriving the counts from the payload
 * instead of trusting a caller's hint. Throws `limit_exceeded`.
 */
export function assertFrameBudget(wire: Record<string, unknown>): number {
  const bytes = encodedBytes(wire);
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameError("limit_exceeded", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }

  const page = pageOf(wire);
  if (page !== undefined) {
    if (page.length > PAGE_MAX_MESSAGES) {
      throw new FrameError("limit_exceeded", `page exceeds ${PAGE_MAX_MESSAGES} messages`);
    }
    if (encodedBytes(page) > PAGE_MAX_BYTES) {
      throw new FrameError("limit_exceeded", `page exceeds ${PAGE_MAX_BYTES} bytes`);
    }
    for (const message of page) {
      if (encodedBytes(message) > MAX_MESSAGE_BYTES) {
        throw new FrameError("limit_exceeded", `message exceeds ${MAX_MESSAGE_BYTES} bytes`);
      }
    }
  }

  if (wire.type === "bots" || wire.type === "welcome") {
    const bots = (wire.bots as readonly unknown[] | undefined) ?? [];
    if (bots.length > MAX_CATALOG) {
      throw new FrameError("limit_exceeded", `catalog exceeds ${MAX_CATALOG} bots`);
    }
    for (const bot of bots) {
      if (encodedBytes(bot) > MAX_BOT_SUMMARY_BYTES) {
        throw new FrameError(
          "limit_exceeded",
          `bot summary exceeds ${MAX_BOT_SUMMARY_BYTES} bytes`,
        );
      }
    }
  }

  return bytes;
}

/** Convenience for tests and for callers that only need the measurement. */
export function measureFrame(wire: Record<string, unknown>): number {
  return Buffer.byteLength(serialize(wire), "utf8");
}
