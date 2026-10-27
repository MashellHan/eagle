# Bots — delivery plan and current state

Status snapshot. The contracts live in
[PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[PROTOCOL.md](PROTOCOL.md), [RUNTIME.md](RUNTIME.md),
[OBSERVABILITY.md](OBSERVABILITY.md) and [TESTING.md](TESTING.md). This file says
what exists, what is next, and where it lives. Update it whenever a stage closes.

## Where the code lives

```
docs/bots/                 contracts and this plan
fixtures/bots-protocol/    normative wire samples, shared by daemon and client
apps/bots/                 the daemon: own package, own lockfile, own gates
  src/core/                domain types, catalog, hub, view fold, runtime port, service
  src/protocol/            wire codec, limits, validation
  src/log/                 declared event catalogue and the layer logger
  src/runtime/pi/          pi-durable adapter, classifier, golden mapper
  src/server/              http, websocket transport, auth, singleton lock
  src/testing/             fake runtime and test helpers
  src/main.ts, config.ts   composition root; the only place env vars are read
  scripts/serve.ts         the process entry: start line, SIGINT/SIGTERM, no logic
  test/{protocol,core,log,runtime,server,e2e}.test.ts and architecture.test.ts
  test/crash/              real daemon processes: SIGKILL mid-answer, delete, lock
  test/perf/               the documented measurements with generous bounds
  test/runtime/golden/     recorded pi sequences and their frozen mapping
apps/bots-macos/           the client logic: SPM package, imported by the Eagle app
```

Gates, all run in `apps/bots`: `npm run check`
(`fixtures:check`, `npm test`, `typecheck`, `lint`, `coverage` 90/85/90), plus
`npm run test:crash` and `npm run perf`, which are separate because a real
`SIGKILL` and a real clock are not deterministic. `npm run test:runtime` and
`npm run test:protocol` run one stage's suite.

## Ladder state

Rows are the `TESTING.md` ladder. "Signed off" means the reviewer accepted that row
after a full review round; a row can be implemented and reviewed but not yet signed.

| Row | Stage | What it proves | State |
| --- | --- | --- | --- |
| 1 | 1 | every fixture decodes and re-encodes without loss | **signed off** |
| 2 | 1 | the encoder reproduces `snapshot.server.json` byte for byte | **signed off** |
| 3 | 1 | commands are validated at the wire boundary | **signed off** |
| 4 | 1 | encoded-frame, page, message, catalog and inbound budgets | **signed off** |
| 5 | 1 | unknown events are ignorable with their revision consumed | **signed off** |
| 6 | 1 | log shape: declared catalogue, failure identity, origin-only errors | **signed off** |
| 7 | 1 | no message text, prompt, title or secret reaches a log | **signed off** |
| 8 | 1 | the layer allowlist, proven by parsing all import forms | **signed off** |
| 9 | 2 | an interrupted catalog write leaves the previous catalog readable | **signed off** |
| 10 | 2 | `reconcile` finishes a delete interrupted after the move | **signed off** |
| 11 | 2 | the fake runtime satisfies the port, per bot and stateful | **signed off** |
| 12 | 2 | revisions strictly increase per bot, snapshots included | **signed off** |
| 13 | 2 | every subscriber sees the same sequence | **signed off** |
| 14 | 2 | a subscriber that falls behind is downgraded to snapshot-only | **signed off** |
| 15 | 2 | deltas coalesce inside 50 ms and keep every byte | **signed off** |
| 16 | 2 | a runtime snapshot is published at the next revision | **signed off** |
| 17 | 2 | `send` needs a subscription and answers a connection-scoped record | **signed off** |
| 18 | 2 | a repeated `requestId` returns the stored record, no new events | **signed off** |
| 19 | 2 | queued, placed and done map to one submission id | **signed off** |
| 20 | 2 | `unanswered` keeps its reason and never invents a settlement | **signed off** |
| 21 | 2 | history pages older messages, newest window untouched | **signed off** |
| 22 | 2 | resync returns a snapshot at the last published revision | **signed off** |
| 23-36 | 3 | pi-durable adapter: mapping, idempotency, failures, recovery | **signed off** |
| 37-41 | 4 | auth, handshake, close codes, catalog HTTP | implemented, review rounds closed, owner-closed |
| 42-43 | 4 | log origin and trace recipes | implemented, review rounds closed, owner-closed |
| 44-48 | 4 | registry lifecycle, singleton lock | implemented, review rounds closed, owner-closed |
| 49 | 4 | the end-to-end journey | implemented over the real adapter, owner-closed |
| 50-52g | 4 | the remaining journeys (bots, outbox, paging, ordering, overflow) | implemented, owner-closed |
| 53-54 | 4 | crash and perf suites | implemented (`test:crash`, `perf`), owner-closed |
| 55-60 | 5 | decoding, reducer, gap rule, ranked submissions, optimistic send | implemented (Bots package tests), owner-closed |
| 61-62b | 5 | the socket speaks the real daemon, close codes, gap reset | implemented (integration tests spawn the daemon), owner-closed |
| 63-68b | 5 | view models: connection, composer, outbox reconciliation, catalog, recovery | implemented (fake-port tests), owner-closed |
| 69 | 5 | dependency rules | the Bots package imports nothing from Eagle; Eagle imports it one way, owner-closed |

Current tree: 344 deterministic tests plus five crash cases and four perf
measurements, coverage 94.9% lines / 89.8% branches / 90.3% functions, `typecheck`,
`lint`, `fixtures:check`, `test:crash` and `perf` green. The daemon runs: it binds a
loopback port, checks a bearer token, serves the catalog, streams a bot over a
socket, records every crossing in the declared log catalogue, survives a `SIGKILL`
mid-answer and takes its root over again.

### What the core can do today

Signed off and usable as a library (rows 9-22):

- protocol: every committed fixture decodes and re-encodes byte-identically, commands
  are validated at the wire boundary, and frame, page, message, catalog and inbound
  budgets are enforced
- catalog: atomic `catalog.json`, a delete that survives a crash between its two
  steps, serialized mutations
- hub: strictly increasing per-bot revisions, 50 ms delta coalescing under a 96 KiB
  batch limit split between whole changes, snapshot-only downgrade with a recovery
  anchor that is never served stale, one serial fanout per bot
- view: a pure fold into `ConversationSnapshot`, with submission ranking (I14)
- service: a connection-scoped subscription whose baseline is rendered before it goes
  live, an idempotent `send` that answers the stored record and emits nothing, hub
  broadcasts for settlements, `history` paging that leaves the newest window alone, a
  single-frame `resync`, `abort` and `recover`
- log: a declared event catalogue, key whitelist, redaction and parser-enforced layer
  boundaries

What is missing, and why the product still cannot ship:

| Gap | Consequence |
| --- | --- |
| stage-4/5 signoff | five review passes are closed; the closeout pass is running |
| client surface | the MVP is complete (see "Stage 5, as built"); history paging, bot settings and an inspector that renders a bot's own state remain |

Stage 3 (rows 23-36) is signed off. Stage 4 is implemented end to end: its first
review round closed eight P1 and eleven P2 findings, and rows 42-54 are written.

## Stage 5, as built

The client is not a second app. Its logic is `apps/bots-macos` (BotsCore,
BotsTransport, BotsFeatures), and its UI is a Bots group in the Eagle main window
(`apps/macos/Sources/EagleFeatures/BotsWorkspace.swift`), rendered by the existing
`SidebarPanel`/`ConversationColumn`: a bot is a sidebar item, selecting it shows the
conversation, `+` creates one, and rename/delete are the sidebar's own affordances.

What works end to end against the real daemon: connect (token from the root), absolute
catalog, create/rename/delete (the create sheet asks for a required name, an optional
label, and a face — one of ten silhouettes and one of twelve tints, stored by the daemon
so the sidebar renders what was picked), subscribe, real streaming answers (each delta folded and
re-rendered), typing while an attempt has no text, the ranked submission rule, an
optimistic bubble replaced by the committed entry, the persisted outbox replayed on
connect, unavailable/recover, gap detection with one resync, and close-code driven
reconnection.

Deliberately not built in this pass: bot settings (model, instructions), usage,
inspector content for a bot (the inspector is emptied rather than showing another
bot's), and history paging from the transcript.

## Stages 4-5 review round: what was fixed and what is deferred

An independent review of stages 4 and 5 returned `BLOCKING 15`: three confirmed daemon
races already on this list, and twelve client/integration defects. Fixed:

- daemon: an idle close no longer clears a delete's settling window (it owns only the
  window it created); a reservation is released by a 60 s TTL instead of by a snapshot
  that may predate the admission; availability is re-checked after the record lookup
- client: `heart`/`flower` are in `BotAppearance.Shape` (a missing shape made the whole
  catalog undecodable); a send is not written when the outbox write fails and the draft
  comes back on `not_admitted`; the outbox is replayed after the first snapshot, never
  after the handshake; a send names its bot and is refused if the connection moved; a
  write failure releases the writer instead of wedging reconnects; a rejected revision
  no longer advances the gap baseline and a resync timeout retries once; a snapshot
  merges the submission ranks instead of resetting them; the outbox store merges on
  write so two windows cannot overwrite each other; hiding the open bot selects the next
  one; the catalog changing the selection moves the conversation with it; the shell shows
  a status strip with 恢复/停止/error, and a send that cannot run keeps its draft
- presentation: assistant answers are markdown dialog bubbles (headings, lists, quotes,
  fences with a language label, inline styles), the parser keeps paragraph/list order,
  handles longer fences, numbered lists and `#include`; thinking and tool results stay
  out of the answer; one attempt has one typing row; a `length` stop reason says so
- daemon: an oversized frame closes `1008` even when the socket is behind
- tests: real-socket reconnect, block-delta and ordering cases, outbox replay after the
  snapshot, draft restoration, store-level outbox merge, single typing row, the
  appearance set, and the daemon races above

A second pass found nine more P1s, mostly regressions inside those fixes; they are
closed too, with the third pass's four follow-ups: the shell binds the conversation's
draft through one accessor (one draft, so a refusal's restored text is what the
composer shows); a reservation whose status read fails keeps its slot instead of being
released; a resync deadline that finds the barrier already opened by a snapshot neither
counts it nor closes it again; and a refused request is remembered so a failed outbox
removal cannot make a later reconciliation re-send it behind the user's back. The
second-pass list: a reservation expires only after
the runtime says the request is not outstanding (time alone was not evidence); the outbox
fails closed on an unreadable file, always reads the file, and stores a terminal record
in the same atomic write that removes its entry; reconciliation runs after every
reconnect, not only the first; a failed socket write clears the queue it belonged to so
the next connection starts with `hello`; a gap is repaired by one resync and a
ten-second deadline (gapped frames neither advance the baseline nor exhaust the retries);
`abort`/`recover`/`history` name their bot like `send` does; and a refusal appends the
rejected text to a newer draft instead of dropping it.

A fifth pass found four contract defects, all closed with tests: recovery no longer drops
an admission that was in flight when the watch escalated; a subscriber the transport
backpressured is refreshed with a snapshot (bounded to one attempt per episode, so a
client that never reads cannot spin the daemon); a bot that becomes quarantined while a
subscription waits closes `4090` and retries instead of `4004`; and clicking recover while
reconnecting no longer drops the parked affordance. Its P2s are closed too: the heartbeat
follows a connection generation (a welcome no longer stops it), a refusal is a durable
tombstone written as soon as the outbox is writable, a restored settlement ranks by its
submission id, a half-spoken lock owner cannot hang the probe, the initial snapshot sets
the history flag, and the window test asserts the published transcript.

A sixth pass found three more, closed with tests: the recovery anchor of a degraded
subscriber is retried on a timer until it is delivered; a refusal becomes durable even
when the support directory is unwritable (a temporary fallback), so a restart cannot
replay it; and a command issued while reconnecting is refused instead of dropped. Its
P2/P3 are closed too: the TTL test only fails the reserved lookups, a snapshot cannot
resurrect a settled submission as pending, and the plan no longer claims there is no
client.

A seventh pass found two more, closed with tests: `snapshot.parked` (additive) tells a new
client that a task needs `recover`, and closing a window releases its socket so the
per-bot subscriber cap is not consumed by closed chats. Its P2/P3 are closed too: the
Swift fold keeps settlement ranks across a snapshot and the plan's stale rows are gone.

The third pass's four follow-ups now have regression tests: `BotsWindowTests` (the
window's one draft, the published transcript/status/actions and a refusal's restored
text), the reservation test's failing status read keeping its slot, `ResyncStateTests`
(the snapshot/deadline interleavings, including a snapshot after the retry), and the
refused-entry test (a failed removal, a reconnect, no replay, and a visible error). The
stored `SettledRequest` is applied to the ranks on selection but has no UI for its
reason.

