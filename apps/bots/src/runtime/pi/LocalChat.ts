import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

// Native local chat routing; optional history transport is not involved in open or submit.
export const LocalChatSelection = defineDoc({
  kind: "bots.chat.selection",
  version: 1,
  scope: "session",
  initial: () => ({ conversationId: 0 }),
  checkpointWhen: () => true,
});
export const LocalChatRequest = defineDocFamily({
  kind: "bots.chat.request",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ conversationId: 0 }),
  checkpointWhen: () => true,
});
