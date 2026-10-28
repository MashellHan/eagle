// The shape every bot tool speaks (docs/bots/RUNTIME.md, "Tools"): a handler receives the
// workspace and validated arguments and returns what the model should see. Failures are
// results, not exceptions, so one bad path cannot fail the run.
export type BotWorkspace = {
  /** The bot's canonical default working directory. */
  readonly root: string;
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