Still deferred, with reasons: the client logging contract (`os.Logger` crossings in
OBSERVABILITY.md) is not implemented; the transport's gap/unknown/close-code/reconnect
fault-injection matrix is only unit-tested at the gap rule and exercised by the happy
path integration tests; the outbox's multi-window guarantee is tested at the store, not
through two windows; an `abort` refused on an unavailable bot still lacks an originating
record, a failed `directory.remove` can leave a closed handle that `open` reuses, and a
catalog-full refusal has no origin record; and long or hostile markdown has parser tests
but no measured layout pass.

## Phase 2: tools and herdr (both slices signed off, tool rows rendered)

A follow-on slice puts tool invocations on screen. `pi.tool-result` entries are mapped to
`role:"tool"` messages with a `toolResult` block (`callId`, `name`, text, `isError`,
`durationMs`); the assistant entry keeps its `toolCall` blocks and `toolcall` deltas grow
their arguments. The daemon clamps a result above the message budget with a
`[tool output truncated]` tail instead of the answer's oversized notice. The client pairs
a call with its result by `callId` and renders one compact row per call: name, an argument
summary, a running spinner or duration, and on click the pretty arguments and the output,
colored when the tool failed. A result whose call was trimmed out of the page is still a
row, so nothing disappears. Fixtures, the mapper, an end-to-end socket test and the
presenter all cover it; PROTOCOL.md "Tool rows" is the contract.

