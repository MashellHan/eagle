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

/** One trigger as a tool sees it: the daemon owns the storage, the tool owns the surface. */
export type TriggerView = {
  readonly id: string;
  readonly kind: "schedule" | "webhook";
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly schedule?: {
    readonly cron: string;
    readonly timezone: string;
    readonly cursor?: string;
  };
  readonly counters: { readonly fired: number; readonly dropped: number; readonly refused: number };
  readonly lastFiredAt?: string;
  readonly lastSkipped?: { readonly at: string; readonly reason: string };
};

/**
 * What the trigger tools may do to their own Bot's definitions. Every mutation carries the
 * durable tool-task id as its operation id, so a replayed call returns the recorded result
 * instead of acting twice (docs/bots/TRIGGERS.md §7). The host is bound per Bot.
 */
export type TriggerToolHost = {
  readonly botId: string;
  create(input: {
    readonly opId: string;
    readonly kind: "schedule" | "webhook";
    readonly name: string;
    readonly prompt: string;
    readonly cron?: string;
    readonly timezone?: string;
  }): Promise<{ readonly trigger: TriggerView; readonly created: boolean }>;
  list(): Promise<readonly TriggerView[]>;
  update(input: {
    readonly opId: string;
    readonly triggerId: string;
    readonly name?: string;
    readonly prompt?: string;
  }): Promise<TriggerView>;
  enable(input: {
    readonly opId: string;
    readonly triggerId: string;
    readonly enabled: boolean;
  }): Promise<TriggerView>;
  remove(input: {
    readonly opId: string;
    readonly triggerId: string;
  }): Promise<{ readonly triggerId: string }>;
  /** Where a webhook delivers to, without the credential the app keeps. */
  endpoint(triggerId: string): string;
};
