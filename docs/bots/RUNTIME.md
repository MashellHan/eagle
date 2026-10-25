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
| F22 | An interrupted attempt is **converted into a committed `aborted` assistant entry** (`convertPartial`) before the run resumes, so a crash mid-answer leaves an aborted entry plus the eventual answer | upstream `dist/harness/generation.js` `convertPartial` |
| F23 | `deferred` responses commit a polling checkpoint instead of an assistant entry; the run stays active with no message | upstream `generation.js`, `spec §8.3` |
| F24 | Reading `status()` after `submit()` can already show `done`, because admission starts the run | P4 (duplicate `requestId` returned `done` with entry + answer) |
| F25 | `harness.closed` reports `{reason}` and normal `close()` also settles it; it is not a failure by itself | upstream README "Errors", `spec §10.1` |

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
| `message_start` where `message.role === "assistant"` | Start an attempt if none is open; emit the provisional once, **with the converted content from F4**, `state:"streaming"` | `append` |
| `message_start` where `message.role === "user"` | Ignore (F3) | — |
| `message_update` | Convert every `MessageChange` to a `DeltaChange` with its `index` (table below) and forward it | `delta{messageId:"p_a<n>"}` |
| `message_start` for an assistant attempt that already has a provisional (retry inside the same turn) | Keep the provisional; apply the new content as one `message` change | `delta{kind:"message"}` |
| `message_end` with `entry.kind === "pi.assistant"` | Convert the entry's message to a domain `Message`; final state from `stopReason` (F13); clear the provisional | `append{message, replaces: p_a<n>}` |
| `message_end` with `entry.kind === "pi.assistant"` whose `stopReason === "aborted"` (F22) | Convert with `state:"aborted"`; carry `replaces` **whenever a provisional for that attempt is open** — after a late attach the snapshot already holds the partial, and an unreplaced aborted entry would duplicate it | `append` |
| `message_end` with `entry.kind === "pi.user"` | Map the user entry, including its `requestId` when known | `append` |
| `message_end` with `entry.kind === "pi.tool-result"` | Map the durable result to `role:"tool"` with one `toolResult` block (`callId`, `name`, joined text, `isError`, `durationMs`); it never ends or replaces the streaming attempt | `append` |
| `submission` | Map the record: status, `entryId`, `answerEntryId`, `reason` | `submission` |
| `inbox_update` | Map queue items | `status` |
| `run_start` / `run_end` | `status{running, streaming: provisionalId \| null}`; `run_end` closes any open provisional | `status` |
| `tool_execution_*` | The call itself rides in the assistant attempt (`toolcall` deltas); the result arrives as the `pi.tool-result` entry above. Execution telemetry is not projected | `delta{kind:"toolcall"}` / `append{role:"tool"}` |
| `auto_retry_start` / `auto_retry_end` | Log only; the provisional stays open because the failed entry arrives after `auto_retry_start` | — |
| `deferred_poll` | Upstream dropped the partial: emit a `snapshot` with `streaming:null`, `running:true`, then `status` | `snapshot`, `status` |
| `task_failed` | Classify as `task_faulted` (a park only ever arrives through `onReport`) | `error{kind:"task_faulted", taskId}` |
| `onReport` (`task_parked`, `session_failed`, `extension_error`, …) (F15) | Pass the report to the classifier, which owns minting; the channel never mints | `error{kind, failureId}` |
| `harness.closed` (F25) | `reason:"closed"` because we called `close()` → expected, no error. `reason:"failed"` → `storage_failed` | `error{kind:"storage_failed"}` only for the failed case |
| watch end (F17) | Follow the exhaustive `WatchEnd` table below; `session_failed` goes straight to the storage-failure path | `snapshot` after reattach, or `error` |
| watch falls behind → fresh `snapshot` (F8) | Reset provisional state from the snapshot | `snapshot` |