**Status: implemented, not signed off.** Three Codex rounds (reasoning max) reviewed it.
The first two rounds' findings are fixed (encoded-size clamp, commit ordering, typed delta
path, Swift codec parity, duplicate-call pairing, bounded rows, trim/pointer handling).
The third round leaves one P1: after a page trim drops a provisional, a later `status` or
`inbox_update` can re-publish that `streaming` id (`apps/bots/src/core/view.ts:156` only
sanitizes inside `trimWindow`), making a resync snapshot name a missing message. A P2
defensive gap remains for a `__proto__` path segment in the two fold copies
(`mapEvents.ts:606`, `view.ts:222`); upstream Chord currently rejects such a path. Both are
recorded in CHECKPOINTS as open, not fixed.

`apps/bots/src/tools/` installs the `bots-tools` extension in every Harness: `read_file`,
`write_file`, `list_files` and `run_command`, bound to `<bot dir>/workspace`, executed
without an approval gate. Paths are confined lexically and component by component (a
symlink, including a dangling one, is refused; files open with `O_NOFOLLOW` and only
regular files are read), commands run under a Seatbelt profile that denies the daemon root
and every other bot, a deadline kills the whole process group, both output streams share
one 64 KiB budget, and the child environment is an allowlist (no daemon secrets). A
refusal or a non-zero exit is a tool result the model reads. The agent's
`cwd` is the workspace, `capabilities.tools` is true, and a tool round works over the real
adapter (tests drive a faux model that calls a tool, checks the result reached the model,
and asserts the file/command effect). Tool calls already fit the wire; rendering tool
rows in the client is the next slice, so `pi.tool-result` stays off the wire for now.

