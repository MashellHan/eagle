// The bridge between an exchange record and the two bots that take part in it (TRIGGERS.md §10).
// Composition only: the store owns durability and the budget, the invocation port owns admission,
// the tools own the model-facing surface.
import { createHash } from "node:crypto";
import type { BotSummary, Submission, SubmissionStatus } from "../core/domain.ts";
import { type Invocation, MAX_INVOCATION_TEXT } from "../core/Invocation.ts";
import { PEER_MAX_TURNS, type PeerExchange, PeerExchangeStore } from "../core/PeerExchangeStore.ts";
import {
  type PeerListing,
  type PeerReadResult,
  type PeerToolHost,
  ToolError,
} from "../tools/types.ts";

/** `pr_<16 hex>` of the sender, the recipient and the durable tool task (TRIGGERS.md §3.2). */
export const peerRequestId = (fromBotId: string, toBotId: string, taskId: string): string =>
  `pr_${createHash("sha256").update(`${fromBotId}‖${toBotId}‖${taskId}`).digest("hex").slice(0, 16)}`;

export type PeerHostDeps = {
  readonly botId: string;
  readonly store: PeerExchangeStore;
  /** Every bot the catalog lists, so a recipient is resolved by id, never by a name. */
  readonly bots: () => readonly BotSummary[];
  readonly invoke: (input: Invocation) => Promise<Submission>;
  readonly submission: (query: {
    readonly botId: string;
    readonly requestId: string;
  }) => Promise<Submission | undefined>;
  /** One message's text, for the recipient's answer; absent when the bot is not open. */
  readonly entryText: (botId: string, entryId: string) => Promise<string | undefined>;
};

const availabilityOf = (bot: BotSummary): PeerListing["availability"] => {
  if (bot.unavailable !== undefined) return "unavailable";
  if (bot.state === "running") return "working";
  return "idle";
};

/** A recipient that is gone is a refusal with a reason, never a message into the void. */
const recipientOf = (deps: PeerHostDeps, botId: string): BotSummary => {
  if (botId === deps.botId) throw new ToolError("you cannot message yourself");
  const found = deps.bots().find((bot) => bot.id === botId);
  if (found === undefined) {
    throw new ToolError(`no bot with id ${botId}; use peer_list to find a real one`);
  }
  if (found.unavailable !== undefined) {
    throw new ToolError(`bot ${botId} is unavailable: ${found.unavailable.message}`);
  }
  return found;
};

const budgetOf = (exchange: PeerExchange, botId: string) =>
  PEER_MAX_TURNS - PeerExchangeStore.countIn(exchange, botId);

const describe = (status: Submission | undefined): SubmissionStatus | "unknown" =>
  status === undefined ? "unknown" : status.status;

