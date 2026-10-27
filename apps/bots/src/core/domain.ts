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
  /** The tool the call named, so a row survives a page whose call was trimmed away. */
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
  /** How long the tool took, when pi recorded it. */
  readonly durationMs?: number;
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

/** The closed sets the client and the daemon share for a bot's face. */
export const BOT_SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "star",
  "cloud",
  "shield",
  "drop",
  "hex",
  "heart",
  "flower",
] as const;
export type BotShape = (typeof BOT_SHAPES)[number];

export const BOT_TINTS = [
  "paper",
  "clay",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
  "graphite",
] as const;
export type BotTint = (typeof BOT_TINTS)[number];

/** How the client draws a bot: one shape and one tint from the closed sets. */
export type BotAppearance = {
  readonly shape: BotShape;
  readonly tint: BotTint;
};

export const DEFAULT_APPEARANCE: BotAppearance = { shape: "blob", tint: "green" };

export type BotSummary = {
  readonly id: BotId;
  readonly title: string;
  /** Optional short label the user typed; never user content beyond this field. */
  readonly label?: string;
  /** Absent only in a catalog written before appearance existed. */
  readonly appearance?: BotAppearance;
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
  /** A task is parked and `recover` retries it; a new client needs this from the snapshot. */
  readonly parked?: boolean;
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

/**
 * A failure a layer already classified. The identity and the disposition travel with it,
 * so an upper layer rethrows instead of minting a second failure for one episode. It
 * lives in the domain so adapters can throw it without depending on the service.
 */
export class ClassifiedFailure extends Error {
  readonly failure: Failure;
  readonly disposition: ErrorDisposition;

  constructor(
    failure: Failure,
    disposition: ErrorDisposition,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ClassifiedFailure";
    this.failure = failure;
    this.disposition = disposition;
  }
}

/** A bot as the catalog stores it. Runtime state is not persisted here. */
export type BotRecord = {
  readonly id: BotId;
  readonly title: string;
  readonly label?: string;
  /** Absent in catalogs written before appearance existed; defaults on load. */
  readonly appearance?: BotAppearance;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: { readonly provider: string; readonly modelId: string };
};

/** The reasoning levels pi accepts; `medium` is the product default. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

/**
 * The tools a bot can be given, as groups a person turns on in settings. `core` holds the
 * workspace tools and cannot be turned off: a bot that cannot read, write or run anything
 * is not a bot this product ships.
 */
export const TOOL_GROUP_NAMES = ["core", "herdr"] as const;

export type ToolGroup = (typeof TOOL_GROUP_NAMES)[number];

export const MANDATORY_TOOL_GROUPS: readonly ToolGroup[] = ["core"];

export const DEFAULT_TOOL_GROUPS: readonly ToolGroup[] = [...TOOL_GROUP_NAMES];

export const isToolGroup = (value: unknown): value is ToolGroup =>
  typeof value === "string" && (TOOL_GROUP_NAMES as readonly string[]).includes(value);

/** A stored selection, normalized: mandatory groups always present, order stable. */
export const resolveToolGroups = (names: readonly string[] | undefined): readonly ToolGroup[] => {
  const chosen = new Set<ToolGroup>(MANDATORY_TOOL_GROUPS);
  for (const name of names ?? []) if (isToolGroup(name)) chosen.add(name);
  return TOOL_GROUP_NAMES.filter((name) => chosen.has(name));
};