The first Codex review of slice 1 (reasoning max) returned six P1s: a shell with no
filesystem isolation, a dangling-link write-through, a check/use race in path resolution,
a workspace root that trusted a symlink, a timeout that killed only the shell PID, and a
tool that ignored cancellation. The hardening above closes them; the remaining
intermediate-directory race is recorded in RUNTIME.md as a known limit (it needs `openat`,
which Node does not expose). A second review found three more: a workspace root that could
be re-bound after open, a `write_file` that blocked on a FIFO (abort could not finish), and
a `setsid` descendant that outlived the deadline. All three are fixed (open-time
`dev`/`ino` identity, non-blocking regular-file writes, `ps`-tree kill), together with its
P2s: no silent sandbox degradation, SDK budgets set as a backstop above the tool caps, one
`[stderr]` marker, a decoded-byte output budget, and a streamed page instead of a
whole-file size limit. A third review confirmed those and left one limit: a daemon whose
parent already exited is reparented and cannot be killed by a tree walk, which RUNTIME.md
now states; the same review's two page-limit defects (an unterminated last line bypassing
`limit`, and a page-budget refusal reported as "no such line") are fixed. A fourth review
confirmed the page fixes and found the output budget still counted pre-decode bytes at the
cut: a lossy decode now clips on a UTF-8 boundary and the decoders' tail is budgeted too,
and the stderr test now writes stderr (with the redirect removed). A fifth review re-ran
every probe and returned SIGN OFF: the four tools are ready as slice 1 with their
documented limits. Slice 2 (herdr: open a space,
schedule the controller, monitor, fetch, bidirectional messages) is next, as a second
extension with the same layering.