export const peerHostFor = (deps: PeerHostDeps): PeerToolHost => ({
  botId: deps.botId,
  maxMessage: MAX_INVOCATION_TEXT,

  list: async ({ query, cursor, limit }) => {
    const needle = query?.trim().toLowerCase() ?? "";
    const items = deps
      .bots()
      .filter((bot) => bot.id !== deps.botId)
      .filter((bot) => needle === "" || bot.title.toLowerCase().includes(needle))
      .map((bot) => ({ botId: bot.id, title: bot.title, availability: availabilityOf(bot) }));
    // The cursor is the last id of the previous page: ids are stable, positions are not.
    const start =
      cursor === undefined ? 0 : Math.max(0, items.findIndex((i) => i.botId === cursor) + 1);
    const page = items.slice(start, start + limit);
    const next = start + limit < items.length ? items[start + limit - 1]?.botId : undefined;
    return { items: page, ...(next === undefined ? {} : { nextCursor: next }) };
  },

  send: async ({ taskId, toBotId, message }) => {
    const recipient = recipientOf(deps, toBotId);
    const requestId = peerRequestId(deps.botId, recipient.id, taskId);

    // A retry of the same tool task never becomes a second message.
    const recorded = await deps.store.byRequest(requestId);
    // A retry continues the exchange its receipt names; a new message continues this pair's open
    // exchange, or starts one. A finished exchange is history and is never reopened.
    const existingId =
      recorded?.exchangeId ?? (await deps.store.between(deps.botId, recipient.id))?.id;
    const known = existingId === undefined ? undefined : await deps.store.get(existingId);
    const exchange =
      known ?? (await deps.store.create([deps.botId, recipient.id] as readonly [string, string]));

    if (exchange.status === "finished") {
      throw new ToolError(
        `this exchange is closed after ${PEER_MAX_TURNS} messages each; start a new task instead of replying`,
      );
    }
    if (budgetOf(exchange, deps.botId) <= 0) {
      throw new ToolError(
        `you have already sent ${PEER_MAX_TURNS} messages in this exchange; it is time to stop`,
      );
    }

    const turn = {
      fromBotId: deps.botId,
      toBotId: recipient.id,
      requestId,
      message,
    };
    // The receipt is durable before admission: a crash in between leaves a recoverable record,
    // never a message the sender cannot name (TRIGGERS.md §10, "lost acknowledgement").
    const { exchange: appended } = await deps.store.append(exchange.id, turn);
    // The label is the sender's own name: it is what the recipient's transcript shows a
    // person, and it survives a restart with the origin sidecar.
    const self = deps.bots().find((bot) => bot.id === deps.botId);
    const submission = await deps.invoke({
      botId: recipient.id,
      requestId,
      text: message,
      origin: {
        kind: "peer",
        fromBotId: deps.botId,
        exchangeId: appended.id,
        ...(self === undefined ? {} : { label: self.title }),
      },
      whenBusy: "followUp",
      trace: `tr_peer_${requestId.slice(3, 11)}`,
    });

    const sent = PeerExchangeStore.countIn(appended, deps.botId);
    return {
      toBotId: recipient.id,
      requestId,
      status: submission.status,
      exchangeId: appended.id,
      sent,
      remaining: Math.max(0, PEER_MAX_TURNS - sent),
      exchangeStatus: appended.status,
    };
  },

  read: async ({ requestId }) => {
    const receipt = await deps.store.byRequest(requestId);
    if (receipt === undefined) {
      throw new ToolError(`no message of yours has requestId ${requestId}`);
    }
    // Ownership comes from the receipt journal keyed by this bot, never from a transcript scan.
    if (receipt.turn.fromBotId !== deps.botId) {
      throw new ToolError(`requestId ${requestId} was not sent by you`);
    }
    const submission = await deps.submission({
      botId: receipt.turn.toBotId,
      requestId,
    });
    if (submission === undefined) {
      return { requestId, toBotId: receipt.turn.toBotId, status: "unknown" };
    }
    const base: PeerReadResult = {
      requestId,
      toBotId: receipt.turn.toBotId,
      status: describe(submission),
      ...(submission.reason === undefined ? {} : { reason: submission.reason }),
    };
    if (submission.answerEntryId === undefined) return base;
    const answer = await deps.entryText(receipt.turn.toBotId, submission.answerEntryId);
    if (answer === undefined) return base;
    // The record keeps the answer, so the app reads the whole exchange once.
    await deps.store.answer(receipt.exchangeId, requestId, answer);
    return { ...base, answer };
  },

  receipts: async ({ toBotId, limit }) => {
    const receipts = await deps.store.receipts(deps.botId, limit);
    const filtered =
      toBotId === undefined ? receipts : receipts.filter((item) => item.turn.toBotId === toBotId);
    const views = [];
    for (const receipt of filtered) {
      const submission = await deps.submission({
        botId: receipt.turn.toBotId,
        requestId: receipt.turn.requestId,
      });
      views.push({
        requestId: receipt.turn.requestId,
        toBotId: receipt.turn.toBotId,
        at: receipt.turn.at,
        status: describe(submission),
      });
    }
    return views;
  },
});
