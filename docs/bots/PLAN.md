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
apps/bots-macos/           the client: separate SPM package   (not started)
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
| 37-41 | 4 | auth, handshake, close codes, catalog HTTP | implemented, P2 closed |
| 42-43 | 4 | log origin and trace recipes | implemented |
| 44-48 | 4 | registry lifecycle, singleton lock | implemented, P2 closed |
| 49 | 4 | the end-to-end journey | implemented over the real adapter |
| 50-52g | 4 | the remaining journeys (bots, outbox, paging, ordering, overflow) | implemented |
| 53-54 | 4 | crash and perf suites | implemented (`test:crash`, `perf`) |
| 55-60 | 5 | decoding, reducer, gap rule, ranked submissions, optimistic send | implemented (Bots package tests) |
| 61-62b | 5 | the socket speaks the real daemon, close codes, gap reset | implemented (integration tests spawn the daemon) |
| 63-68b | 5 | view models: connection, composer, outbox reconciliation, catalog, recovery | implemented (fake-port tests) |
| 69 | 5 | dependency rules | the Bots package imports nothing from Eagle; Eagle imports it one way |

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

## Next work, in order

1. Close the sixth round's three remaining races (delete-during-close, a stale
   snapshot reconciling a reservation, and an unavailable bot admitted during a
   lookup) and its P2s, then sign stage 4 off.
2. Finish the client surface: history paging, bot settings behind the `agent`
   capability, and an inspector that renders a bot's own state.

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

## Deferred daemon races (recorded, not fixed)

Stage 4 is implemented but **not signed off**. The sixth review round left three
reproducible races in the daemon, recorded here so stage 5 can start without pretending
they are closed:

1. An idle close finishing while a delete is in flight clears the delete's settling
   window, so a subscribe during the directory move can open a handle nothing owns.
2. A snapshot captured before an admission but delivered after it releases that
   admission's reservation, so 33 concurrent sends can cross the 32-entry budget.
3. `#handle` checks availability before an `await`, so an escalation during the lookup
   still admits work through the handle captured before it.

Its P2s are recorded too: a second failure during `recover` still marks the catalog
healthy; an oversized hub frame plus a backlog degrades instead of closing `1008`; a
refused `abort` on an unavailable bot has no originating record; a failed
`directory.remove` leaves a closed handle that `open` reuses; an `unknown` admission
confirmed by a queued retry can hold its reservation forever; and two of the round's
regression tests are insensitive to the bugs they name.

Stage 5 (the client) is being built against the protocol as documented; these races are
daemon-side and do not change the wire contract.

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