### Model gateway and setup

The model endpoint moved into the app: Settings has a `Bots 模型` tab (URL, key, model,
`测试连接`, `保存`) backed by `GET/PUT /v1/settings` and `POST /v1/settings/test`. The store
is `<root>/gateway.json` (0600, dotenv fallback), the key is write-only, and saving swaps
the process-wide `Models` (read through a getter by every Harness), moves live
conversations with `conversation.configure({model})` and rebroadcasts the catalog. The
daemon had previously been configured only by its dotenv and registered exactly one model,
which is why a bot naming another id settled `no_model`. Guidance is progressive: a bot
stays readable until a send is attempted without a gateway, then the conversation offers a
short "去设置" banner; the gate is tested (`BotsWindowTests`), the fresh-install window is
not.

## Next work, in order

1. Finish the client surface: history paging, bot settings behind the `agent`
   capability, and an inspector that renders a bot's own state.

### Proposed product expansion (2026-10-27)

The requested direction is a Bot product with multiple client entry points,
per-bot personality and durable memory, scheduling, bot creation and group chat,
and pluggable machine/browser/connector capabilities. The requirement analysis,
architecture proposal, ownership split and acceptance examples are in
[DIRECTION.md](DIRECTION.md). This is a proposal, not an implemented expansion
of phase 1; enabling a slice still requires its owning contracts and tests.

The existing client gaps above remain recorded. Settings/history required by a
milestone belong to that milestone rather than blocking all remote work on every
inspector feature. The proposed delivery order is:

| Milestone | Bot core lane | Cloud and machine lane | Exit evidence |
| --- | --- | --- | --- |
| M0 — shared contracts | Bot vs conversation identity, plugin/context boundaries | Host and machine routing, owner-token/session and execution contract | Agreed interfaces, file ownership and compatibility fixtures; no deployment implied |
| M1 — one Bot from two devices | Standalone daemon lifecycle, existing chat/history/recovery | Real machine settings, authenticated outbound relay, Web chat and remote native transport | A second computer uses Web without a Bot install; both clients reach the same host state; quitting UI keeps the daemon running |
| M2 — useful persistent assistant | Per-bot instructions, scoped memory, plugin selection, durable reminders and bounded loops | Required task/status presentation and notification/host status wiring | Role and explicit memory survive a new chat; a reminder survives daemon restart, fires once under its documented host conditions and can be cancelled |
| M3 — bot collaboration | Restricted Bot creation, shared room timeline, explicit turn routing and stop/budget limits | Forward and render the compatible room protocol | Parent creates a Bot without duplicate creation on retry; an @mention selects the recipient; room work stops and does not inherit unrelated private context |
| M4 — one complete external workflow | A connector and browser plugin used for sourced information collection | Required target capabilities and secure connector configuration | One real authorized X-information workflow produces source links/times; capability and upstream failures are visible |
| M5 — wider access and execution | Computer-use plugin and further connectors as required | Responsive/mobile Web improvements; assess PWA/native push and cloud-hosted runtime only when needed | Capability-specific journeys and measured operational requirements, rather than a new mobile app as a prerequisite |

