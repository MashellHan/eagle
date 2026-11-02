import { defineDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";

const admissions = new WeakMap<Harness, Map<string, Promise<void>>>();

// SDK dedup is per conversation; serialize local admission before choosing one.
export async function withLocalChatAdmission<T>(
  harness: Harness,
  requestId: string,
  admit: () => Promise<T>,
): Promise<T> {
  let pending = admissions.get(harness);
  if (!pending) {
    pending = new Map();
    admissions.set(harness, pending);
  }
  const previous = pending.get(requestId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.set(requestId, current);
  await previous;
  try {
    return await admit();
  } finally {
    if (pending.get(requestId) === current) pending.delete(requestId);
    release();
  }
}

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
