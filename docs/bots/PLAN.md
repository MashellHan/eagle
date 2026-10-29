# Bots — delivery plan and current state

Status snapshot. The contracts live in
[PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[PROTOCOL.md](PROTOCOL.md), [RUNTIME.md](RUNTIME.md),
[OBSERVABILITY.md](OBSERVABILITY.md) and [TESTING.md](TESTING.md). This file says
what exists, what is next, and where it lives. Update it whenever a stage closes.

The current tool taxonomy, native extension integration and test-evidence map are
in [Extensions and tools](EXTENSIONS-AND-TOOLS.md). That guide also
specifies planned optional `memory`, `search` and `peers` groups and child-agent
discovery. Those additions are not implemented or enabled by this plan update.

## Where the code lives

### Exclusive search providers (2026-10-28)

Services now has one compact Search section: a single provider selector above
independent DeepSeek and Tavily key rows. Saving a key preserves selection; choosing
a provider deselects the other without deleting its key. A provider without a key
cannot be selected. Persistence serializes changes and publishes only after a
successful write. Neither an ambiguous file nor an upstream failure chooses a
provider by catalogue order.

Bot tools stay `web_search(query, count?, needContent?)` and `web_fetch(url)`.
A stable routing client resolves provider credentials at each invocation, so a warm
Bot follows saved changes without a new Harness; in-flight calls retain their client.
Tavily uses native Search/Extract through platform fetch, with no additional package.
Provider wire normalization stays below the tool interface and usage remains `search`.

The daemon gate passes 509 tests with 95.51% lines, 88.20% branches and 91.42%
functions. Both provider adapters and their shared HTTP client have 100% line/function
coverage. The hosted app passes 177 tests with 95.9% configured logic-line coverage.
Tests cover explicit selection, separate keys, persistence failure/retry, warm routing,
in-flight changes, schema equality, cancellation and refusal without fallback. Earlier
red runs also hit the existing row-cost benchmark fluctuation; its gate is unchanged.
Live paid searches and real-key mutation are not part of these checks.

### Native tool consolidation (2026-10-28)

The owner requires separate mandatory `core` and `coding` groups. `coding` is the native
pi-durable `CodingTools`; `core` adds a native-style `list` tool. The previous custom
read/write/command implementations and their aliases are removed, together with their
obsolete sandbox contract. Native tool integration tests replace implementation-specific
tests; the existing coverage scope and thresholds are unchanged. Missing-group and
existing-session regressions failed before implementation. The daemon gate passes 471
tests with 95.08% lines, 87.55% branches and 90.65% functions; `list` is 100% in all three.
The macOS app passes 119 feature and 46 design tests with 95.8% configured logic coverage.
The Bots client passes 121 tests with 90.6% configured logic coverage after meaningful
selected-bot and transport tests raised the observed 88.1% shortfall. The app bundle builds.
The rebuilt app shows both mandatory groups enabled with disabled switches. Disk-source
reloading is not part of the native Registry refresh described below.

### Native Registry refresh (2026-10-28)

All built-ins register once per Harness, while one explicit group-to-extension mapping
selects the agent's capabilities from the current native Registry snapshot. Every client
subscription refreshes that selection, including cached A -> B -> A switches, without a
new wire request, runtime watch or model call. Existing answers continue running. A failed
runtime subscription closes `1011` for the existing client retry policy; a storage fault
shares one Harness failure identity across the refresh and SDK notification channels.
Same-value settings saves retry an earlier application failure instead of silently skipping it.

The final daemon gate passes 482 tests, with 95.10% lines, 87.96% branches and 90.81%
functions. `list` and the retained workspace helpers are 100% in all three measured metrics.
The Bots client gate passes 121 tests at 90.6% logic coverage; the unchanged native app lane
passed 165 tests at 95.8%. The review's two failure-path findings were reproduced by real
WebSocket/SQLite tests, fixed, and accepted on follow-up static review. Original thresholds
and exclusions remain unchanged. Third-party plugins, filesystem watchers and source-module
hot loading were not added.

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

## Settings for effort, compaction and tool groups (2026-10-27)

The model page now carries three daemon-wide choices, each stored in the gateway settings
and applied to every bot: the reasoning level (default `medium`, written per bot and moved
into a live conversation with `root.configure`), automatic compaction (on by default, its
thresholds capped to `BOTS_CONTEXT_WINDOW` and overridable per `BOTS_COMPACTION*`), and the
tool groups (`core` mandatory, `herdr` optional). Compaction is accepted on a 1 200-token
window in `test/e2e/compaction.test.ts`: four `pi.compaction` entries, the request context
stops growing at ~2 095 characters, and all five turns stay readable through `history`.
Known gap, unchanged by this pass: the transcript a client receives after a compaction
starts at the compaction head, so scrollback after a reconnect now depends on the `history`
paging the client does not use yet. The `tasks` capability stays false, so a running
compaction is invisible in the UI.

## Sidebar groups and sample data (2026-10-27)

Real bots now live in sidebar groups the person owns: `catalog.json` stores
`groups: [{ id, title }]` in display order and each bot records its `groupId`, with
`POST/PATCH/DELETE /v1/groups`, `PUT /v1/groups/order` for the whole order, and
`PATCH /v1/bots/:id { groupId }` to file a bot. A group that still holds a bot cannot be
deleted (`409`), because emptying it is the person's decision, not a side effect of
deleting the folder.

The sample workspace is now opt-in: `加载 Mock 数据` in 通用 is off by default, and with it
off the sidebar shows only real groups and the conversation area shows an empty state
instead of falling back to the demo transcript. With it on, the sample groups follow the
real ones.

### The client slice (2026-10-27)

The sidebar renders the daemon's groups: one section per group in the daemon's order, an
empty group included, and one fixed `未分组` section at the end that appears only while a
bot is unfiled and cannot be renamed, moved or deleted. A membership pointing at a group
the catalog no longer lists reads as ungrouped, the same rule the daemon applies.

A group's context menu renames it, deletes it, and moves it up or down; reordering sends
the whole order once through `PUT /v1/groups/order`, so the ends disable the item instead
of writing a partial order. Deleting a group that still holds a bot offers the reason in
the menu instead of the item, and the daemon's `409` message is what the window shows if
one is attempted anyway. The header's `+` is now a menu with `新建 Bot` and `新建分组`, so
a new group is not confused with a new bot; creating a sample group stays in the sample
section's own menu.

A bot changes group from its row menu (移至 → a group, or 未分组), which is the same
`PATCH /v1/bots/:id { groupId }` call with `group: null` for the latter. Drag-and-drop was
built, verified once with a synthetic slow drag, and removed the same day: a normal
press-and-move on a `Button` row never started the drag session, so the affordance was
unreliable and the explicit menu stayed instead.

## Delegation, on-demand tools, live tasks (2026-10-27)

Three capabilities landed on top of the phase-2 tool work, in the order they were asked
for.

**Subagents.** `bots-agents` gives a bot `agent_spawn` / `agent_send` / `agent_stop`. A
child is an ownerless conversation in the same Harness, configured from the caller's agent
minus these tools, so delegation is one level deep. Its turns are driven inside a tool call
and its final text returns as the tool result; the transcript keeps only that result. The
`peers` capability stays false because nothing about children crosses the protocol yet.

**Deferred tools.** The eight `herdr` tools are declared deferred and `tool_search` is
installed with them, so a request carries seven tools instead of fifteen. Loading writes the
conversation's `modelTools`, which keeps them offered for the rest of the branch. A bot
without the herdr group gets no loader.

**Live tasks.** Every open bot follows `harness.taskGraph()` and pushes one `tasks` event;
snapshots carry the same list. The capability is now `tasks: true` and the inspector renders
the list under 例行任务 — kind, status, blocked reason and owner nesting — with an empty
state instead of a blank section. The panel's sections gained one decorated header style and
their own empty states.

Known gaps: children are invisible in the sidebar until a peers surface reads them; the
task panel is read-only (no retry from the UI, although `harness.retryTask` exists); and a
deferred tool loads per branch, so a compaction keeps it but a reset does not.

## Settings: real usage statistics (2026-10-27)

The 用量与账单 page no longer shows sample numbers. The daemon keeps one row per bot and
local day in `usage.sqlite` (90 days, pruned on boot and on write), turning the runtime's
cumulative `usage` into deltas; `GET /v1/usage?days=` serves today / 7 / 30 day totals, a
padded day series and the ten busiest bots with their catalog titles. The page shows the
three totals, a thirty-day bar chart whose bars name their day and tokens on hover, and the
five busiest bots — with an empty state instead of zeros before anything runs.

## Search provider and usage sources (2026-10-28)

Settings gained 服务: one card per third-party provider, starting with DeepSeek's search and
fetch APIs. The key is write-only and stored in the user's own config (`~/.config/eagle-bots/
providers.json`, 0600), never in the daemon root or a bot directory; `测试` spends one search
and reports latency. The `search` group ships unselected by default (the doc's rule for new
optional groups), installs the same single `tool-search` loader, and both tools are deferred.
`GET /v1/providers`, `PUT /v1/providers/:id` and `POST /v1/providers/:id/test` are the wire;
the runtime now hands the saved client to the registry, so a bot whose groups include `search`
loads `web_search`/`web_fetch` through `tool_search` and books one `search` call per call.

Usage turned into a source-agnostic meter: models book token deltas, search books calls, and
`GET /v1/usage` reports per-source totals beside the bots. The old token-only day table is
migrated into the `model` source on first open. 用量与账单 gained a 来源 card; a bot that only
searched shows calls instead of a zero token row.

The 模型 page's tool list gained the 搜索 switch, and the form's group list is now the
daemon's five groups with the four old ones as the fallback, so saving settings no longer
drops a stored `search` selection. A group whose own extension is not installed contributes
nothing, not even its loader: selecting `search` without a key offers no `tool_search`.

Historical evidence for the search-provider pass: the daemon gate passed 497 tests with 95.1% lines / 87.8% branches /
90.9% functions (thresholds 90/85/90); `typecheck`, `lint` and `fixtures:check` are green.
The Bots client passes 126 tests at 91.5% configured logic coverage after tests for provider
decoding, the additive `sources` field and the wire round trip. The Eagle app passes 175
tests at 95.8% configured logic coverage, and the app bundle builds. Snapshot review covers
服务 (configured and unconfigured), 用量与账单 with two sources and the 模型 tool list with the
搜索 row; those snapshots answer the daemon from a stub session, so they need neither a
daemon nor a key. Not verified in this pass: a real
DeepSeek key and a live `web_search` call, and a bot switching the `search` group on against
a running daemon (the runtime path is covered by the deterministic faux-model test).

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

| Milestone | Bot core lane — nocoli | Cloud and machine lane — project owner | Exit evidence |
| --- | --- | --- | --- |
| M0 — shared contracts | Bot vs conversation identity, plugin/context boundaries | Host and machine routing, owner-token/session and execution contract | Agreed interfaces, file ownership and compatibility fixtures; no deployment implied |
| M1 — Mac machine management and plugins | Minimal remote-tool extension wiring in the existing local Bot | Real macOS machine settings, authenticated routing, Herdr-independent execution and optional machine plugins | A Bot operates on B without Herdr; manual and Bot-assisted Herdr setup share verification; quitting UI keeps the execution service running |
| M2 — useful persistent assistant | Per-bot instructions, scoped memory, plugin selection, durable reminders and bounded loops | Required task/status presentation and notification/host status wiring | Role and explicit memory survive a new chat; a reminder survives daemon restart, fires once under its documented host conditions and can be cancelled |
| M3 — bot collaboration | Restricted Bot creation, shared room timeline, explicit turn routing and stop/budget limits | Forward and render the compatible room protocol | Parent creates a Bot without duplicate creation on retry; an @mention selects the recipient; room work stops and does not inherit unrelated private context |
| M4 — one complete external workflow | A connector and browser plugin used for sourced information collection | Required target capabilities and secure connector configuration | One real authorized X-information workflow produces source links/times; capability and upstream failures are visible |
| M5 — wider access and execution | Computer-use plugin and further connectors as required | Future shared Bot chat across Macs, Web/mobile access; assess PWA/native push and cloud-hosted runtime only when needed | Separately scoped after machine management/plugins; no shared chat view or Web UI requirement in M0–M1 |

M0 allows both lanes to proceed in parallel; the table orders integrated
acceptance, not every implementation task. Core work in M2 can proceed while
the cloud lane finishes M1 once the relevant contracts are fixed. Ownership is
confirmed: nocoli owns the Bot core; the project owner owns cloud and multi-device
access. Exact dates are not agreed. Current per-bot storage remains authoritative
on one host; the first remote slice adds neither cross-host replication nor
cloud persistence of chat bodies. Current Agent terminal input is not a generic
remote-command task API; that extension requires its own compatible release.

#### M0–M1 原子提交边界（2026-10-29）

每组包含对应契约、实现与回归；共享文件先落在依赖组，不能提交缺文件或不可编译的中间态。
以下编号是功能分组；实际提交顺序取决于可编译的依赖闭包和门禁，不能把工作树里的
implemented 状态解释为已经完整提交、安装或发布。
已合并的上游基线 `d77d676`、`90a633f` 保持独立，后续上游合并也单独提交。

| 分组 | 提交边界 | 收口依据 |
| --- | --- | --- |
| 1 | 同步运维：4h/8h driver、系统安装/停用、Git/进程回归与操作文档 | 实际 launchd、锁、首跑与失败候选证据；不与产品实现混合 |
| 2 | 原生 owner 认证：HTTP/WS 统一身份、凭据校验和契约 | helper 与真实路由证据分开；路由缺依赖不记通过 |
| 3 | 执行端基础：版本化协议、journal/runner、file/Herdr providers、relay 与恢复测试 | providers 引用 service，后者引用 config/journal；与第 4 组源代码按真实闭包落地，不留下缺失 import |
| 4 | 独立 Agent 生命周期：配置/身份/受控修复、launchd 与 CLI | 完整 agent-configuration 回归同时调用 service 与真实 CLI，须随第 3/4 组闭包保留；独立候选装配脚本及其测试归第 8 组 |
| 5 | macOS 机器管理：Keychain/连接、机器操作、本机接入/控制、文件授权 | SPM/coverage、HTTP/进程整链与图审；只依赖此前 Agent/协议 |
| 6 | macOS Herdr 插件：执行 client、按机器 session/setup 面板和操作恢复 | 先闭环未决书签 P1，再固定 UI 快照；共享两种 setup 的 Agent 实现属于第 3 组 |
| 7 | Bot remote：独立凭据 helper、每 Bot 授权与实际 runtime extension 接线 | 可再分 helper/授权与 extension 两个完整依赖片；真实 Harness/WS，凭据不入模型 |
| 8 | 集成门禁和交付：CI/hooks 接线、最终包及多 Mac 指南 | 全量门禁、审查与自有 feature 推送；无 PR/部署/npm 发布 |

实际提交前检查所选文件的 import/构建闭包；只为真实依赖合并相邻小组，不把全部功能压成一条。
每次正常执行 prepare 和 hooks。root 精确依赖不足时保留阻塞证据，不换版本或绕过门禁。
已正常提交的独立实现与门禁如下。每项数字只对应自己的受测树，不互相替代：

| 提交 | 完整依赖片 | 实际验证 |
| --- | --- | --- |
| `53aad3a`、`86fdf90` | Bot runtime/授权；独立的中断 setup 引用与删除清理 | 后一完整候选 Bots check 533/533；打包片未混入 |
| `1261190` | 原生连接、Keychain 与本机服务基础 | 169 feature + 49 design、93.7%；不含后续视图装配 |
| `c91c2bf` | 原生 RemoteTools DTO/HTTP client、完整测试和专属契约 | App 175 + 49、93.7%；四文件纯格式修复另为 `e3020f9` |
| `bbc826f` | 两份 RemoteTools 逻辑进入 App coverage 门禁及缺文件断言 | 178 + 49、2124/2260 = 94.0%；Reviewer 已关，不把旧 coverage 说成已包含二者 |
| `06ee74d` | host 可注入的 outbox refusal fallback | 默认路径保留，真实私有 fallback 红→绿；standalone Bots Swift 127/127、91.7% |
| `23f9c99` | 原生每 Bot 授权协调：四源、三份完整回归及对应契约 | tree `696291d7`，197 + 49、92.9%；Reviewer 00:26 已关，正常 pre-commit |
| `b731cd0` | 共享窗口的 owned Supervisor 生命周期及完整测试/契约 | tree `0585d145`，207 + 49、93.3%；Reviewer 00:31 已关，正常 pre-commit；父真实四场景 32 PASS 另留证 |
| `45c5cc9` | 两份 coverage 脚本的私有 scratch/含空格路径、原 fixture 回归及 TESTING 契约 | tree `bece2ed4`；4 个行为断言红→App 208 + 49、93.2%，同树 standalone 127/127、91.7%，strict format；Reviewer 00:48 已关，正常 pre-commit |
| `23d3c00` | Herdr client/恢复/面板七文件与真实 WS fixture/契约 | exact 220 + 49、94.1%，Reviewer 07:49，正常 Biome/Swift hooks |
| `f798c2b` | owner 认证、统一 HTTP/WS lease、真实 full-entry 回归与 REALTIME 契约 | tree c9a01433，exact root 183/183、typecheck/lint/build exit0，Reviewer 08:13，正常 hook |
| `4ea27f7` | 机器/Inspector/Settings UI、verification 实际工厂与对应完整回归/契约 | tree 10aa32cd，exact 232 + 49、94.0%，status-auth 与 token P1 已关，Reviewer 08:20，正常 Swift hook |
| `4c04259` | Agent/relay 执行生命周期 37 文件闭包，含原真实 launchd 回归 | tree c7bb86de，exact root 253/253、launchd 5/5、typecheck/lint/build；08:31 闭包 P2 于 08:35 关闭，正常 Biome hook |
| `4be7176` | 独立 helper 可执行目标、真实 Keychain 回归及专属契约 | tree ce3de9d2；127 + 2、91.7%、strict format；仅前置两份 Agent 测试变化，相同输入复用已审计，正常 hook |
| `9f559ea` | 独立 Bots bundle、包外启动/有界清理回归与契约 | tree 19622a0e，exact Bots 534/534、95.59/87.94/91.93%；退出等待 P2 经实际红→绿于08:41关闭，正常 Bots hook |
| `fece8f0` | 锁定 Agent/App 装配、真实 native/SIGKILL fixtures、CI/hooks 与交付契约 | tree 2c16555d；root 258/258、native 25/25、App 232 + 49/93.9%、strict format；两项装配 P2 红→绿后09:06闭审，正常 hook；隔离 release 装配43.618秒 exit0 |
| `80ef675` | 同步运维既有 Python 回归进入 root 普通 suite 及操作事实 | tree 6214499f；exact root 259/259、零失败/跳过，typecheck/lint/build exit0；08:48窄审的两文件patch字节未变，正常 Biome hook |

截至 2026-10-29 07:58，Herdr 原生 client/恢复/面板已以 `23d3c00` 正常提交。
七文件包含真实 WS `.mjs` fixture 和原 NATIVE 契约；exact 候选 220 + 49、
3269/3473 = 94.1%、strict format，正常 pre-commit 实跑 Biome 2.6.3 与 Swift。
Reviewer 07:49 已关闭。旧缺包拒绝日志及原 patch `ba319f34…` 保留；七文件不再暂存。
NATIVE-ACCESS/REMOTE-ACCESS/ARCHITECTURE 的其余行为契约仍随各实现组提交，
独立进度提交只收 CHECKPOINTS 与 PLAN。

最新已提交完整 App UI 候选 `4ea27f7` / tree `10aa32cd…` 通过 232 feature + 49 design、
3434/3655 = 94.0%、strict format。选定环境 token P1 已在真实 HTTP 红→绿后于
00:23 关闭，status-auth P2 于 08:04 关闭，Orca 两处目标/动作标签窄审关闭；
Inspector/settings 和 verification 组合已正常提交。standalone Bots 历史结果为 127/127、91.7%；旧 observed 安装的
二十处差异和首轮五个 fixture setup 失败保留，不能冒充新 exact gate。

07:25 用户授权新 artifact 传输入口后，43 个原始 tgz 已从 Huawei/Tencent 获取，
各自 lock SRI、名称、版本全匹配；父已独立复核。正常 root/Bots offline ci 均 exit 0，
以 task-private npm cache 供后续 bundle 继承。root/Bots lock hash 仍为 a2ab0b26… /
177687ad…，全局 registry 未改，实际版本差异已清零。Xcode 27.1 / 27A9275 就绪。
依赖阻塞已经解除，继续正常原子提交及所有 required gates，不重复旧网络探测。

00:34 私有 profile 裸执行窗口存活 8.544 秒，无子进程，只 SIGTERM 自有 PID；
`/tmp/eagle-root-native-launch-20261029-md7h6el3/evidence.json` 不证明完整 App 或正常退出。
07:53 完整 production Worker＋五个 local D1 migrations＋两本地 Agent 已独立 20 组
通过，source f7c58a729c… / 81 inputs；鉴权、真实 WS、命令/文件授权、去重、DO 报告、
撤销和所有自有进程/状态清理已验证。historyWrites=false，D1 legacy history 为空是契约。
证据 `/tmp/eagle-root-two-local-20261029-Qd3m9c/evidence.json`；不是物理双 Mac。

09:11 装配组已正常提交为 `fece8f0`，tree `2c16555d`。其完整 root 258/258、
native integration 25/25 均零失败/跳过；App 232 + 49、3433/3655 = 93.9%、
strict format 通过。release 装配43.618秒 exit0，580项源输入 hash/mode 回核一致，
内置 Agent/Bots/helper 及签名检查完成。完整 App 已交父入口，实际启动/正常退出验收
尚未返回；不以装配成功代替运行成功。随后同步组 `80ef675` / tree `6214499f` 完整
root 259/259、typecheck/lint/build均通过并正常提交。旧 87/97 文件备份与红日志不覆盖。

以下保留独立收尾边界：

| 待提交组 | 依赖与下一验证 |
| --- | --- |
| 完整 App 运行与本地 zip | 装配20文件已提交；父独占冻结driver验收，结果未返回。通过后本地ditto归档及SHA256，不进Git、不替换已安装App |
| 交付记录与正常推送 | 实现、契约和完整回归均已提交；整理实际运行证据和指南，汇总给父复核后持有scheduler共用锁执行正常push hooks |

完成 root/Bots、browser、native、package 与隔离完整 App gates 后汇总交父复核，
再以协调锁正常推 `MashellHan/eagle:feature/eagle-machines-herdr`，不推 main，
不发 PR、不部署或发布。物理 A/B 验收在用户取得分支后进行，不作为 push 前置条件。
基础机器管理/Herdr 不需模型 key；隔离 A Bot → B 则在该 profile 正常配置 Raven 并
新建测试 Bot，不复制日常 DB/凭据。兼容 backend 已在本机实测，两Mac SSH 步骤仍未运行。

#### M0–M1 执行计划更新（2026-10-29）

本轮实施范围是“macOS 多机器管理、基础跨机器执行、按机器安装可选 Herdr 能力”。
产品和安装边界见 [REMOTE-ACCESS.md](REMOTE-ACCESS.md)。以下是唯一阶段进度表；
2026-10-28 用户已恢复实施。Web UI 和跨 Mac 共享 Bot 聊天视图均延期，不作为本轮
前置条件；云端认证、机器目录和执行转发继续服务原生客户端。原有本地 Bot 增加
最小 remote-tool extension，真正打通执行和 setup，不扩展人格、记忆、群聊或业务调度。

| 阶段 | 状态 | 交付与依赖 | 验收证据 |
| --- | --- | --- | --- |
| R0 — 上游对齐与接口/设计 | integrated; review continues | d77d676 合并 3405ff8；90a633f 独立合并 7101566，保留 remote 注入及 off→omitted；复用单 loader/工具组 | 2026-10-28 launchd 已启用并首跑，旧冲突候选保留；第二次合并 Bots check 526/526、App build 通过，107 项保护改动恢复审计完整；见 [运行证据](../CHECKPOINTS.md) 和 [同步操作](../UPSTREAM-SYNC.md) |
| R1 — 基础 Agent 与真实机器页 | implemented; delivery gates open | 原生连接/钥匙串、真实目录、部署绑定、独立 launchd、同身份修复与每 Bot 授权已接线 | HTTP/WS、私有 Keychain、真实服务和 App 模型退出后执行已验证；完整 Worker＋两本地 Agent 20 组通过；整包 cold launch、真实 Access 与物理双 Mac 尚待验收 |
| R2 — 通用机器执行 | implemented; acceptance in progress | journal、有界命令与授权文件 provider 接真实 WS；实际 startDaemon/Harness/remote extension 已注入 helper 和每 Bot 权限 | 父真实本地主链 20/20；SIGKILL 保留 journal 14/14、丢失 journal 16/16，原 ID 查询且不重放；恢复已留入 native 回归并实跑 3/3。模型 SSE 为本地 fixture，非完整 Worker/D1 或物理 A/B Macs |
| R3 — 可配置机器插件与 Herdr | implemented; delivery gates open | 静态 provider、官方 installer、显式 named session 和机器面板已接线；原生/Bot 共用 run/get/cancel 与 journal，未决 ID 可恢复 | 父真实官方安装 9 项、原生 client→生产 relay→Agent→已装 Herdr 10 项通过；Bot 无 Herdr 返回 not_installed，既有会话保留；整包安装和物理双 Mac 尚未验证 |
| R4 — 多台 Mac 访问同一 Bot（后续独立交付） | planned | 本轮不实现跨 Mac 聊天视图；后续复用 v1 HTTP/WS 和原生 transport | 两客户端共享历史/实时消息及独立 Bot 主机生命周期的验收留后续；不阻塞本轮机器管理与插件交付 |
| R5 — 审查与跨机器交付 | in progress; release assembled, runtime pending | 权限/恢复/清理、token、lifecycle闭包与装配P2均已关闭；正常提交到80ef675；A/B与隔离指南已写并窄审 | exact root259/259、native25/25；App232+49/93.9%、strict format；standalone127/127/91.7%+Keychain2/2；Bots534/534；browser191通过/11既有条件排除。release装配43.618秒exit0、580源hash/mode一致；两次父driver在快退出utility身份采样处失败，均未启动App/daemon，不能判定App成败。现由本聊天父入口独占driver修正与后续运行，w1只读。通过后本地zip，正常push hooks及父汇总复核；物理双Mac为交付后验收，无PR/部署/npm发布或现有App替换 |

R1/R2/R3/R5 是本轮功能交付范围，不能退化为只操作已有 Herdr 终端；R4 和 Web UI 留后续。
按可独立审查的原子提交集成到本地 main，保留先前三个提交和父对话计划；只推送
MashellHan/eagle 的工作分支，不开 PR、不推 main、不发布 npm 或部署生产。
上游检查频率为每 4 小时（每天 6 次），替代此前“每天 4 次”的未启用设想。
另每 8 小时尝试合并上游；隔离 checkout 跑门禁后才正常快进推送自己的明确工作分支。
冲突、检查失败或远端并发前进时保留候选，禁止覆盖主工作区、force push 或绕过 hooks。
具体比较标准、调度验收和持久任务 prompt 见 [上游比较](REMOTE-ACCESS.md#每四小时比较上游)。

本轮我们负责云端、机器执行、安装管理与远程适配；nocoli 的人格、记忆、调度和
群聊仍是核心侧后续主线。需要的 Bot extension 接线应最小且可验证，不能留为 stub。
现有上游工具组和延迟加载优先评估复用，不另做竞争的 Bot 插件框架。
### Upstream optional tool track

The extension/tool track has its own proposed sequence in
[Extensions and tools](EXTENSIONS-AND-TOOLS.md#6-planned-optional-groups):

1. Add child discovery with `agent_list`, direct-parent target validation and the
   missing negative/stop/recovery tests for existing delegation tools.
2. Add optional `memory`: `memory_list`, `memory_search`, `memory_read`,
   `memory_write`, `memory_delete`, with explicit shared/private scope. Make the
   one native discovery loader independent of Herdr in this slice.
3. Optional `search` now supplies `web_search` and `web_fetch`, separating URL
   discovery from page retrieval with bounded, cancellable provider calls (see
   the delivered search-provider slice above).
4. Add optional `peers`: `peer_list`, `peer_send`, `peer_read`, with durable
   cross-Bot admission, observable settlement and bounded routing.

The other tool rows remain planned; search is implemented. New groups remain optional and
must not become default-enabled merely by extending the group-name list.

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