M0 allows both lanes to proceed in parallel; the table orders integrated
acceptance, not every implementation task. Core work in M2 can proceed while
the cloud lane finishes M1 once the relevant contracts are fixed. Exact dates
and named owners are not agreed in this proposal. Current per-bot storage remains authoritative on
one host; the first remote slice adds neither cross-host replication nor
cloud persistence of chat bodies. Current Agent terminal input is not a generic
remote-command task API; that extension requires its own compatible release.

### What the adapter can do today (rows 23-36, signed off)

- `mapEvents.ts` replays recorded pi runs: append, delta, submission and status
  events, an attempt-scoped provisional, an aborted entry that replaces it, a
  withheld over-limit answer and a deferred poll that resets through a snapshot.
- `PiDurableRuntime` opens one Harness per bot over real node:sqlite, resumes
  recovery, answers a duplicate `requestId` from the stored record, aborts the
  running and queued inputs, keeps a model's tool request from crashing the run,
  pages history and turns a stalled `close` into `timeout`.
- `classify.ts` mints one failure identity per episode across the four reporting
  channels, announces one `error` event per identity, and escalates a repeated
  listener error only at the third occurrence inside a minute.

`ConversationService` (rows 17-22) is done: `subscribe` renders the current view as
the connection's baseline and goes live in one serial section, `send` reads the stored
record first so a retry is silent, `history` pages without touching the window,
`abort`/`recover` pass through behind the same subscription guard, and `resync`
broadcasts the only reply it produces, at a revision that names its content.

## Phase 1 close (owner decision, 2026-10-26)

The owner closed stages 4-5 on 2026-10-26 without waiting for another signoff round
("太细致不修，进入 tool call 开发"). Tip at close: `e70547c`. The eighth review was
interrupted on purpose and issued no verdict; its one confirmed observation — after a
daemon reopen the recover affordance can disappear because `parked` is not carried on that
path — is recorded as open, not fixed. Phase 2 (tool calls) proceeds next.

Closed by the review rounds: the three daemon races that were recorded here earlier (an
idle close clearing a delete's window, a stale snapshot releasing a reservation, an
availability check across an await) plus the transport, budget, logging, lifecycle,
client and presentation defects listed under "Stages 4-5 review round".

Deferred, not claimed fixed:

