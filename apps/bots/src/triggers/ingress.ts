// The inbound side of a webhook trigger (docs/bots/TRIGGERS.md §9.2): authenticate the
// trigger's own bearer, dedupe a retry, enqueue one item, and let the pump decide when it
// becomes a turn. Nothing here runs a model; a delivery only ever becomes queue state.
import { createHash } from "node:crypto";
import type { TriggerSecretStore } from "../core/TriggerSecrets.ts";
import type { TriggerStore } from "../core/TriggerStore.ts";
import type { IngressOutcome, TriggerIngress } from "../server/http.ts";
import { MAX_QUEUE_ITEMS, type TriggerQueue } from "./queue.ts";

/** Mirrors `protocol/limits.ts#MAX_SEND_TEXT`; a delivery is one user input. */
const MAX_DELIVERY_TEXT = 8_000;
const MAX_IDEMPOTENCY_KEY = 200;

/** A delivery's text: JSON `{ text }`, or the raw body; empty is refused, not sent. */
export const deliveryText = (body: Buffer, contentType: string | undefined): string | undefined => {
  const raw = body.toString("utf8");
  let text = raw;
  if (contentType?.includes("application/json") === true) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "string") text = parsed;
      else if (typeof parsed === "object" && parsed !== null) {
        const value = (parsed as { text?: unknown }).text;
        if (typeof value !== "string") return undefined;
        text = value;
      } else {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  if (text.trim().length === 0) return undefined;
  const points = Array.from(text);
  return points.length > MAX_DELIVERY_TEXT
    ? `${points.slice(0, MAX_DELIVERY_TEXT).join("")}…[truncated]`
    : text;
};

export type IngressWiring = {
  readonly storeFor: (botId: string) => Promise<TriggerStore>;
  readonly secretsFor: (botId: string) => Promise<TriggerSecretStore>;
  readonly queueFor: (botId: string, triggerId: string) => Promise<TriggerQueue>;
  /** Asks the pump to consider the new item; the delivery never waits for a run. */
  readonly drain: (botId: string) => void;
  readonly now: () => Date;
  /** Counters are the trigger's own history; recording them never blocks a delivery. */
  readonly count: (
    botId: string,
    triggerId: string,
    delta: { readonly fired?: number; readonly dropped?: number; readonly refused?: number },
  ) => void;
};

export const createIngress = (wiring: IngressWiring): TriggerIngress => ({
  deliver: async (input): Promise<IngressOutcome> => {
    const store = await wiring.storeFor(input.botId);
    const trigger = store.get(input.triggerId);
    if (trigger === undefined || trigger.kind !== "webhook") return { kind: "unknown" };
    const secrets = await wiring.secretsFor(input.botId);
    if (!secrets.matches(input.triggerId, input.token)) return { kind: "unknown" };
    if (!trigger.enabled) {
      wiring.count(input.botId, input.triggerId, { refused: 1 });
      return { kind: "disabled" };
    }

    const queue = await wiring.queueFor(input.botId, input.triggerId);
    // The queue never evicts to admit a burst: a producer sees 429 and retries itself.
    if (queue.items().length >= MAX_QUEUE_ITEMS) {
      wiring.count(input.botId, input.triggerId, { refused: 1 });
      return { kind: "queue_full" };
    }
    const text = deliveryText(input.body, input.contentType);
    if (text === undefined) {
      wiring.count(input.botId, input.triggerId, { refused: 1 });
      return { kind: "invalid", message: "text is required" };
    }

    // A producer's own key, or the body itself: an at-least-once sender never double-queues.
    const key = input.idempotencyKey;
    const itemId =
      key !== undefined && key.length > 0 && key.length <= MAX_IDEMPOTENCY_KEY
        ? `d_${key}`
        : `d_${createHash("sha256")
            .update(input.body)
            .update(input.contentType ?? "")
            .digest("hex")
            .slice(0, 16)}`;
    const result = await queue.enqueue({
      itemId,
      text,
      receivedAt: wiring.now().toISOString(),
    });
    if (!result.accepted) return { kind: "queued", queued: 0, dropped: 0 };
    wiring.count(input.botId, input.triggerId, {
      fired: 1,
      ...(result.dropped > 0 ? { dropped: result.dropped } : {}),
    });
    wiring.drain(input.botId);
    return { kind: "queued", queued: 1, dropped: result.dropped };
  },
});
