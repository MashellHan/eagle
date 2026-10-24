// Domain types for Bots. No wire encoding, no pi-durable, no zod: this module is
// what every layer below the protocol agrees on.
// See docs/bots/PROTOCOL.md (entities) and docs/bots/ARCHITECTURE.md (ownership).

export type BotId = string;

/** Bot ids as the catalog, protocol and filesystem accept them. */
export const BOT_ID_PATTERN = /^b_[A-Za-z0-9_-]{1,64}$/;
export type EntryId = string;

export type BotState =
  | "catalogued"
  | "opening"
  | "idle"
  | "running"
  | "unavailable"
  | "quarantined";

export type BusyMode = "followUp" | "steer" | "reject";

export type ErrorKind =
  | "auth_failed"
  | "unknown_bot"
  | "invalid_command"
  | "limit_exceeded"
  | "version_mismatch"
  | "model_error"
  | "session_failed"
  | "task_faulted"
  | "task_parked"
  | "extension_error"
  | "storage_failed"
  | "internal";

/** Only `notAdmitted` lets a client drop an outbox entry and restore its text. */
export type ErrorDisposition = "not_admitted" | "unknown" | "runtime";

export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error" | "deferred";

export type TextBlock = { readonly type: "text"; readonly text: string };
export type ThinkingBlock = { readonly type: "thinking"; readonly text: string };
export type ToolCallBlock = {
  readonly type: "toolCall";
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
};
export type ToolResultBlock = {
  readonly type: "toolResult";
  readonly callId: string;
  readonly text: string;
  readonly isError: boolean;
};

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export type MessageRole = "user" | "assistant" | "notice" | "tool" | "system";
export type MessageState = "streaming" | "complete" | "aborted" | "error";

export type Message = {
  readonly id: EntryId;
  readonly role: MessageRole;
  readonly state: MessageState;
  readonly createdAt: string;
  readonly blocks: readonly ContentBlock[];
  /** User messages only: ties the committed entry to the `send` that caused it. */
  readonly requestId?: string;
  readonly stopReason?: StopReason;
};

export type InboxItem = {
  readonly id: string;
  readonly mode: "followUp" | "steer" | "queue";
};

export type SubmissionStatus = "queued" | "placed" | "done" | "unanswered";

export type Submission = {
  readonly id: string;
  readonly requestId: string;
  readonly status: SubmissionStatus;
  /** `pi.user` entry, once placed. */
  readonly entryId?: string;
  /** `pi.assistant` entry, once done. */
  readonly answerEntryId?: string;
  /** Only on `unanswered`: `model_error`, `aborted`, `run_failed`, `stale`, `withdrawn`, … */
  readonly reason?: string;
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type AgentView = {
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly thinkingLevel: string;
  readonly instructions: string;
};

export type BotSummary = {
  readonly id: BotId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly state: BotState;
  readonly unavailable?: { readonly reason: ErrorKind; readonly message: string };
};

export type ConversationSnapshot = {
  readonly botId: BotId;
  readonly agent?: AgentView;
  /** Newest page, oldest first. Empty when `unavailable` is present. */
  readonly messages: readonly Message[];
  /** Present when older messages exist and are loadable through `history`. */
  readonly truncatedBefore?: EntryId;
  /** `null` when no attempt is in flight, including a withdrawn over-limit attempt. */
  readonly streaming: string | null;
  readonly pending: readonly Submission[];
  readonly inbox: readonly InboxItem[];
  readonly running: boolean;
  readonly usage?: Usage;
  readonly unavailable?: { readonly reason: ErrorKind; readonly message: string };
};

export type DeltaChange =
  | { readonly kind: "text"; readonly index: number; readonly append: string }
  | { readonly kind: "thinking"; readonly index: number; readonly append: string }
  | {
      readonly kind: "toolcall";
      readonly index: number;
      readonly callId: string;
      readonly path: readonly (string | number)[];
      readonly append: string;
    }
  | { readonly kind: "block"; readonly index: number; readonly block: ContentBlock }
  | { readonly kind: "message"; readonly message: Message };

export type Capabilities = {
  readonly agent: boolean;
  readonly tools: boolean;
  readonly tasks: boolean;
  readonly entries: boolean;
  readonly usage: boolean;
  readonly peers: boolean;
};

export const ALL_CAPABILITIES_OFF: Capabilities = {
  agent: false,
  tools: false,
  tasks: false,
  entries: false,
  usage: false,
  peers: false,
};

/** Every domain failure crosses layers with one identity minted by its classifier. */
export type Failure = {
  readonly id: string;
  readonly kind: ErrorKind;
  readonly layer: "transport" | "protocol" | "core" | "runtime" | "pi";
};

/** A bot as the catalog stores it. Runtime state is not persisted here. */
export type BotRecord = {
  readonly id: BotId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: { readonly provider: string; readonly modelId: string };
};
