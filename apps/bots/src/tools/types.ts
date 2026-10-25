// The shape every bot tool speaks (docs/bots/RUNTIME.md, "Tools"): a handler receives the
// workspace and validated arguments and returns what the model should see. Failures are
// results, not exceptions, so one bad path cannot fail the run.
export type BotWorkspace = {
  /** Absolute, canonical path of the bot's workspace; every tool path resolves inside it. */
  readonly root: string;
  /** The daemon's root (token, catalog, other bots), which a command may not touch. */
  readonly daemonRoot: string;
};

export type ToolOutcome = {
  readonly output: string;
  readonly isError?: boolean;
};

/** A path or argument that the workspace refuses; the message is safe to show the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const failed = (message: string): ToolOutcome => ({ output: message, isError: true });
