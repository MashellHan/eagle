# Bots — pi-durable runtime mapping

Status: **phase 1 contract** for `apps/bots/src/runtime/pi/**`. Claims carry the
evidence that established them. Protocol shape is in
[PROTOCOL.md](PROTOCOL.md), layers in [ARCHITECTURE.md](ARCHITECTURE.md), logs in
[OBSERVABILITY.md](OBSERVABILITY.md).

The adapter owns a Harness per bot, translates its behaviour into `RuntimeEvent`,
classifies failures, and owns the submission ledger. It owns no catalog, no
transport and no `rev`.

## Verified facts

Established with `@earendil-works/pi-durable@1.4.0` on Node 26.12.0 unless the
evidence says upstream source. Probe scripts and inputs are listed in
[Evidence](#evidence) so each claim can be reproduced or narrowed.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | The generation task appends the assistant entry itself; `wait()` returns `answer` = that entry id. No host commit is needed | P1: `answer: 10`, entries `10:pi.assistant, 7:pi.user` |
| F2 | The README quick start's `tx.entry(AssistantEntry, answer)` is therefore redundant; `test/examples/13-chat.ts` plus F1 describe the real behaviour | P1 vs README |
| F3 | `message_end` fires for every appended entry, including the user entry; `message_start` precedes entries that were never streamed | P1: `message_start, message_end#7(pi.user), …, message_start, message_end#10(pi.assistant)` |
| F4 | `message_start` for the assistant carries the **full partial content so far**; `message_update` carries only relative changes | P3: `message_start` content `"alpha beta gamma delta epsilon zeta eta thet"` |
| F5 | `message_update` is **not guaranteed**: a fast provider produced none, and the recorded run had only `message_start` → `message_end` | P3: zero `message_update` events; P2 saw two |
| F6 | With an empty registry the transcript holds only `pi.user` and `pi.assistant`; no `pi.system` entry appears | P2 |
| F7 | `requestId` is idempotent: a repeated submit returns the same submission id, and a settled submission's record (entry + answer) without emitting new events | P4: `12 12 true`, record `status:"done"` |
| F8 | `watchEvents()` yields a `snapshot` at attach (`entries/tools/compactions/inbox/agent/usage`, plus the live partial) and then batches per commit; falling >100 batches behind yields a fresh snapshot | upstream `src/harness/events.ts`; P1 late join |
| F9 | A provider error settles `unanswered{reason:"model_error", detail:"<upstream text>"}` | P2 |
| F10 | `abort()` settles the running input `unanswered{reason:"aborted"}` **with** its `entry`, and every queued input `unanswered{reason:"aborted"}` **without** one; `inbox` empties | P4 |
| F11 | Submitting while busy queues into `pi.inbox` with `mode:"followUp"` | P4: `[{"id":10,"mode":"followUp"}]` |
| F12 | `Submission.status(context)` returns the current record; `harness.submission(id)` reacquires one by id | upstream `harness/types.d.ts` |
| F13 | `StopReason` is `pending \| stop \| length \| toolUse \| error \| aborted \| deferred` | upstream `pi-ai/dist/types.d.ts` |
| F14 | A storage error fails and closes the whole Harness (`SessionFailed`); reopening is the only recovery | upstream README "Errors" |
| F15 | A task cut off by crash/eviction/reset is counted; at `settings.restartLimit` (5) it is parked and reported through `onReport` as `task_parked` | upstream README "Crash loops" |
| F16 | Automatic compaction is a conversation-owned **background task** and is enabled by default | upstream README "Compaction" |
| F17 | A watch that ends resolves a `WatchEnd` rather than throwing; `harness.closed` reports harness end separately | upstream `chord` `WatchHandle`, README "Errors" |
| F18 | Progress commits are throttled by `settings.progress.partialIntervalMs` (default 100) | upstream README |
| F19 | `settings` are host-level and read at every use; only `pi.agent` is per conversation | upstream README |
| F20 | Sleeping tasks survive restarts, and the Node default timer keeps the process alive, so `onWake` is unnecessary in the daemon | upstream `spec §5.6` |
| F21 | Cold open 7 ms; reopen of 400 entries 3 ms; 20 bots open in 30 ms at 103 MB RSS; ≈2.4 KB storage per answered turn | P5 |

## Harness construction (per bot)

```ts
const harness = await Harness.open(
  await openNodeSqliteStorage(join(spec.dir, "session.sqlite")),
  {
    models,                   // one shared Models for the process
    registry,                 // empty in phase 1 (see "No tools")
    settings: perBotSettings(),  // fresh object per bot, never shared
    onReport: (error, info) => classifyReport(info),   // F15
  },
  BACKGROUND_CONTEXT,
);
harness.closed.then((end) => classifyClose(end));      // F14/F17
const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: spec.model } });
harness.resume();                                      // recovery, before serving
```

- `open()` performs recovery. The registry never calls `resume()` separately, so a
  run interrupted by a crash continues without an extra port operation.
- One `Models` and one `Registry` are shared process-wide (constructed once, no
  conversation state); everything else is per bot (F19).
- `root()` is idempotent: conversation `1` for a new storage, the same root after
  reopen.
- Phase 1 keeps exactly one conversation per bot and never calls
  `createConversation`, `fork` or subagent APIs.

## Event mapping

`mapEvents.ts` is pure and golden-tested. Adapter state per bot:

```
attempt: number            // increments per generation attempt (F13 retries)
provisional: { id, attempt } | null   // id = "p_a<attempt>"
```

| pi source | Adapter action | `RuntimeEvent` |
| --- | --- | --- |
| attach snapshot (F8) | Build the view; if a partial exists, include it as a provisional message with its current content | `subscribe()` result |
| `message_start` where `message.role === "assistant"` | Start an attempt if none is open; emit the provisional once, **with the content from F4**, `state:"streaming"` | `append` |
| `message_start` where `message.role === "user"` | Ignore (F3) | — |
| `message_update` | Apply every `MessageChange` losslessly and forward it (F4/F5) | `delta{messageId:"p_a<n>"}` |
| `message_start` for an assistant attempt that already has a provisional (retry inside the same turn) | Close the old provisional, start a new attempt id | `append{new p_a<n>}` |
| `message_end` with `entry.kind === "pi.assistant"` | Map the entry's message; final state from `stopReason` (F13) | `append{message, replaces: p_a<n>}` |
| `message_end` with `entry.kind === "pi.user"` | Map the user entry, including its `requestId` when known | `append` |
| `submission` | Map the record: status, `entryId`, `answerEntryId`, `reason` | `submission` |
| `inbox_update` | Map queue items | `status` |
| `run_start` / `run_end` | Mark running, clear the provisional at attempt end | `status` |
| `tool_execution_*` | Reserved (phase 2) | `delta{kind:"toolcall"}` / reserved blocks |
| `auto_retry_start` / `auto_retry_end` | Log `runtime.classify`; no wire event (the attempt id changes on the next `message_start`) | — |
| `task_failed` | Classify the task kind | `error{kind:"task_faulted"\|"task_parked", taskId}` |
| `onReport` (`task_parked`, `session_failed`, `extension_error`, …) (F15) | Dedupe by `(kind, taskId)` within 60 s, then classify | `error` |
| `harness.closed` (F14) | Classify `storage_failed`; mark the handle dead | `error{kind:"storage_failed"}` |
| watch end (F17) | Reattach once, then error | `snapshot` after reattach, or `error{kind:"internal"}` |
| watch falls behind → fresh `snapshot` (F8) | Reset provisional state from the snapshot | `snapshot` |

`MessageChange` must be applied without loss. The wire mirrors each kind
([PROTOCOL.md](PROTOCOL.md#server-events)):

| Change | Wire |
| --- | --- |
| `text_start` | nothing; the following deltas carry the text |
| `text_delta` | `{kind:"text", append}` |
| `thinking_start`, `thinking_delta` | `{kind:"thinking", append}` (reserved) |
| `toolcall_start`, `toolcall_delta` | `{kind:"toolcall", callId, path, append}` (reserved) |
| `block` | `{kind:"block", index, block}` — the whole block |
| `message` | `{kind:"message", message}` — whole replacement |

`stopReason` (F13) → `Message.state`:

| `stopReason` | `state` | Note |
| --- | --- | --- |
| `stop` | `complete` | Normal answer |
| `length` | `complete` | Truncated by the token limit; the client appends a notice |
| `toolUse` | `complete` | Phase 2 only; a tool round follows |
| `aborted` | `aborted` | User abort or shutdown |
| `error` | `error` | Upstream failure; reason text becomes a `notice`, never model context |
| `deferred` | `streaming` | Poll-based provider; the run stays active |
| `pending` | `streaming` | In-flight partial |

Because `message_update` is optional (F5), the adapter must never treat deltas as
the source of truth: the provisional content comes from `message_start`, and the
final `append` from the entry.

## Submission ledger

The adapter keeps `requestId → submissionId` in memory and answers from it:

- `submit(input)` calls `root.submit({type:"input", content, requestId})`, then
  `status(context)` (F12) and returns the record. A repeated `requestId` returns the
  existing record and emits **no** new events (F7), which is why the daemon replies
  with a connection-scoped `submission` frame itself.
- `submission(key)` resolves by either id for duplicate replies.
- The ledger is not persisted: pi-dedupes by `requestId` in storage, so a daemon
  restart plus a re-sent `send` still converges (F7).

`unanswered.reason` values the adapter can produce:

| `reason` | When |
| --- | --- |
| `model_error` | Provider/upstream failure (F9) |
| `aborted` | `abort()` or shutdown (F10) |
| `run_failed` | `settings.afterFailedRun = "withdraw"` — not used in phase 1 |
| `stale` | A compaction summary placed past the input — phase 1 has compaction off |
| `withdrawn` | A queued input removed by an explicit withdrawal other than abort |

## Settings per bot

| Setting | Value | Why |
| --- | --- | --- |
| `stream.timeoutMs` | 120 000 | A stalled provider must eventually fail the run |
| `retry.maxRetries` | 3 | 429/5xx are transient |
| `compaction.enabled` | **false** | F16: compaction is a background task, and phase 1 closes a bot on "no run, no task". Long chats fail with `model_error` and stay readable; enabling compaction is a phase-2 change that also has to extend the close condition and the `tasks` capability |
| `progress.partialIntervalMs` | 100 | Matches the protocol's 50 ms coalescing; local storage makes 100 cheap |
| `progress.outputIntervalMs` | 100 | Reserved (tool output) |
| `afterFailedRun` | `"continue"` | A failed run must not strand queued follow-ups |
| `restartLimit` | 5 (default) | Parked tasks surface as `task_parked` and are cleared by `recover` |
| `contextRetentionMs`, `documentRetentionMs` | 600 000 (default) | Idle close frees memory; defaults keep reopen cheap |

Each bot owns its settings object so one bot's policy cannot affect another
(F19).

## No tools (phase 1)

Phase 1 installs an empty registry and provides no `env`. A model that asks for a
tool receives an error result, the run continues, and nothing crashes.
`capabilities.tools` is `false`, so the client renders no tool UI.

## Reserved capability enable paths

"Reserved" means the wire can represent it and the client must ignore it while
disabled. It does **not** mean half-implemented behaviour. Each capability is its
own change set:

| Capability | Work required when enabling |
| --- | --- |
| `tools` | Install tool extensions; provide `env`; map `tool_execution_*` to `delta`/blocks; render approvals; flip the flag |
| `agent` | Add a `configure` command and a `CONNECT`-time model catalog endpoint; expose `RuntimeHandle.configure`; render the settings panel |
| `tasks` | Emit `task` events from `watchTaskGraph`; add a `retry` command; make the close condition task-aware |
| `entries` | Serve raw entries from `conversation.entries()` behind a paging command |
| `usage` | Populate `usage` in snapshots from `pi.usage` |
| `peers` | Bot-to-bot delivery as a tool or background task; a `peers` policy document |

None of them may change v1 semantics for existing fields.

## Recovery semantics

| Situation | pi behaviour | Adapter action |
| --- | --- | --- |
| Process killed mid-run | Committed entries survive; the generation task is still `running` on disk | `open()` resumes; the run continues from its checkpoint |
| Killed while a tool ran (phase 2) | Replayed only when `replay:"safe"`, else an `interrupted` error result | No adapter involvement |
| Crash loop ≥ `restartLimit` | Task parked, `onReport(task_parked)` (F15) | `error{kind:"task_parked"}`; `recover` retries it |
| Storage error | Harness closes itself (F14) | Classify `storage_failed`, mark the bot `unavailable`, serve a snapshot with `unavailable` |
| Watch ends (F17) | `WatchEnd` reason `listener_error`/`failed` | Reattach with a fresh snapshot; escalate to `internal` after three failures in 60 s |
| `close()` stalls on non-cooperative code | `close()` joins invocations | `close` resolves `timeout`; the registry quarantines the bot and retries; it is never dropped |
| Reopen after idle close | No state lost | New snapshot; the client replaces its view |

## Pitfalls

1. Do not commit the answer entry (F1/F2).
2. Do not map `message_start`/`message_end` literally (F3): ignore user-role
   `message_start`.
3. Do not build the provisional from empty blocks (F4): it carries real content.
4. Do not rely on `message_update` (F5): a run can arrive with zero deltas.
5. Do not key deltas on the pi-ai message (deltas have no entry id): use the
   attempt-scoped provisional id.
6. Do not assume a `pi.system` entry exists (F6).
7. Never open one bot twice (F19, no cross-process locking).
8. Do not synthesize `unanswered` from a thrown command (F7/F12): only a stored
   record settles an input. `abort` settles with `reason:"aborted"` (F10), which is
   not a model failure.
9. A lost acknowledgement is not a failure: re-send the same `requestId` and read
   the returned record (F7).
10. Do not close a bot on "no run" alone once compaction or tools exist (F16).
11. A watch that falls behind delivers a snapshot; reset provisional state or the
    next deltas target a message the client dropped (F8).

## Evidence

| Probe | Input | Establishes |
| --- | --- | --- |
| P1 | `fauxProvider`, one turn, no host commit; print `wait()` result and entry kinds | F1, F2, F3 |
| P2 | Same plus `watchEvents` collection; 1 scripted answer, then a provider error, then abort | F5 (two deltas seen), F6, F9 |
| P3 | `tokensPerSecond:120, tokenSize:2..3`, answer `"alpha beta … theta"`; capture `message_start` content and every `message_update` | F4, and F5 (no deltas in this run) |
| P4 | Hanging response, queued follow-up, `abort()`; then duplicate `requestId` submits | F7, F10, F11 |
| P5 | One bot: 200 turns with a 456-character answer and a ~140-character prompt; then reopen immediately after close, then 20 bots opened in one process | F21 |

Scope notes: F21's reopen was measured immediately after close (warm page cache)
and in `/tmp`; the numbers prove order of magnitude, not a percentile. Threads and
process count were not varied. Real-model latency is network latency and is
excluded from every number here.

## Upgrade procedure

1. Bump the exact pin in `apps/bots/package.json`; install.
2. Run `npm run test:runtime` and `npm run test:protocol`; the `mapEvents` golden
   sequence is the early-warning signal.
3. Read the upstream diff for `docs/spec.md` §2.1 (context), §5.6 (wakeups), §8.2
   (`pi.live`), §9.3–9.4 (views, agent events) and `CHANGELOG.md`.
4. Update the fact table if any of F1–F21 changed; the pin bump commit names the
   facts that changed.
