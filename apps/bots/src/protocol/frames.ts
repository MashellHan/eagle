// Wire ⇄ domain for protocol v1. Field names follow docs/bots/PROTOCOL.md exactly;
// unknown fields are tolerated (additive versioning) and never re-encoded.
import type {
  BotSummary,
  ContentBlock,
  ConversationSnapshot,
  DeltaChange,
  ErrorDisposition,
  ErrorKind,
  InboxItem,
  Message,
  Submission,
  Usage,
} from "../core/domain.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export type ClientCommand =
  | { readonly type: "hello"; readonly protocolVersion: number; readonly client: string }
  | { readonly type: "subscribe"; readonly botId: string; readonly trace: string }
  | {
      readonly type: "send";
      readonly requestId: string;
      readonly text: string;
      readonly whenBusy: "followUp" | "steer" | "reject";
      readonly trace: string;
    }
  | { readonly type: "abort"; readonly trace: string }
  | { readonly type: "recover"; readonly trace: string }
  | { readonly type: "resync"; readonly trace: string }
  | {
      readonly type: "history";
      readonly before: string;
      readonly limit: number;
      readonly trace: string;
    }
  | { readonly type: "ping" };

export type ServerEvent = { readonly rev?: number; readonly trace?: string } & (
  | {
      readonly type: "welcome";
      readonly protocolVersion: number;
      readonly server: {
        readonly version: string;
        readonly instance: string;
        readonly pid: number;
      };
      readonly capabilities: Readonly<Record<string, boolean>>;
      readonly bots: readonly BotSummary[];
    }
  | { readonly type: "snapshot"; readonly value: ConversationSnapshot }
  | { readonly type: "append"; readonly message: Message; readonly replaces?: string }
  | { readonly type: "delta"; readonly messageId: string; readonly changes: readonly DeltaChange[] }
  | {
      readonly type: "status";
      readonly running: boolean;
      readonly streaming: string | null;
      readonly inbox: readonly InboxItem[];
    }
  | { readonly type: "submission"; readonly record: Submission }
  | { readonly type: "bots"; readonly bots: readonly BotSummary[] }
  | {
      readonly type: "history";
      readonly messages: readonly Message[];
      readonly hasMore: boolean;
    }
  | {
      readonly type: "error";
      readonly kind: ErrorKind;
      readonly disposition?: ErrorDisposition;
      readonly failure?: string;
      readonly requestId?: string;
      readonly taskId?: string;
      readonly message: string;
      readonly server?: { readonly protocolVersion: number };
    }
  | { readonly type: "pong" }
);

export type FrameErrorReason =
  | "invalid_json"
  | "invalid_command"
  | "invalid_event"
  | "version_mismatch"
  | "limit_exceeded";

export class FrameError extends Error {
  readonly reason: FrameErrorReason;

  constructor(reason: FrameErrorReason, message: string) {
    super(message);
    this.name = "FrameError";
    this.reason = reason;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new FrameError("invalid_command", `${what} must be a string`);
  return v;
};

const optStr = (v: unknown, what: string): string | undefined =>
  v === undefined || v === null ? undefined : str(v, what);

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new FrameError("invalid_command", `${what} must be a number`);
  }
  return v;
};

const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new FrameError("invalid_command", `${what} must be a boolean`);
  return v;
};

const arr = (v: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(v)) throw new FrameError("invalid_command", `${what} must be an array`);
  return v;
};

export function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameError("invalid_json", "frame is not JSON");
  }
  if (!isObject(value)) throw new FrameError("invalid_command", "frame must be an object");
  return value;
}

export function decodeCommand(raw: Record<string, unknown>): ClientCommand {
  const type = str(raw.type, "type");
  switch (type) {
    case "hello":
      return {
        type: "hello",
        protocolVersion: num(raw.protocolVersion, "protocolVersion"),
        client: str(raw.client, "client"),
      };
    case "subscribe":
      return { type, botId: str(raw.botId, "botId"), trace: str(raw.trace, "trace") };
    case "send": {
      const whenBusy = optStr(raw.whenBusy, "whenBusy") ?? "followUp";
      if (whenBusy !== "followUp" && whenBusy !== "steer" && whenBusy !== "reject") {
        throw new FrameError("invalid_command", "whenBusy is invalid");
      }
      return {
        type,
        requestId: str(raw.requestId, "requestId"),
        text: str(raw.text, "text"),
        whenBusy,
        trace: str(raw.trace, "trace"),
      };
    }
    case "abort":
    case "recover":
    case "resync":
      return { type, trace: str(raw.trace, "trace") };
    case "history":
      return {
        type,
        before: str(raw.before, "before"),
        limit: num(raw.limit, "limit"),
        trace: str(raw.trace, "trace"),
      };
    case "ping":
      return { type: "ping" };
    default:
      throw new FrameError("invalid_command", `unknown command ${type}`);
  }
}

