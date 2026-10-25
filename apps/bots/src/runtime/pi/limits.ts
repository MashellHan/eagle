// Adapter-side budgets. They mirror docs/bots/PROTOCOL.md#limits without importing the
// wire layer (ARCHITECTURE.md, layer allowlist); `test/runtime/limits.test.ts` asserts
// they still match, so a drifted number is a failing test rather than a silent clip.

/** An encoded message above this is withheld and replaced by the notice (PROTOCOL.md). */
export const MAX_MESSAGE_BYTES = 96 * 1024;

/** The fixed text a withheld answer is replaced with. */
export const OVERSIZED_NOTICE = "回答超出传输上限";

/** The newest window a snapshot carries; older messages stay reachable through `history`. */
export const WINDOW_MESSAGES = 200;
