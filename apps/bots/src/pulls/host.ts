// The bridge between a Bot's stored pull requests and the tools that report them
// (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group). Composition only: the store owns
// durability, the tool layer owns the model-facing surface.
import { type Pull, PullStore, pullJournalPath } from "../core/PullStore.ts";
import type { RuntimeBotSpec } from "../core/RuntimePort.ts";
import type { PullToolHost, PullView } from "../tools/types.ts";

const view = (pull: Pull): PullView => ({
  url: pull.url,
  title: pull.title,
  status: pull.status,
  host: pull.host,
  updatedAt: pull.updatedAt,
});

export const pullHostFor = (botId: string, store: PullStore): PullToolHost => ({
  botId,
  register: async (input) => {
    const { pull, created } = await store.upsert(input);
    return { pull: view(pull), created };
  },
  list: async () => store.list().map(view),
});

/**
 * The daemon's pull-request composition: one journal per bot, opened on demand, and the two
 * entry points the composition root hands to the runtime and the service. Both live here so a
 * test can drive them without booting a daemon.
 */
export type PullPublisher = {
  readonly publish: (botId: string, pulls: readonly Pull[]) => void;
  set(fn: ((botId: string, pulls: readonly Pull[]) => void) | undefined): void;
};

/**
 * A sink the composition root fills once the service exists. It lets the store be created
 * before the runtime without a closure of its own in that root.
 */
export const pullPublisher = (): PullPublisher => {
  let target: ((botId: string, pulls: readonly Pull[]) => void) | undefined;
  return {
    publish: (botId, pulls) => target?.(botId, pulls),
    set: (fn) => {
      target = fn;
    },
  };
};

export const composePulls = (deps: {
  readonly botDir: (botId: string) => string;
  /** Told whenever a bot's list changes, so an open view follows the report. */
  readonly publish: PullPublisher;
}): {
  readonly runtimeHost: (spec: RuntimeBotSpec) => Promise<PullToolHost>;
  readonly list: (botId: string) => Promise<readonly PullView[]>;
} => {
  const stores = new Map<string, Promise<PullStore>>();
  const storeFor = (botId: string): Promise<PullStore> => {
    const open = stores.get(botId);
    if (open !== undefined) return open;
    const opened = PullStore.open(pullJournalPath(deps.botDir(botId)), {
      onChange: (pulls) => deps.publish.publish(botId, pulls),
    });
    stores.set(botId, opened);
    opened.catch(() => stores.delete(botId));
    return opened;
  };
  return {
    runtimeHost: async (spec) => pullHostFor(spec.id, await storeFor(spec.id)),
    list: async (botId) => (await storeFor(botId)).list().map(view),
  };
};
