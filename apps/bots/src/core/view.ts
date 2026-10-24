// The projected conversation view: a pure fold of runtime events into a snapshot
// (docs/bots/PROTOCOL.md, "Subscription"). Both the daemon's service and the fake
// runtime render from it, so a late joiner and a replayed client agree on content.
import type { ConversationSnapshot, DeltaChange, Message } from "./domain.ts";
import type { RuntimeEvent } from "./RuntimePort.ts";

/** Applies one runtime event to the view. Snapshots replace it wholesale. */
export const reduceView = (
  view: ConversationSnapshot,
  event: RuntimeEvent,
): ConversationSnapshot => {
  if (event.type === "append") {
    const messages = upsert(view.messages, event.message, event.replaces);
    // A provisional becomes the streaming target; anything that supersedes it clears
    // the pointer, so a late joiner sees the real attempt state.
    let streaming = view.streaming;
    if (event.message.state === "streaming") streaming = event.message.id;
    else if (streaming === event.message.id || streaming === event.replaces) streaming = null;
    return { ...view, messages, streaming };
  }
  if (event.type === "delta") {
    return {
      ...view,
      messages: view.messages.map((message) =>
        message.id === event.messageId ? applyChanges(message, event.changes) : message,
      ),
    };
  }
  if (event.type === "status") {
    return { ...view, running: event.running, streaming: event.streaming, inbox: event.inbox };
  }
  if (event.type === "submission") {
    const settled = event.record.status === "done" || event.record.status === "unanswered";
    return {
      ...view,
      pending: view.pending
        .filter((record) => record.id !== event.record.id)
        .concat(settled ? [] : [event.record]),
    };
  }
  if (event.type === "snapshot") return event.value;
  return view;
};

/** Applies delta changes in order: a message replacement swaps the working message. */
export const applyChanges = (message: Message, changes: readonly DeltaChange[]): Message => {
  let current = message;
  let blocks = [...current.blocks];
  for (const change of changes) {
    if (change.kind === "message") {
      current = change.message;
      blocks = [...current.blocks];
      continue;
    }
    if (change.kind === "block") {
      blocks[change.index] = change.block;
      continue;
    }
    const block = blocks[change.index];
    if (block === undefined) continue;
    if (
      (change.kind === "text" && block.type === "text") ||
      (change.kind === "thinking" && block.type === "thinking")
    ) {
      blocks[change.index] = { ...block, text: block.text + change.append };
      continue;
    }
    if (change.kind === "toolcall" && block.type === "toolCall") {
      const call = structuredClone(block);
      appendAtPath(call, change.path, change.append);
      blocks[change.index] = call;
    }
  }
  return { ...current, blocks };
};

/** A toolcall path is rooted at the block: `["args","q"]` appends to `block.args.q`. */
const appendAtPath = (root: object, path: readonly (string | number)[], append: string): void => {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") return;
    node = next as Record<string | number, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  const prior = node[leaf];
  node[leaf] = `${typeof prior === "string" ? prior : ""}${append}`;
};

/** Replaces a provisional by id, or upserts the message by its own id. */
export const upsert = (
  messages: readonly Message[],
  message: Message,
  replaces?: string,
): Message[] => {
  const next = [...messages];
  const replaced = replaces === undefined ? -1 : next.findIndex((item) => item.id === replaces);
  const existing = next.findIndex((item) => item.id === message.id);
  const target = replaced >= 0 ? replaced : existing;
  if (target >= 0) next[target] = message;
  else next.push(message);
  return next;
};

/** Merges a window into a known sequence, keeping the order the two already imply. */
export const mergeOrdered = (
  known: readonly Message[],
  incoming: readonly Message[],
): Message[] => {
  const merged = [...known];
  for (let index = 0; index < incoming.length; index += 1) {
    const message = incoming[index];
    if (message === undefined) continue;
    const existing = merged.findIndex((item) => item.id === message.id);
    if (existing >= 0) {
      merged[existing] = message;
      continue;
    }
    let insertAt = merged.length;
    for (let later = index + 1; later < incoming.length; later += 1) {
      const following = incoming[later];
      const at =
        following === undefined ? -1 : merged.findIndex((item) => item.id === following.id);
      if (at >= 0) {
        insertAt = at;
        break;
      }
    }
    merged.splice(insertAt, 0, message);
  }
  return merged;
};
