// The projected conversation view: a pure fold of runtime events into a snapshot
// (docs/bots/PROTOCOL.md, "Subscription"). Both the daemon's service and the fake
// runtime render from it, so a late joiner and a replayed client agree on content.
import type {
  ConversationSnapshot,
  DeltaChange,
  Message,
  Submission,
  SubmissionStatus,
} from "./domain.ts";
import type { RuntimeEvent } from "./RuntimePort.ts";

/** Ranked so a late record can never downgrade a settlement (PROTOCOL I14). */
export const statusRank = (status: SubmissionStatus): number => RANK[status];

const RANK: Record<SubmissionStatus, number> = {
  queued: 0,
  placed: 1,
  done: 2,
  unanswered: 2,
};

/**
 * The highest-ranked record seen per submission, across snapshots. A fold keeps it
 * because a settled record leaves `pending`, and a stale duplicate must not resurrect
 * or downgrade it.
 */
export type SubmissionRanks = Map<string, Submission>;

/** Seeds the ranks from a snapshot's records without ever downgrading a known one. */
export const seedRanks = (ranks: SubmissionRanks, records: readonly Submission[]): void => {
  for (const record of records) {
    const known = ranks.get(record.id);
    if (known === undefined || RANK[record.status] > RANK[known.status]) {
      ranks.set(record.id, record);
    }
  }
};

/** A snapshot may be older than what this bot already applied; normalize its pending. */
const normalizePending = (
  ranks: SubmissionRanks,
  pending: readonly Submission[],
): readonly Submission[] => {
  let changed = false;
  const normalized: Submission[] = [];
  for (const record of pending) {
    const known = ranks.get(record.id);
    if (known === undefined || RANK[known.status] <= RANK[record.status]) {
      normalized.push(record);
      continue;
    }
    changed = true;
    const settled = known.status === "done" || known.status === "unanswered";
    if (!settled) normalized.push(known);
  }
  return changed ? normalized : pending;
};

/** Applies one runtime event to the view. Snapshots replace it wholesale. */
export const reduceView = (
  view: ConversationSnapshot,
  event: RuntimeEvent,
  ranks: SubmissionRanks,
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
    const record = event.record;
    const known = ranks.get(record.id);
    if (known !== undefined && RANK[known.status] > RANK[record.status]) {
      // A ranked-lower duplicate: the client ranks for itself, but the daemon view must
      // not show settled work as queued again.
      return view;
    }
    ranks.set(record.id, record);
    const settled = record.status === "done" || record.status === "unanswered";
    return {
      ...view,
      // The user entry is appended before its submission is known, so this is where the
      // message learns the send that produced it (PROTOCOL, `Message.requestId`).
      messages: attachRequestId(view.messages, record),
      pending: view.pending
        .filter((known) => known.id !== record.id)
        .concat(settled ? [] : [record]),
    };
  }
  if (event.type === "snapshot") {
    seedRanks(ranks, event.value.pending);
    const pending = normalizePending(ranks, event.value.pending);
    return pending === event.value.pending ? event.value : { ...event.value, pending };
  }
  return view;
};

/** Gives the placed user entry the request id its submission names, once. */
const attachRequestId = (messages: readonly Message[], record: Submission): readonly Message[] => {
  if (record.entryId === undefined) return messages;
  const index = messages.findIndex((message) => message.id === record.entryId);
  const message = index < 0 ? undefined : messages[index];
  if (message === undefined || message.requestId !== undefined) return messages;
  const patched = [...messages];
  patched[index] = { ...message, requestId: record.requestId };
  return patched;
};

/**
 * Keeps the newest page and remembers what fell out, so a snapshot stays inside the
 * documented page and `truncatedBefore` still points at the oldest dropped entry
 * (PROTOCOL.md, "snapshot.messages page").
 */
export const trimWindow = (
  view: ConversationSnapshot,
  window: number,
  measure: (message: ConversationSnapshot["messages"][number]) => number,
  maxBytes = Number.POSITIVE_INFINITY,
): ConversationSnapshot => {
  if (view.messages.length === 0) return view;
  // The count is a budget and so are the encoded bytes: a page of legal 70 KiB messages
  // must still fit the frame the client is promised.
  let keep = 0;
  let bytes = 0;
  for (let index = view.messages.length - 1; index >= 0; index -= 1) {
    const message = view.messages[index];
    if (message === undefined) break;
    const size = measure(message);
    if (keep + 1 > window || bytes + size > maxBytes) break;
    bytes += size;
    keep += 1;
  }
  if (keep === view.messages.length) return view;
  const dropped = view.messages.slice(0, view.messages.length - keep);
  const first = dropped.find((message) => message.id.startsWith("e_"));
  return {
    ...view,
    messages: view.messages.slice(view.messages.length - keep),
    ...(view.truncatedBefore !== undefined || first === undefined
      ? {}
      : { truncatedBefore: first.id }),
  };
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