- client `os.Logger` crossing contract ([OBSERVABILITY.md](OBSERVABILITY.md), "Client
  logging") and its `LoggingTests.swift`
- the transport's fault-injection matrix beyond `ResyncState`: real-socket gap, unknown
  event with a gap, resync timeout with a fake clock, and the complete close-code matrix
  (the policy table and the resync state machine are tested; the injected journeys are
  not)
- the outbox across two real windows (the store merges on write and is tested that way;
  no two-window UI test exists)
- daemon: a refused `abort` on an unavailable bot has no originating record; a failed
  `directory.remove` can leave a closed handle that `open` reuses; the catalog-full
  refusal has no origin record
- the recover affordance after a daemon reopen (unfinished round 8, above)
- a measured long-markdown layout (the parser has unit tests; no layout pass)
- test-fidelity deferrals noted in [TESTING.md](TESTING.md): an admitted-then-unreadable
  storage fault inside the adapter and a retired-watch integration injection
- history paging from the transcript, bot settings behind the `agent` capability and an
  inspector that renders a bot's own state

## Open review queue

Stage 4 has had three review rounds. The third found eight P1 and ten P2 findings;
they are closed or recorded below. The second round found nine P1 and nineteen P2;
every defect among them is closed. The first round's eight P1 findings were closed,
in order: the
lock port derived from a non-canonical root, a delete that ran on after a timed-out
close, a handle that a new subscription could still take while closing, a baseline
the socket sent twice so an older snapshot could paint over a newer append, a
`recover` whose events updated a different Bot object, a service that kept a closed
handle, a socket close that never unsubscribed, and a `validateCommand` the wire
never called. Its eleven P2 findings are closed too, in order: a refused upgrade
keeping its connection slot, the missing eight-subscriber cap, an error frame before
`welcome`, a second in-flight subscribe that was not a protocol violation, two
refusal identities for one refusal, an unbudgeted 33rd admission and an unmeasured
`bots` broadcast, a token file that kept its mode, core re-originating a runtime open
failure (which its own guard then refused to log), a close timeout logged as success,
and a day boundary that left a sixth log file. Rows 44 and 49 stopped proving their
properties over the fake runtime.

The first round also closed the rest of the observability contract: every declared
event now has its emit site, the catalogue is asserted equal to the document, a run's
first `status` is attributed to the send that caused it, and an over-long
conversation is trimmed to the page budget with `truncatedBefore` kept.

The second round's findings, closed in area order: an open during a close creating a
second Harness (and the close then dropping it), a delete that ran past an in-flight
warm-up open, a run-time storage failure that never made the bot `unavailable` so
`recover` reused the dead handle, a snapshot page bounded by count but not by bytes,
transport backpressure that the hub could not see, a check-then-submit admission race
past the 32-entry budget, a create race past the 200-bot cap, a catalog event that
could arrive before `welcome`, a per-bot shutdown deadline instead of one shared
budget, refusals with no originating record, a `history` failure split across two
identities, an invalid trace written to the log, an upgrade accepted on any path, a
failed unrelated command clearing the subscribe guard, catalog states that never
followed the run, a token file two first starts could overwrite, and a perf bound that
was looser than the document. Its test-fidelity findings are closed too: the catalogue
test now proves an emit site rather than a declaration, the real-Harness test holds the
warm-up open to prove in-flight sharing, the overflow journey joins during the
withdrawal window, the delete crash test runs the production `remove`, the outbox
journey covers an admitted input whose record read failed, quarantine retry recovery,
a second crash without any provisional, two daemons starting at once, a junk sqlite
beside a healthy bot, and the catalog following a run. Then a third round found eight
P1s (a handle held across a close or delete, history byte-paging that skipped
messages, a snapshot budget that ignored the rest of the frame, an unavailable
snapshot the decoder would reject, leaking or early-freed reservations, a
backpressure bound only on the hub path, a silent client holding the lock server,
and concurrent `recover` attaching two watches); a fourth round found five more in
those fixes (reservations counted twice or leaked, an escalated watch dropping a live
Harness so `recover` could open a second owner, two concurrent subscribes building two
views and so bypassing the eight-subscriber cap, and a summary only budgeted in its
healthy form). A fifth round found three more (the delete window being replaced by
its close, a snapshot reconciling a reservation whose submit had not returned, and an
unavailable bot bypassing the admission budget through its still-live handle). All are
closed, most of them with a test that fails without the fix; the sixth round's
remaining races are listed below rather than claimed as fixed.

Four test-fidelity findings remain deferred with their reasons: the outbox's
admitted-then-unreadable case is asserted at the service and adapter boundaries
because no fault can be injected at that read; a retired-watch reattach has no
integration injection because pi-durable exposes no hook (the classifier and reattach
paths are tested); the transport's unsent-byte threshold shares the hub's proven
mechanism and has no slow-TCP test of its own; and I14's ranking is a client reducer
duty in stage 5.

Stage 3 (rows 23-36) is signed off. Its review rounds closed, in order: a
fail log record built from another layer's identity, a reattach that dropped its
recovery snapshot, a listener escalation counted per notification, a park found
during `open` that no subscriber could see, `pending` rebuilt from the ledger
instead of the snapshot, `task_failed` bypassing the event dedupe, failure ids
colliding across harnesses, `hasMore` counted from raw entries, a settled record
unreadable by request id, progress wearing the watching connection's trace, an
attempt id reused after a deferred poll, an oversized re-announcement, an unstable
notice timestamp, and a baseline that could arrive after newer content.
Stage 2 (rows 9-22) closed these rounds, in order:
revisions consumed before a delta was folded, unfaithful delta merging, a silently
dead degraded subscriber, reentrant fanout, a missing byte trigger, non-wire byte
counting, a detached subscriber still pumped, a fake-runtime toolcall path read from
the wrong root, a lost streaming pointer, history truncated by a window rerender,
unbounded batches inside one event, a stale anchor served as current, a starved
cross-subscriber pump, an evicted recovery snapshot, one test that could not fail,
a service view that was stale on a later connection, a connection registered after
its open, a baseline that raced a flushed delta, a release buffer that went live too
early, failures that lost their classification, snapshots that bypassed submission
ranking, a resync reply that could be replayed after a newer frame, and a resync
snapshot without its command trace.
