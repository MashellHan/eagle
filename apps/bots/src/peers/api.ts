// The app's read side of an exchange (docs/bots/TRIGGERS.md §10): a bot's exchanges, and one
// exchange's messages with each recipient's answer. Owner-scoped: a bot only ever reads exchanges
// it takes part in, and an answer is filled in from the recipient's own submission.

import type { BotSummary, Submission } from "../core/domain.ts";
import type { PeerExchange, PeerExchangeStore } from "../core/PeerExchangeStore.ts";
import type { PeerApi } from "../server/http.ts";

export type PeerApiDeps = {
  readonly store: PeerExchangeStore;
  readonly bots: () => readonly BotSummary[];
  readonly submission: (query: {
    readonly botId: string;
    readonly requestId: string;
  }) => Promise<Submission | undefined>;
  readonly entryText: (botId: string, entryId: string) => Promise<string | undefined>;
};

type Participant = { readonly id: string; readonly title: string };

const participantsOf = (deps: PeerApiDeps, exchange: PeerExchange): readonly Participant[] =>
  exchange.participants.map((id) => ({
    id,
    title: deps.bots().find((bot) => bot.id === id)?.title ?? id,
  }));

const latest = (exchange: PeerExchange): string => {
  let at = exchange.startedAt;
  for (const turn of exchange.turns) {
    if (turn.at > at) at = turn.at;
    if (turn.answeredAt !== undefined && turn.answeredAt > at) at = turn.answeredAt;
  }
  return at;
};

const countOf = (exchange: PeerExchange): number =>
  exchange.turns.reduce((total, turn) => total + (turn.answer === undefined ? 1 : 2), 0);

export const peerApi = (deps: PeerApiDeps): PeerApi => ({
  /** Newest first: the sidebar row and the transcript fold both read this list. */
  list: async (botId) => {
    const exchanges = (await deps.store.list()).filter((exchange) =>
      exchange.participants.includes(botId),
    );
    return exchanges.map((exchange) => ({
      id: exchange.id,
      participants: participantsOf(deps, exchange),
      count: countOf(exchange),
      status: exchange.status,
      startedAt: exchange.startedAt,
      // Where the exchange last moved: the transcript keeps its row there, so a round trip
      // shows up next to the turn that just happened rather than at its first message. A read
      // answer counts, otherwise the row would sit beside the question while the reply existed.
      updatedAt: latest(exchange),
    }));
  },

  detail: async (botId, exchangeId) => {
    const exchange = await deps.store.get(exchangeId);
    if (exchange === undefined || !exchange.participants.includes(botId)) return undefined;
    const turns = [];
    for (const turn of exchange.turns) {
      // An answer is read from the recipient's own run, and kept: the record is the transcript.
      let answer = turn.answer;
      if (answer === undefined) {
        answer = await answerOf(deps, turn.toBotId, turn.requestId);
        if (answer !== undefined) await deps.store.answer(exchange.id, turn.requestId, answer);
      }
      turns.push({
        requestId: turn.requestId,
        fromBotId: turn.fromBotId,
        toBotId: turn.toBotId,
        at: turn.at,
        // A record written before turns kept their text answers with an empty message rather
        // than failing the whole read.
        text: turn.message ?? "",
        ...(answer === undefined ? {} : { answer }),
      });
    }
    return {
      id: exchange.id,
      participants: participantsOf(deps, exchange),
      status: exchange.status,
      ...(exchange.finishedReason === undefined ? {} : { finishedReason: exchange.finishedReason }),
      startedAt: exchange.startedAt,
      turns,
    };
  },
});

/** The recipient's answer text, when its run has one. */
export const answerOf = async (
  deps: Pick<PeerApiDeps, "submission" | "entryText">,
  botId: string,
  requestId: string,
): Promise<string | undefined> => {
  const submission = await deps.submission({ botId, requestId });
  if (submission?.answerEntryId === undefined) return undefined;
  return deps.entryText(botId, submission.answerEntryId);
};
