// Command validation and frame budgets. Validation happens once, at the wire
// boundary, so every layer below can assume a well-formed command.

import { serialize } from "./encode.ts";
import type { ClientCommand } from "./frames.ts";
import { FrameError } from "./frames.ts";
import {
  BOT_ID,
  MAX_FRAME_BYTES,
  MAX_SEND_TEXT,
  PAGE_MAX_MESSAGES,
  REQUEST_ID,
  TRACE_ID,
} from "./limits.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const check = (value: string, pattern: RegExp, what: string): string => {
  if (!pattern.test(value)) throw new FrameError("invalid_command", `${what} is malformed`);
  return value;
};

const limit = (value: number, min: number, max: number, what: string): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new FrameError("invalid_command", `${what} is out of range`);
  }
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
      const characters = Array.from(command.text).length;
      if (characters > MAX_SEND_TEXT) {
        throw new FrameError("limit_exceeded", `text exceeds ${MAX_SEND_TEXT} characters`);
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
      if (command.before.length === 0) throw new FrameError("invalid_command", "before is empty");
      limit(command.limit, 1, PAGE_MAX_MESSAGES, "limit");
      return command;
    case "ping":
      return command;
  }
}

export function measureFrame(wire: Record<string, unknown>): number {
  return Buffer.byteLength(serialize(wire), "utf8");
}

export type FrameBudget = { readonly messages?: number };

/** Throws `limit_exceeded` before an oversized frame can be written. */
export function assertFrameBytes(wire: Record<string, unknown>, budget: FrameBudget = {}): number {
  if (budget.messages !== undefined && budget.messages > PAGE_MAX_MESSAGES) {
    throw new FrameError("limit_exceeded", `page exceeds ${PAGE_MAX_MESSAGES} messages`);
  }
  const bytes = measureFrame(wire);
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameError("limit_exceeded", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return bytes;
}
