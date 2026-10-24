# Bots — pi-durable runtime mapping

Status: **phase 1 contract** for `apps/bots/src/runtime/pi/**`. Anything here is
verified against `@earendil-works/pi-durable@1.4.0`; claims carry the evidence
that established them. Protocol shape is in [PROTOCOL.md](PROTOCOL.md), layers in
[ARCHITECTURE.md](ARCHITECTURE.md), logs in
[OBSERVABILITY.md](OBSERVABILITY.md).

The adapter's only job: own a Harness per bot, translate its behaviour into
`RuntimeEvent`, and classify failures. It owns no catalog, no transport and no
`rev`.

## Verified facts this design depends on

Measured with `fauxProvider()` on Node 26.12.0, `pi-durable@1.4.0`, unless the
evidence column names upstream source instead.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | The built-in generation task **already appends** the assistant entry. `submission.wait()` returns `answer` = that entry's id. No host commit is needed. | Probe: `answer: 10`, entries `10:pi.assistant, 7:pi.user` |
| F2 | The README quick start's `root.commit(tx => tx.entry(AssistantEntry, answered.answer))` is therefore redundant; the real behaviour is `test/examples/13-chat.ts` + F1. | Probe above vs README snippet |
| F3 | `message_end` fires for **every** appended entry, including the user entry, and `message_start` precedes entries that were not streamed. Mapping these literally produces phantom messages. | Probe events: `message_start, message_end#7(pi.user), submission, run_start, turn_start, message_start, message_end#10(pi.assistant), turn_end, run_end, submission, usage_changed` |
| F4 | `message_update` carries `changes` (text/thinking/toolcall deltas) but **no entry id**; there is nothing to key deltas on. | `src/harness/events.ts` `MessageChange` |
| F5 | With an empty registry the transcript holds only `pi.user` and `pi.assistant`; no `pi.system` entry appears. | Probe: entries `pi.user, pi.assistant` |
| F6 | `requestId` is idempotent: the second submit with the same id returns the same submission. | Probe: `idempotent: true 12 12` |
| F7 | `watchEvents()` gives a `snapshot` at attach with `entries/tools/compactions/inbox/agent/usage` (and `generation.message` when a run is live), then batches per commit. Falling >100 batches behind yields a fresh snapshot. | Probe: late-join snapshot; `src/harness/events.ts` |
| F8 | A provider error settles the input as `unanswered` with `reason: "model_error"` and `detail: "<provider message>"`. | Probe: `{"status":"unanswered","reason":"model_error","detail":"provider exploded"}` |
| F9 | `root.abort()` resolves when the conversation is idle; `snapshot.run` becomes null; queued inputs are withdrawn, queued writes are not. | Probe: `running after abort: null` |
| F10 | Submitting while busy queues into `pi.inbox` with `mode: "followUp"` by default. | Probe: `inbox: [{"id":22,"mode":"followUp"}]` |
| F11 | A storage error fails and closes the whole Harness (`SessionFailed`); reopening is the only recovery. | `README` "Errors" rule 1 |
| F12 | A task cut off by a crash/eviction/reset is counted; at `settings.restartLimit` (default 5) it is parked and reported as `task_parked`. | `README` "Crash loops" |
| F13 | Progress commits are throttled by `settings.progress.partialIntervalMs` (default 100). | `README` "Watching a Conversation" |
| F14 | `settings` are host-level and read at every use; only `pi.agent` is per conversation. Therefore per-bot policy requires per-bot Harness. | `README` "Settings" / "Per-Conversation Agent" |
| F15 | Sleeping tasks survive restarts; the Node default timer keeps the process alive, so `onWake` is unnecessary in the daemon. | `spec §5.6` |
| F16 | Cold open is 7 ms, reopen of 400 entries is 3 ms, 20 bots open in 30 ms at 103 MB RSS. | `/tmp` spike, see [PRODUCT.md](PRODUCT.md#speed-targets) |

## Harness construction (per bot)

```ts
const harness = await Harness.open(
  await openNodeSqliteStorage(join(botDir, "session.sqlite")),
  {
    models,                       // one shared Models instance for the process
    registry,                     // empty in phase 1 (see "No tools")
    settings: perBotSettings(),    // fresh object per bot, never shared
    now: Date.now,                // default; no fake clock in production
  },
  BACKGROUND_CONTEXT,
);
const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: defaultModel } });
```

- One `Models` and one `Registry` instance is shared process-wide (they are
  read-only after construction and hold no conversation state); everything else
  is per bot.
- `root()` is idempotent: it returns conversation id `1` for a new storage and
  the same root on reopen.
- Phase 1 keeps exactly one conversation per bot and never calls
  `createConversation`, `fork` or subagent APIs. The wire identifies a bot, not a
  conversation.

## Event mapping

Pure function `mapEvents.ts`. The adapter keeps per-run state:

```
turn: number                 // increments on turn_start, names provisional ids p_<turn>
provisional: { turn, id } | null
```

| pi event (`watchEvents`) | Adapter action | `RuntimeEvent` |
| --- | --- | --- |
| `snapshot` | Build the attach-time view; if `generation.message` exists, also prepare a provisional message from it | `snapshot()` result |
| `run_start` | Mark running | `status{running:true, inbox}` |
| `run_end` | Clear provisional state | `status{running:false, inbox}` |
| `turn_start` | `turn += 1` | — |
| `message_start` | **Ignored** (F3) | — |
| first `message_update` in a turn | Emit the provisional message once, `id: "p_<turn>"`, `state:"streaming"`, empty blocks | `append` |
| `message_update` | Translate each `MessageChange` | `delta{messageId:"p_<turn>", changes}` |
| `message_end` where `entry.kind === "pi.assistant"` | Map `entry.model[0]` to a `Message` with the real id, `state` from `stopReason` | `append{message, replaces?}` |
| `message_end` where `entry.kind === "pi.user"` | Map to a user `Message` (normally already known via `submission`) | `append` |
| `submission` | Map record: `queued/placed/done/unanswered` + `reason`/`detail` | `submission` |
| `inbox_update` | Map queue items | `status{inbox}` |
| `entry_appended` for kinds other than user/assistant | Reserved (notice/system); phase 1 drops | — |
| `tool_execution_*` | Reserved (phase 2) | — |
| `auto_retry_start` / `auto_retry_end` | Log `runtime.classify`, no wire event in v1 | — |
| `compaction_start` / `compaction_end` | Log; `error` becomes `error{kind:"extension_error"}`-class notice in phase 2 | — |
| `task_failed` | Classify the task kind | `error{kind:"task_faulted"\|"task_parked", taskId}` |
| `usage_changed` | Reserved; snapshot only | — |

`MessageChange` → `delta.changes`:

| Change | Emitted |
| --- | --- |
| `text_start` | nothing (the block is created by the delta stream) |
| `text_delta` | `{kind:"text", append}` |
| `thinking_start` / `thinking_delta` | `{kind:"thinking", append}` (reserved, not rendered) |
| `toolcall_start` / `toolcall_delta` | `{kind:"toolcall", callId, path, append}` (reserved) |
| `block` | `{kind:"block", index}` — the client asks for a re-render of that block from the final message |
| `message` | nothing; the final `append` carries the whole message |

`stopReason` → `Message.state`:

| `stopReason` | `state` |
| --- | --- |
| `stop` | `complete` |
| `aborted` | `aborted` |
| `error` | `error` (reason text goes into a `notice`, never into the model context) |
| `deferred` | `streaming` (still running) |

## Submission lifecycle on the wire

One input produces up to three `submission` events, and the client upserts by
`submissionId`:

```
send(requestId) → submission{status:"queued"}           // admitted, may be waiting for an open
                → submission{status:"placed", entryId}  // pi.user entry committed
                → append(user message)                  // transcript
                → append(p_n) → delta* → append(e_10, replaces p_n)
                → submission{status:"done", entryId}    // = answer entry id
```

Failure:

```
send → queued → placed → submission{status:"unanswered", reason:"model_error", detail:"…"}
```

`unanswered` means the message was admitted and the model failed. It is not a
transport error and must not be retried automatically: the user decides.

## Settings per bot

| Setting | Value | Why |
| --- | --- | --- |
| `stream.timeoutMs` | 120 000 | A stalled provider must eventually fail the run |
| `retry.maxRetries` | 3 | Provider 429/5xx are transient |
| `compaction` | `{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }` | Defaults; phase-1 chats are short. Compaction costs one model request when it runs |
| `progress.partialIntervalMs` | 100 | Matches the protocol's 50 ms coalescing; local storage makes 100 cheap |
| `progress.outputIntervalMs` | 100 | Reserved (tool output) |
| `afterFailedRun` | `"continue"` | A failed run must not strand queued follow-ups |
| `toolExecution` | `"parallel"` | Unused in phase 1 (no tools) |
| `restartLimit` | 5 (default) | Parked tasks surface as `task_parked` |
| `contextRetentionMs` / `documentRetentionMs` | 600 000 (default) | Memory is freed by idle close anyway; defaults keep reopen hot |

`settings` is a getter object per bot so the daemon can change one bot's policy
without touching another (F14).

## Reserved capability enable paths

Phase 1 installs an empty registry and provides no `env`, so no tool is offered.
A model that asks for one anyway receives an error result (established pi
behaviour), the run continues, and nothing crashes. `capabilities.tools` is
`false`, so the client never renders tool UI.

`src/runtime/pi/registry.ts` is the only place that would change:

| Capability | Enable path |
| --- | --- |
| `tools` | Install tool extensions into the registry, pass `env: ({cwd}) => new NodeExecutionEnv({cwd})`, map `tool_execution_*` to `delta`/`append`, flip `welcome.capabilities.tools` |
| `peers` | Add bot-to-bot delivery as a tool or a background task; the protocol already carries `peers` |
| `agent` | Expose `configure()` through a command; `RuntimeHandle.configure` already exists |
| `tasks` | Add `task` events from `watchTaskGraph`/`inspect`, plus `retryTask` |
| `entries` | Serve raw entries from `conversation.entries()` |
| `usage` | Populate `usage` in snapshots from `pi.usage` |

Adding any of these must not change v1 semantics for existing fields
([PROTOCOL.md](PROTOCOL.md#versioning-policy)).

## Recovery semantics

| Situation | pi behaviour | Adapter action |
| --- | --- | --- |
| Process killed mid-run | Committed entries survive; the generation task is `running` on disk | `recoveryScan` opens the bot, `resume()`; the run continues from its checkpoint |
| Process killed mid-tool (phase 2) | Replayed only when `replay: "safe"`, else the model receives an `interrupted` error result | Unchanged; no adapter involvement |
| Crash loop (≥ `restartLimit`) | Task parked, `onReport(task_parked)` | `error{kind:"task_parked"}`; client offers retry in phase 2 |
| Storage error | Harness closes itself (`SessionFailed`) | Classify `storage_failed`, mark the bot `unavailable`, hand the client a snapshot with `unavailable` |
| `close()` stalls on non-cooperative code | `close()` joins invocations | Bound the wait at 5 s, log `runtime.close.ok` with `detail.timeout:true`, drop the handle |
| Reopen after idle close | No state lost | New snapshot; client replaces its view |

## Pitfalls recorded so the next implementer does not rediscover them

1. Do not commit the answer entry (F1/F2). The README quick start is misleading;
   the test in this repo asserts a single `pi.assistant` per turn.
2. Do not map `message_start`/`message_end` directly (F3). Use the
   first-`message_update` rule.
3. Do not key deltas on the pi-ai message (F4). Deltas need the provisional id.
4. Do not assume a `pi.system` entry exists (F5); an empty registry produces none,
   and a future prompt section will add one with its own entry kind.
5. Never open the same bot twice (F14 + no cross-process locking). The registry
   serializes opens per bot and the daemon takes a single-writer lock.
6. Do not retry `unanswered` automatically (F8).
7. `abort()` is not cancellation of a single message: it aborts the run and
   withdraws queued inputs (F9). The client must reconcile its pending bubbles
   from the resulting `submission` events.
8. A watch that falls behind receives a fresh snapshot (F7). The adapter must
   reset its provisional state when that happens, otherwise deltas target a
   message the client no longer has.

## Upgrade procedure

1. Bump the exact pin in `apps/bots/package.json`; install.
2. Run `npm test -- test/runtime test/protocol`; the `mapEvents` golden test
   compares against the recorded event sequence and is the early-warning signal.
3. Read the diff of upstream `docs/spec.md` §2.1 (context derivation), §5.6
   (sleeping/wakeups), §8.2 (`pi.live`), §9.3–9.4 (views and agent events) and
   the `CHANGELOG.md`.
4. Update this file's fact table if any of F1–F16 change; the commit that bumps
   the pin must say which facts changed.