function decodeMessage(raw: unknown): Message {
  if (!isObject(raw)) throw new FrameError("invalid_event", "message must be an object");
  const message: Record<string, unknown> = {
    id: str(raw.id, "message.id"),
    role: str(raw.role, "message.role"),
    state: str(raw.state, "message.state"),
    createdAt: str(raw.createdAt, "message.createdAt"),
    blocks: arr(raw.blocks, "message.blocks").map(decodeBlock),
  };
  const requestId = optStr(raw.requestId, "message.requestId");
  if (requestId !== undefined) message.requestId = requestId;
  const stopReason = optStr(raw.stopReason, "message.stopReason");
  if (stopReason !== undefined) message.stopReason = stopReason;
  return message as unknown as Message;
}

function decodeBlock(raw: unknown): ContentBlock {
  if (!isObject(raw)) throw new FrameError("invalid_event", "block must be an object");
  const type = str(raw.type, "block.type");
  if (type === "text") return { type: "text", text: str(raw.text, "block.text") };
  if (type === "thinking") return { type: "thinking", text: str(raw.text, "block.text") };
  if (type === "toolCall") {
    return {
      type: "toolCall",
      callId: str(raw.callId, "block.callId"),
      name: str(raw.name, "block.name"),
      args: isObject(raw.args) ? raw.args : {},
    };
  }
  if (type === "toolResult") {
    return {
      type: "toolResult",
      callId: str(raw.callId, "block.callId"),
      text: str(raw.text, "block.text"),
      isError: bool(raw.isError, "block.isError"),
    };
  }
  throw new FrameError("invalid_event", `unknown block type ${type}`);
}

function decodeUsage(raw: unknown): Usage | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new FrameError("invalid_event", "usage must be an object");
  return {
    inputTokens: num(raw.inputTokens, "usage.inputTokens"),
    outputTokens: num(raw.outputTokens, "usage.outputTokens"),
    totalTokens: num(raw.totalTokens, "usage.totalTokens"),
  };
}

function decodeInboxItem(raw: unknown): InboxItem {
  if (!isObject(raw)) throw new FrameError("invalid_event", "inbox item must be an object");
  const mode = str(raw.mode, "inbox.mode");
  if (mode !== "followUp" && mode !== "steer" && mode !== "queue") {
    throw new FrameError("invalid_event", "inbox.mode is invalid");
  }
  return { id: str(raw.id, "inbox.id"), mode };
}

function decodeSubmission(raw: unknown): Submission {
  if (!isObject(raw)) throw new FrameError("invalid_event", "submission must be an object");
  const status = str(raw.status, "submission.status");
  if (status !== "queued" && status !== "placed" && status !== "done" && status !== "unanswered") {
    throw new FrameError("invalid_event", "submission.status is invalid");
  }
  const record: Record<string, unknown> = {
    id: str(raw.submissionId, "submission.submissionId"),
    requestId: str(raw.requestId, "submission.requestId"),
    status,
  };
  const entryId = optStr(raw.entryId, "submission.entryId");
  if (entryId !== undefined) record.entryId = entryId;
  const answerEntryId = optStr(raw.answerEntryId, "submission.answerEntryId");
  if (answerEntryId !== undefined) record.answerEntryId = answerEntryId;
  const reason = optStr(raw.reason, "submission.reason");
  if (reason !== undefined) record.reason = reason;
  return record as unknown as Submission;
}

function decodeSnapshot(raw: unknown): ConversationSnapshot {
  if (!isObject(raw)) throw new FrameError("invalid_event", "snapshot value must be an object");
  const value: Record<string, unknown> = {
    botId: str(raw.botId, "snapshot.botId"),
    messages: arr(raw.messages, "snapshot.messages").map(decodeMessage),
    streaming:
      raw.streaming === null || raw.streaming === undefined
        ? null
        : isObject(raw.streaming)
          ? str(raw.streaming.messageId, "snapshot.streaming.messageId")
          : null,
    pending: arr(raw.pending, "snapshot.pending").map(decodeSubmission),
    inbox: arr(raw.inbox, "snapshot.inbox").map(decodeInboxItem),
    running: bool(raw.running, "snapshot.running"),
  };
  const truncatedBefore = optStr(raw.truncatedBefore, "snapshot.truncatedBefore");
  if (truncatedBefore !== undefined) value.truncatedBefore = truncatedBefore;
  const usage = decodeUsage(raw.usage);
  if (usage !== undefined) value.usage = usage;
  if (isObject(raw.agent)) {
    const model = isObject(raw.agent.model) ? raw.agent.model : {};
    value.agent = {
      model: {
        provider: str(model.provider, "agent.model.provider"),
        modelId: str(model.modelId, "agent.model.modelId"),
      },
      thinkingLevel: str(raw.agent.thinkingLevel, "agent.thinkingLevel"),
      instructions: str(raw.agent.instructions, "agent.instructions"),
    };
  }
  if (isObject(raw.unavailable)) {
    value.unavailable = {
      reason: str(raw.unavailable.reason, "unavailable.reason") as ErrorKind,
      message: str(raw.unavailable.message, "unavailable.message"),
    };
  }
  return value as unknown as ConversationSnapshot;
}

