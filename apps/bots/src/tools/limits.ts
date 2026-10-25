// The tools' own budgets. They are separate from the wire budgets: a tool result is what
// the model reads, and an unbounded one would spend the context on a single call.
export const MAX_READ_BYTES = 64 * 1024;
export const MAX_READ_LINES = 2_000;
export const MAX_WRITE_BYTES = 512 * 1024;
export const MAX_LIST_ENTRIES = 2_000;
export const MAX_PATH_CHARS = 4_096;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