`MessageChange` must be applied without loss. The wire mirrors each kind
([PROTOCOL.md](PROTOCOL.md#server-events)):

| pi change | Wire `DeltaChange` |
| --- | --- |
| `text_start` | `{kind:"block", index: contentIndex, block: {type:"text", text: block.text}}` |
| `text_delta` | `{kind:"text", index: contentIndex, append}` |
| `thinking_start` | `{kind:"block", index, block: {type:"thinking", text: block.thinking}}` |
| `thinking_delta` | `{kind:"thinking", index, append}` |
| `toolcall_start` | `{kind:"block", index, block: {type:"toolCall", callId, name, args}}` |
| `toolcall_delta` | `{kind:"toolcall", index, callId, path, append}` — pi's path is relative to the call's arguments, so the mapper prefixes `"args"` to make the wire path block-rooted |
| `block` | `{kind:"block", index, block}` — the whole converted block |
| `message` | `{kind:"message", message: convertMessage(message)}` |

`convertMessage` is the only place pi-ai types are read. Nothing from
`@earendil-works/pi-ai` crosses into `core/domain.ts`: blocks, messages, usage and
stop reasons are all converted. A golden case covers a block that is announced by
`text_start` and then receives no delta at all (F5), and a case with two text
blocks where deltas must land on the right index.

`stopReason` (F13) → `Message.state`:

| `stopReason` | `state` | Note |
| --- | --- | --- |
| `stop` | `complete` | Normal answer |
| `length` | `complete` | Token limit reached. `Message.stopReason` says `length`, so the client renders its own notice instead of guessing from text |
| `toolUse` | `complete` | A tool round follows; the assistant entry keeps its `toolCall` blocks and the run continues with a `tool` message (see "Tools") |
| `aborted` | `aborted` | User abort or shutdown |
| `error` | `error` | Upstream failure; reason text becomes a `notice`, never model context |
| `deferred` | — (no message) | F23: the run sleeps in a polling checkpoint; the adapter only emits `status{running:true}`, never a fake streaming message |
| `pending` | `streaming` | In-flight partial |

Because `message_update` is optional (F5), the adapter must never treat deltas as
the source of truth: the provisional content comes from `message_start`, and the
final `append` from the entry.

Message identity, as built:

- A committed entry is `e_<entry id>`, a provisional is `p_a<attempt>`.
- `createdAt` is the pi message's own `timestamp` (milliseconds), so a snapshot
  rerender and a live frame describe the same message identically. A message
  without a timestamp uses the host clock, which only happens for a message pi
  never stamped.
- Attribution: a run's progress carries the trace of the `send` that owns it, resolved
  from the submission record; the `status` published by that same `run_start` can still
  carry the watching connection's trace, because the admission record arrives after the
  event. Everything the client turns into a message, and every settlement, is exact.
- A user message carries `requestId` when the adapter knows it. The entry and its
  submission record land in the same commit, and `message_end` is published first,
  so the live `append` may lack the id: the daemon's view attaches it when the
  submission names its `entryId`, and every later snapshot, resync and page carries
  it. The ledger itself is in memory, so after a restart a message recorded before
  the crash has no id until its `requestId` is re-sent; reconciliation does not
  depend on it (PROTOCOL.md, client duties).
- The mapper projects `pi.user`, `pi.assistant` and (since tool rows) `pi.tool-result`
  into the transcript. A tool result is an `append` like any other message and is part of
  every `snapshot`, `history` page and `resync`, so a reconnecting client sees exactly the
  rows the live client saw. A tool result never clears the provisional of an assistant
  attempt that is still streaming.

### Attempt lifecycle

One run may contain several generation attempts (retries, deferred polls, a crash
that resumes). The provisional id is scoped to the attempt so a stale stream can
never write into a finalized message:

Upstream order matters: `auto_retry_start` is published **before** the failed
attempt's assistant entry, so the provisional must survive it; the entry itself then
finalizes it.

```
first message_start(assistant)   → open provisional "p_a<n>" with current content
message_update*                  → deltas to "p_a<n>" (block-scoped, indexed)
auto_retry_start                 → log only; the provisional stays open
message_end(pi.assistant)        → append the entry with replaces p_a<n>; attempt n closed
message_end(aborted)             → append the aborted entry (F22); attempt n closed
deferred_poll                    → upstream drops generation.message: broadcast a
                                   snapshot with streaming:null (running:true) so the
                                   client removes the provisional
message_start after a closed attempt → new attempt id "p_a<n+1>"
run_end                          → close any open provisional via status{streaming:null}
```

Rules that follow:

| Situation | Provisional handling |
| --- | --- |
| Failed attempt followed by a retry | The failed entry finalizes `p_a<n>`; the retry starts `p_a<n+1>` |
| Deferred poll | Upstream removed the partial, so the adapter broadcasts `snapshot{streaming:null, running:true}`; the next attempt starts a new id |
| Late join or snapshot rerender | The snapshot carries the live attempt's content and its `p_a<n>` id |
| Watch fell behind (F8) | Reset attempt state from the snapshot; a delta for an unknown id is dropped |

### Failure channels

pi reports trouble through four channels, not one. Each needs wiring and each can
double-report the same underlying failure, so the adapter mints a `failureId` at
the classification point and dedupes on it:

| Channel | Covers |
| --- | --- |
| `AgentEvent` (`task_failed`) | A task that faulted while running |
| `onReport` (F15) | Parked tasks, session failure, extension/hook errors |
| `harness.closed` (F25) | Harness end; only `reason:"failed"` is a failure |
| Watch end (F17) | The event stream ended; reattach before reporting |

`WatchEnd.reason` is one of `stopped | cancelled | session_closed | retired |
listener_error | session_failed`. Only the last two are faults:

| Reason | Meaning | Adapter |
| --- | --- | --- |
| `stopped` | We detached | Nothing |
| `cancelled` | The acquisition context was cancelled (shutdown) | Nothing |
| `session_closed` | `close()` ended the session | Nothing |
| `retired` | A document watch's incarnation retired | Re-acquire the watch; not a failure, no counter |
| `listener_error` | A sink callback threw | Reattach with a snapshot; escalate after three in 60 s |
| `session_failed` | The harness failed | Classify `storage_failed`; same failure identity as `harness.closed` |

Failure identity correlation works per **failure episode**, not per bot, and each
duplicate pair has a named key:

| Duplicate notifications | Correlation | Result |
| --- | --- | --- |
| `task_failed` + `onReport(task_faulted)` for one task | `taskId` | One failure |
| `harness.closed{failed}` + watch end `session_failed` + `onReport(session_failed)` | harness episode (`harnessGeneration` counter) | One failure, classified `storage_failed`; a reopen starts a new generation, so a later failure gets a new identity |
| `onReport(extension_error)` + a task fault that the same hook caused | `taskId` when present, else the report's sequence | One failure |
| First recoverable listener error: `onReport(listener_error)` + watch end `listener_error` | episode key `listener:<n>` | **No failure at all** for the first two occurrences; the third within 60 s mints one `internal` failure |

The rule that makes this decidable: only the *classifier* mints a failure, and it
runs once per episode key. Channels never mint on their own.

Normal ends (`close()` we asked for, `stopped`/`session_closed` watch reasons) are
not failures and produce no `error` event.

## Submission ledger

The adapter keeps `requestId → submissionId` in memory and answers from it:

- `submit(input)` calls `root.submit({type:"input", content, requestId})`, then
  `status(context)` (F12) and returns the record. A repeated `requestId` returns the
  existing record and emits **no** new events (F7), which is why the daemon replies
  with a connection-scoped `submission` frame itself.
- The record read here can already be `done` (F24), because admission starts the
  run. The wire therefore ranks statuses and clients never downgrade
  ([PROTOCOL.md](PROTOCOL.md#client-commands)).
- `submission(key)` resolves by either id for duplicate replies.
- The ledger is not persisted: pi-dedupes by `requestId` in storage, so a daemon
  restart plus a re-sent `send` still converges (F7).

Projection, which is also part of the mapping contract:

- A snapshot carries the newest `PAGE_MAX_MESSAGES` displayable messages, oldest
  first, with `truncatedBefore` naming the first message it could not keep;
  `history` pages the rest from `Conversation.entries()` newest-first, skipping
  entries the wire does not show, and reverses.
- `pending` is rebuilt from the snapshot itself: the submission ids the run and the
  inbox name, with records the adapter already holds supplying their details. Work
  the snapshot does not name is settled, so it leaves `pending` even if a settlement
  event was missed, and a cold start still shows the input a crash interrupted.
- The baseline of a subscription is delivered before any later commit: events that
  arrive while it is being computed are buffered, so a fresh snapshot can never
  replace content that is already newer.
- Each converted message is measured as its encoded JSON; above `MAX_MESSAGE_BYTES`
  it is withheld and replaced by the notice (PROTOCOL.md). The adapter may not
  import the wire layer, so `src/runtime/pi/limits.ts` mirrors those two numbers and
  `test/runtime/limits.test.ts` fails if they drift.
- An expired watch or a deferred poll re-emits a complete snapshot rather than a
  patch, and the hub rerenders it at the next revision.

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
| `compaction.enabled` | **false** | F16: compaction is a conversation-owned background task. Phase 1 closes a bot on "no run, no task" and would close a compacting bot out from under itself. Long chats fail with `model_error` and stay readable. Enabling it later needs no close-condition change (it already reads `busy().tasks`) but does need the `tasks` capability so the UI can show a background compaction |
| `progress.partialIntervalMs` | 100 | Matches the protocol's 50 ms coalescing; local storage makes 100 cheap |
| `progress.outputIntervalMs` | 100 | Reserved (tool output) |
| `afterFailedRun` | `"continue"` | A failed run must not strand queued follow-ups |
| `restartLimit` | 5 (default) | Parked tasks surface as `task_parked` and are cleared by `recover` |
| `thinkingLevel` (per bot) | from `bot.json`, absent = the model's default | Applied when the Harness opens; a stored level is the bot's own reasoning effort. The daemon registers exactly one model (`BOTS_MODEL`), so a bot whose config names another id settles `no_model` until the model endpoint changes |
| `contextRetentionMs`, `documentRetentionMs` | 600 000 (default) | Idle close frees memory; defaults keep reopen cheap |

Each bot owns its settings object so one bot's policy cannot affect another
(F19).

## Tools (phase 2, slice 1)

A bot is born with four tools, installed as the `bots-tools` extension in its Harness
registry and bound to that bot's workspace:

| Tool | Behaviour |
| --- | --- |
| `read_file` | A text page (`offset`, `limit`): at most 2 000 lines and 64 KiB, streamed from the file and with a note naming the lines it showed and the total; a line that alone exceeds the page budget, or a scan that passes 64 MiB, is a named refusal rather than a false "no such line" |
| `write_file` | Writes one UTF-8 file (at most 512 KiB), creating parent directories, mode 0600 |
| `list_files` | A bounded recursive walk (2 000 entries) that skips `.git`, `node_modules`, `.venv`, `dist` and `.build`; directories end with `/` |
| `run_command` | `/bin/sh -c` in the workspace: stdout, stderr and the exit code, killed at the deadline (default 30 s, max 120 s) with the output capped at 64 KiB |

Rules:

- **Auto-execute.** There is no approval gate and no hook that asks the user; execution
  is the product. Tools do not receive a separate switch per call.
- **Workspace confinement.** The workspace is `<bot dir>/workspace`, created 0700 on open
  and the agent's `cwd`; it is refused if it is itself a symlink, and its `dev`/`ino` are
  captured at open. Every call first re-checks that identity, so a root replaced by a link
  or a different directory after open is refused, never re-trusted. Every file tool path is
  resolved inside the canonical root lexically **and** component by component; a symlink
  anywhere at or below the root — including a dangling one — is refused rather than
  followed. The final component is opened with `O_NOFOLLOW`, only a regular file is read or
  written (`O_NONBLOCK` so a FIFO or device can neither block nor be redirected), and an
  overwrite is tightened to 0600. An escape is a tool result the model reads, never an
  exception.
- **The daemon root is out of reach.** A command runs under a macOS Seatbelt profile
  (`/usr/bin/sandbox-exec`) that denies reading and writing everything under the daemon
  root — the token, the catalog, every other bot — while allowing the bot's own
  workspace. Outside that root the shell is the agent's own machine, by design: a coding
  agent needs to run toolchains, and there is no approval gate. On a platform without
  `sandbox-exec` the command runs unsandboxed; on a machine that has it but cannot stat it,
  the command fails instead of silently dropping the sandbox.
- **No daemon secrets.** A command's environment is an allowlist (`PATH`, `HOME`, `LANG`,
  `LC_ALL`, `TMPDIR`, `SHELL`, plus `TERM=dumb` and `PWD`). The child is `detached` in its
  own process group, and a timeout or an abort walks the `ps` tree before killing, so a
  descendant that left the group with `setsid` dies too while its parent is still alive.
  A daemon whose parent has already exited is reparented to pid 1 and cannot be attributed
  by any tree walk; the deadline still returns on time and the survivor stays confined by
  the sandbox, but it is recorded as a known limit rather than promised otherwise.
- **Bounded output.** Both streams share one 64 KiB budget counted in the bytes the model
  reads (a lossy decode that expands one byte into three is still capped), decoded as UTF-8
  across chunk boundaries; `[stderr]` marks the first stderr byte once (not every chunk),
  the exit code is always the last line, and each tool's SDK `outputLimits` is set above
  the tool's own cap so the SDK never cuts the result, its note or a command's exit status
  — a timed-out command still carries the stderr and the reason, and a command killed at
  the deadline returns then rather than waiting for its pipes to close.
- **Cancellation.** `run_command` follows the run's abort signal: an aborted run kills the
  process group and the model sees an aborted result instead of a live command.
- **Residual race.** A process that can already write inside the workspace could swap an
  intermediate directory for a link between the component check and the open. The final
  component is protected by `O_NOFOLLOW`, the root identity is checked on every call, every
  directory is re-checked before it is listed, and commands are additionally confined by
  the sandbox; closing the intermediate window fully would need `openat` chains the Node
  API does not expose, and is recorded as a known limit rather than claimed fixed.
- **Hard kill of the daemon.** A deadline or an abort kills the command's process group,
  but `SIGKILL` of the daemon itself orphans whatever is already running: the restart marks
  the run interrupted and cannot stop the orphan. A persisted process-group id would let a
  restart kill it, at the price of killing an unrelated group once the id is reused, so the
  limit stays documented instead of guessed.
- **Failures are results.** A refusal, a missing file, a timeout and a non-zero exit are
  returned to the model as text; a run never crashes because a tool failed.
- **Replay.** `read_file` and `list_files` are `replay: "safe"`; `write_file` and
  `run_command` stay unsafe, so an interrupted call is not rerun after a restart.
- **What the client sees.** A tool run is transcript content: the assistant entry carries
  `toolCall` blocks (grown by `toolcall` deltas) and the durable result is its own
  `role:"tool"` message with one `toolResult` block. Both are in the live frames, the
  snapshot and history, and the client pairs them by `callId` into one row (PROTOCOL.md,
  "Tool rows"). A result above the message budget is clamped with a
  `[tool output truncated]` tail instead of the answer's oversized notice.

## Herdr tools (phase 2, slice 2)

A second extension, `bots-herdr`, gives a bot a terminal collaborator. It talks to the
installed `herdr` CLI over the running session; the bot owns exactly one space and every
target is resolved inside it.

| Tool | Behaviour |
| --- | --- |
| `herdr_open_space` | Opens this bot's space (a workspace labelled `bots-<bot id prefix>-<nonce>` with one shell pane) and returns its ids; calling it again reuses the live space |
| `herdr_start_controller` | Starts one controller agent in that space's root pane with a herdr kind (`pi`, `codex`, `grok`, ...) and native arguments after `--`; idempotent while the controller lives |
| `herdr_list` | Lists the panes and agents of that space only |
| `herdr_send` | Submits a prompt to an agent in the space (default the controller) and by default waits for a settled state |
| `herdr_wait` | Waits for a named state (`idle`, `working`, `blocked`, `done`, `unknown`) or a settled one |
| `herdr_read` | Reads that agent's screen text (`visible`, `recent`, `recent-unwrapped`, `detection`), keeping the newest 64 KiB |
| `herdr_keys` | Sends logical keys (`esc`, `enter`, `ctrl+c`, `1`, ...), for a dialog the controller is blocked on |
| `herdr_close_space` | Closes this bot's own space and forgets it |

Rules:

- **The prompt does not advertise the scope.** The `bots-herdr` section names the space and
  how to use the tools; the scope is enforced by the tools (and their refusals), not stated
  as a prohibition in the prompt, because the shell a bot may also use can reach the
  machine. A model that asks the tools for another space still gets a refusal.
- **One space, and only its contents.** The space id, its full label (prefix plus a
  per-instance nonce) and its root pane live in `<bot dir>/herdr.json` (0600, outside the
  model's workspace). Every call re-reads the space from herdr and requires **both** the
  recorded label and the recorded root pane in that space, so neither a different space
  nor a same-id replacement is ever touched; a space that disappeared is replaced by a
  fresh instance, and the refused id stays tombstoned across that replacement and a later
  close. With no usable state (missing or corrupt file), exactly one space with
  this bot's prefix is adopted, and several are refused rather than guessed; a recorded
  space that fails verification is revoked in place, and its id is also written to
  `herdr.revoked.json` beside the record, so replacing the space and closing the new one
  cannot make a later open adopt it. If that tombstone cannot be written, the replacement
  does not happen at all ("nothing was changed"); tombstones are pruned (before the size
  ceiling is judged) only for spaces herdr no longer reports, never evicted while live, and
  a list that is still full of live entries fails safely rather than forgetting one. Only a
  missing file means "no refusals": a tombstone that cannot be read, parsed or attributed
  to this bot disables adoption and is never overwritten — a refusal that cannot be
  recorded fails with nothing changed. A record whose owner is another bot, or whose label
  carries another bot's prefix, is foreign and is never obeyed. A space that could not be recorded
  is closed again; when even that close fails, the result names the leftover space so a
  person can close it.
  `herdr_list`, `herdr_send`, `herdr_wait`, `herdr_read` and `herdr_keys` resolve their
  target against the agents herdr reports **in that space**, and then address it by its
  workspace-qualified pane id — never by a name that can be reassigned or moved.
- **argv, not a shell.** Each call is one `herdr` argv with a deadline (30 s default,
  120 s for talk, at most 600 s) and a bounded answer. The run's abort signal kills the
  CLI process group, a call that is already queued behind another is cancelled before it
  starts, and a deadline settles at once instead of waiting for an inherited pipe to
  close. The CLI's own output keeps its newest 4 MiB (a screen is only useful at its end)
  and is decoded across chunk boundaries. A herdr JSON error becomes the tool result with
  its own code and message (`agent_blocked: ...`); a non-zero exit without JSON keeps the
  exit and the detail.
- **The bot's own sandbox does not apply to the CLI.** `herdr` is a host tool (it needs the
  session socket), so it is not run through the workspace sandbox; what it may touch is
  bounded by the space rule above, not by the file system profile.
- **A label is not an ownership credential.** The nonce makes a collision with a user
  workspace implausible, but a user who copies the exact label of a bot's space can be
  adopted when that bot has lost both its state file and its tombstone list. That trade-off
  keeps a lost state from leaking a second space; several candidates are refused instead of
  guessed, and a state file that is present but fails verification is never adopted. Both
  files live in the bot's own directory, which the model cannot write; removing them is a
  person's deliberate act, and adoption then resumes as described above.
- **Reading is evidence, not proof.** `idle`/`done` mean herdr saw a settled agent, not
  that its work finished; `blocked` is a dialog the controller raised, and the bot may
  inspect it with `herdr_read` and answer it with `herdr_keys`.
- **Replay and state.** `herdr_open_space`, `herdr_list`, `herdr_wait` and `herdr_read`
  are `replay: "safe"`; prompting, keying, starting and closing are not, so a restart does
  not repeat them. The tools share one state file and run one call at a time.

## Reserved capability enable paths

"Reserved" means the wire can represent it and the client must ignore it while
disabled. It does **not** mean half-implemented behaviour. Each capability is its
own change set:

| Capability | Work required when enabling |
| --- | --- |
| `tools` | Enabled in phase 2: the four workspace tools (slice 1) and the herdr tools (slice 2), all auto-executed; rendering tool calls and results in the client is the next slice |
| `agent` | Add a `configure` command and a model catalog endpoint; add `configure` to the port; render the settings panel |
| `tasks` | Emit `task` events from `watchTaskGraph`; add a `retry` command; make the close condition task-aware |
| `entries` | Serve raw entries from `conversation.entries()` behind a paging command |
| `usage` | Already populated in phase 1: `snapshot.usage` comes from `pi.usage`; the panel is what phase 2 adds |
| `peers` | Bot-to-bot delivery as a tool or background task; a `peers` policy document |

None of them may change v1 semantics for existing fields.

## Recovery semantics

| Situation | pi behaviour | Adapter action |
| --- | --- | --- |
| Process killed mid-run | Committed entries survive; the generation task is still `running` on disk; on resume the interrupted partial becomes a committed `aborted` assistant entry (F22) | `open()` resumes; the client shows the aborted attempt followed by the final answer |
| Killed while a tool ran (phase 2) | Replayed only when `replay:"safe"`, else an `interrupted` error result | No adapter involvement |
| Crash loop ≥ `restartLimit` | Task parked, `onReport(task_parked)` (F15) | `error{kind:"task_parked"}`; `recover` retries it |
| Storage error | Harness closes itself (F14) | Classify `storage_failed`, mark the bot `unavailable`, serve a snapshot with `unavailable` |
| Watch ends (F17) | See the exhaustive `WatchEnd` table: `listener_error` reattaches and escalates at three in 60 s; `session_failed` takes the storage-failure path immediately; normal reasons end silently |
| `close()` stalls on non-cooperative code | `close()` joins invocations | `close` resolves `timeout`; the registry quarantines the bot and retries; it is never dropped |
| Reopen after idle close | No state lost | New snapshot; the client replaces its view |

`recover` is the operator's escape hatch and is state-dependent
([PROTOCOL.md](PROTOCOL.md#client-commands)). The adapter exposes parked-task retry
and leaves a running answer alone; `abort` is the only destructive command.

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
12. Do not expect exactly one assistant entry after a crash: F22 commits an
    `aborted` attempt first. Assert one admission, one retained interrupted
    attempt, one final answer.
13. Do not treat a missing delta as a stall (F5), and do not treat a
    `harness.closed` with `reason:"closed"` as a failure (F25).
14. Do not claim trace continuity into pi: phase 1 installs no pi telemetry, so
    trace ids live in the daemon's own logs and in-memory ledger. A resumed run
    after restart is attributed to `tr_boot_<n>`, not to the original `send`.
15. Do not clear the provisional on `auto_retry_start`: upstream publishes the
    failed attempt's entry afterwards, and that entry is what carries `replaces`.
    Do close it when that entry arrives — the retry gets a new id.
16. Do not treat `deferred_poll` as a message event; it is a polling sleep.
17. Do not expect `retired` to be an error; it means a document watch's
    incarnation rotated, and the watch is simply re-acquired.
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
   sequence is the early-warning signal. `npm run golden:record -- <scenario>`
   re-records a sequence from a real Harness over pi-ai's faux provider and rewrites
   its frozen expectation, so review that diff before committing it.
3. Read the upstream diff for `docs/spec.md` §2.1 (context), §5.6 (wakeups), §8.2
   (`pi.live`), §9.3–9.4 (views, agent events) and `CHANGELOG.md`.
4. Update the fact table if any of F1–F21 changed; the pin bump commit names the
   facts that changed.