function decodeDeltaChange(raw: unknown): DeltaChange {
  if (!isObject(raw)) throw new FrameError("invalid_event", "delta change must be an object");
  const kind = str(raw.kind, "change.kind");
  if (kind === "text" || kind === "thinking") {
    return {
      kind,
      index: num(raw.index, "change.index"),
      append: str(raw.append, "change.append"),
    };
  }
  if (kind === "toolcall") {
    return {
      kind,
      index: num(raw.index, "change.index"),
      callId: str(raw.callId, "change.callId"),
      path: arr(raw.path, "change.path") as readonly (string | number)[],
      append: str(raw.append, "change.append"),
    };
  }
  if (kind === "block") {
    return { kind, index: num(raw.index, "change.index"), block: decodeBlock(raw.block) };
  }
  if (kind === "message") return { kind, message: decodeMessage(raw.message) };
  throw new FrameError("invalid_event", `unknown change kind ${kind}`);
}

function decodeBotSummary(raw: unknown): BotSummary {
  if (!isObject(raw)) throw new FrameError("invalid_event", "bot must be an object");
  const model = isObject(raw.model) ? raw.model : {};
  const bot: Record<string, unknown> = {
    id: str(raw.id, "bot.id"),
    title: str(raw.title, "bot.title"),
    createdAt: str(raw.createdAt, "bot.createdAt"),
    updatedAt: str(raw.updatedAt, "bot.updatedAt"),
    model: {
      provider: str(model.provider, "bot.model.provider"),
      modelId: str(model.modelId, "bot.model.modelId"),
    },
    state: str(raw.state, "bot.state"),
  };
  if (isObject(raw.unavailable)) {
    bot.unavailable = {
      reason: str(raw.unavailable.reason, "bot.unavailable.reason") as ErrorKind,
      message: str(raw.unavailable.message, "bot.unavailable.message"),
    };
  }
  return bot as unknown as BotSummary;
}

export function decodeServerEvent(raw: Record<string, unknown>): ServerEvent {
  const type = str(raw.type, "type");
  const base: { rev?: number; trace?: string } = {};
  if (raw.rev !== undefined) base.rev = num(raw.rev, "rev");
  if (raw.trace !== undefined) base.trace = str(raw.trace, "trace");

  switch (type) {
    case "welcome": {
      const server = isObject(raw.server) ? raw.server : {};
      const capabilities: Record<string, boolean> = {};
      if (isObject(raw.capabilities)) {
        for (const [name, on] of Object.entries(raw.capabilities)) capabilities[name] = on === true;
      }
      return {
        ...base,
        type,
        protocolVersion: num(raw.protocolVersion, "protocolVersion"),
        server: {
          version: str(server.version, "server.version"),
          instance: str(server.instance, "server.instance"),
          pid: num(server.pid, "server.pid"),
        },
        capabilities,
        bots: arr(raw.bots, "welcome.bots").map(decodeBotSummary),
      };
    }
    case "snapshot":
      return { ...base, type, value: decodeSnapshot(raw.value) };
    case "append": {
      const replaces = optStr(raw.replaces, "replaces");
      return replaces === undefined
        ? { ...base, type, message: decodeMessage(raw.message) }
        : { ...base, type, message: decodeMessage(raw.message), replaces };
    }
    case "delta":
      return {
        ...base,
        type,
        messageId: str(raw.messageId, "messageId"),
        changes: arr(raw.changes, "changes").map(decodeDeltaChange),
      };
    case "status":
      return {
        ...base,
        type,
        running: bool(raw.running, "running"),
        streaming:
          raw.streaming === null || raw.streaming === undefined
            ? null
            : str(raw.streaming, "streaming"),
        inbox: arr(raw.inbox, "inbox").map(decodeInboxItem),
      };
    case "submission":
      return { ...base, type, record: decodeSubmission(raw) };
    case "bots":
      return { ...base, type, bots: arr(raw.bots, "bots").map(decodeBotSummary) };
    case "history":
      return {
        ...base,
        type,
        messages: arr(raw.messages ?? [], "messages").map(decodeMessage),
        hasMore: bool(raw.hasMore ?? false, "hasMore"),
      };
    case "error": {
      const event: Record<string, unknown> = {
        ...base,
        type,
        kind: str(raw.kind, "kind"),
        message: str(raw.message, "message"),
      };
      const disposition = optStr(raw.disposition, "disposition");
      if (disposition !== undefined) event.disposition = disposition;
      const failure = optStr(raw.failure, "failure");
      if (failure !== undefined) event.failure = failure;
      const requestId = optStr(raw.requestId, "requestId");
      if (requestId !== undefined) event.requestId = requestId;
      const taskId = optStr(raw.taskId, "taskId");
      if (taskId !== undefined) event.taskId = taskId;
      if (isObject(raw.server)) {
        event.server = {
          protocolVersion: num(raw.server.protocolVersion, "server.protocolVersion"),
        };
      }
      return event as unknown as ServerEvent;
    }
    case "pong":
      return { ...base, type };
    default:
      throw new FrameError("invalid_event", `unknown event ${type}`);
  }
}

export { PROTOCOL_VERSION };
