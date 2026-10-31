# Bots — test contract

Status: **contracts for current implemented capabilities**. Peer exchanges and reported
pull-request journals are included from fixed upstream182fc1f; historical phase-1 labels
below retain their original scope. Tests are the specification of each layer and the
enforcement of the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md). Runtime
behaviour under test is described in [RUNTIME.md](RUNTIME.md); log assertions in
[OBSERVABILITY.md](OBSERVABILITY.md).

Current integration input is fixed upstream182fc1f704774eb37bdbc11cde017f8ff61f1c1a
over delivered sync parentcb64658. This is the last upstream update before the overall
sync project completes; no later fetch/pull/merge or restarted #109 monitor is part of it.
Native merge exit1 was a two-fixture conflict, not a product red. The owned admission/drop
assertions and all sync tests remain; upstream example-config inputs and wall-clock recovery
waiting are combined with them. Both original conflict stages and the editing-context failure
are retained under `.local/sync-upstream-content`.

Planned necessary checks for this combined input: normal root `npm run check`; independent
Bots `npm run check` (fixtures/tests/types/lint/coverage) and `npm run test:crash`; full
`npm run test:devices`; Swift build, strict format and both existing macOS/client default90
coverage scripts, recording their existing filter scopes. Exact eval cases are `chat-basic`,
`coding-fix-loop`, `replica-incremental`, `replica-local-run`, `replica-resources`,
`root-resources` and `fresh-resources` through the normal `--case` API. The new peer/pull
tool, journal, protocol and actual runtime tests are retained in the normal Bots suite.
Browser stays the normal delivery pre-push gate. No perf/live/App installation or CF gate
is claimed; this paragraph is a check plan, not evidence that these commands passed.

The recovery fixture merges U's existing single10-second wall-clock observation budget
with L's actual x-byte admission, original socket destruction/close, then barrier release.
It retains the empty original reply, same-ID exactly-once and finally cleanup assertions;
the former100 attempts were not a product deadline and no second wait budget was added.
The combined encrypted-history fixture uses actual startDaemon peer/PR tools, live PR events,
reopened journals and HTTP exchange answers, then the existing offline stored-object apply.
It checks resource refresh, a new peer's legacy-empty selection, same-ID retry/conflict and
exact page/history/section bytes with no passive local submission, tool task or peer exchange.
The first added-case failures were a duplicate test variable and an incorrect JSON-only
tool-result fixture assumption; neither is a product red. Original logs remain unchanged.
Formal Swift strict scope remains apps/macos Sources/Scripts/Tests (CI/pre-commit). The
extra bots-macos whole-package lint produced six-file diagnostics outside that formal scope;
its exit1 is retained, no client formatting was rewritten. The formal macOS strict run passed;
bots-macos follows its existing Swift test/build and filtered coverage checks.

Fixed-input local results (2026-10-31; source-v1 SHA90021cf1, complete707/selected614):

| Actual command/evidence label | Result and precise scope |
| --- | --- |
| `npm run check` / root-check-after-metadata | 267/267, types/lint/build exit0 after exact locked ws/zod registry metadata recovery; ENOTCACHED original retained. Root tests/build inputs stay unchanged by the later integration/client test additions. |
| `npm run typecheck && npm run lint` / combined-types-lint | exit0 on final TypeScript input, check-only;24 existing informational diagnostics. The preceding combined root run passed tests/types but failed lint on three new non-null assertions; replaced only by explicit asserts, original failure retained. |
| `npm --prefix apps/bots run check` / bots-check-first | ordinary881 and coverage881 are the same suite, not1762 different tests; fixtures/types/lint pass. Aggregate92.19 lines/88.77 branches/90.31 functions. Entire Bots inputs unchanged by the later external integration/client tests, so this exact scope is reused. |
| `npm run test:devices` / devices-combined-final | 23/23, including actual main peer/PR/history/offline combination, publisher/recipient first-winner, expiry/generation/binding/close, cold-unavailable and single-origin/network failures. All selected614 inputs match the freeze before/after. |
| `npm --prefix apps/bots run test:crash` / bots-crash | 17/17, including ready-only pending recovery. Bots input scope unchanged; no new unrelated perf matrix. |
| exact `eval -- --case` runs | chat-basic2 rows, coding-fix-loop10, replica-incremental2, replica-local-run0, replica-resources0, root-resources2, fresh-resources2; each actual case exit0 under the normal runner. A zero-row case is not relabeled as a provider interaction. |
| `swift build --package-path apps/macos` and formal macOS strict | both exit0 on combined production; upstream/existing build warnings retained. No client whole-package formatting added. |
| `sh apps/macos/Scripts/coverage.sh` | default90,208/51/60 tests; existing filtered1484/1593=93.2%. Actual script includes its existing repeated design-file report rows; no filter/script change or claim of all new logic90%. |
| `sh apps/bots-macos/Scripts/coverage.sh` / swift-client-coverage-peer-pull | default90,40/46/52 tests; existing filtered2026/2229=90.9%. Original1975/2229=88.6% failure retained. Two added peer/PR client regressions cover selected reads, failure preserving the last list, selection reset, PR whole-list replacement and no send; no production/threshold/filter change. |

Every command retains cwd/start/raw log/exit hashes and before/after file maps. Original
710/711 map entries include four explicitly deleted legacy paths; the final live tree has707
files. Later source selection adds the whole independent client and macOS script inputs to
the old550 rule (four upstream removals and68 additions give614); the full index map also
binds locks/config/owners/assets. Earlier gate receipts retain their original scope rather
than claiming all614 ran then. Runner-v3 snapshots use read-only ls-files, avoiding the
original write-tree/index-lock helper collision; that collision never started a root gate.
The optional installed-lock inventory's two false missing leaves remain unchanged, with a
separate ancestry correction90ebbfb0. No user secret/vault or physical App/live verification
is claimed. Browser remains the normal delivery pre-push gate; the native focus probe retains
its existing interactive CI-only boundary in pre-push, and was not run by this background slice.

The root `npm run check` and Linux CI job use only the root lock and top-level
`tests/*.test.ts`; they never require the independent Bots installation. Bots keeps
its own `npm ci` / `npm run check` and is not a root workspace member.

App/device integration lives in `tests/device-integration/` and runs explicitly as
`npm run test:devices` from the root, after root `npm ci`, independent
`npm --prefix apps/bots ci`, and `npm --workspace @nocoo/eagle-agent run build`.
Those tests cross real process/HTTP/socket ports; Bots product code never imports
Eagle, Agent or Worker sources. Missing dependencies fail this explicit suite.
The macOS CI job prepares these two independent installs, runs the integration
suite, and retains its Swift build/format/coverage gates. Local candidate acceptance
also runs the Bots and Bots-macOS gates; no default root test silently opts into
cross-product tests. Process tests are not evidence of physical multi-Mac operation
or distribution signing.

## The loop

For every behaviour change:

1. Update the owning document first when a contract, semantic or log event changes.
2. Write the test that demonstrates the behaviour. Run it. Record the failure in
   the commit body as a `Red:` line.
3. Write the smallest implementation that passes.
4. Run the layer tests, then the stage gate.
5. Commit once: documents + the test that failed first + implementation. `main`
   never holds a red commit.

```
Red: <test name> — <the failure it produced>
Tests: <files or names>
Checks: cd apps/bots && npm run check
```

## What may be faked

| Real, never faked | Faked | Why the boundary is there |
| --- | --- | --- |
| Protocol encode/decode against fixtures | — | A codec that only round-trips its own bug proves nothing |
| `BotDirectory` writes (real temp dir) | — | Atomicity is a filesystem property |
| `EventHub` ordering, coalescing, paging | — | Pure in-memory async |
| SQLite storage and `Harness.open` | — | `test/runtime/**` uses real `openNodeSqliteStorage` in a temp dir |
| HTTP and WebSocket transport (real `node:http`, ephemeral port) | — | Auth, close codes and paging only exist on a socket |
| pi-durable itself | Model provider only | `fauxProvider()` replaces the network, not the runtime |
| Swift `ConversationSocket` framing | — | It connects to the same fixture server the daemon tests use |
| — | `RuntimePort` in core tests | `testing/FakeRuntime.ts` replays scripted `RuntimeEvent`s |
| — | Clock, timers | Coalescing, idle close, quarantine retry |
| — | `CatalogPort` / `ConversationPort` in VM tests | Domain fakes; no sockets |
| — | `URLProtocol` for **HTTP only** | It cannot intercept `URLSessionWebSocketTask`; a WebSocket fake must be a real local server |

## Test ladder

Each row is one commit-sized step; the `Needs` column is the precondition. A step
is never started before its preconditions are green.

### Stage 1 — wire and project skeleton

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 1 | `test/protocol/fixtures.test.ts` | `decodes every committed fixture without loss` | package, tsconfig, `fixtures:check` harness |
| 2 | `test/protocol/events.test.ts` | `encodes a snapshot byte-identically to its fixture` | 1 |
| 3 | `test/protocol/commands.test.ts` | `rejects a send without a requestId or trace` | 1 |
| 4 | `test/protocol/limits.test.ts` | `rejects text longer than 8000 characters and frames over 256 KiB` | 1 |
| 5 | `test/protocol/versioning.test.ts` | `ignores an unknown event type but consumes its rev` | 1 |
| 6 | `test/log/shape.test.ts` | `every event name a source file uses is declared` (subset only; equality is asserted from stage 4 by `catalog.test.ts`) | log module |
| 7 | `test/log/redaction.test.ts` | `a provider error echoing the prompt never reaches the log` | log module |
| 8 | `test/architecture.test.ts` | `core imports nothing from protocol or pi-durable` | 1, 6 |

### Stage 2 — domain, catalog and lifecycle primitives

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 9 | `test/core/directory.test.ts` | `keeps the previous catalog when a write is interrupted` | 8 |
| 10 | `test/core/directory.test.ts` | `delete reconciliation finishes an interrupted delete` | 9 |
| 11 | `test/core/runtimeport.test.ts` | `the fake runtime satisfies the port contract` | 8 |
| 12 | `test/core/hub.test.ts` | `assigns strictly increasing revisions per bot` | 11 |
| 13 | `test/core/hub.test.ts` | `delivers the same sequence to every subscriber and drops none` | 12 |
| 14 | `test/core/hub.test.ts` | `downgrades a subscriber that falls behind to snapshot-only` | 12 |
| 15 | `test/core/hub.test.ts` | `coalesces deltas inside one 50ms window with a fake clock` | 12 |
| 16 | `test/core/hub.test.ts` | `renders a fresh snapshot when the runtime reports one` | 12 |
| 17 | `test/core/service.test.ts` | `send requires a subscription and answers a connection-scoped record` | 13 |
| 18 | `test/core/service.test.ts` | `a repeated send with the same requestId returns the stored record` | 17 |
| 19 | `test/core/service.test.ts` | `queued, placed and done map to one submissionId` | 17 |
| 20 | `test/core/service.test.ts` | `unanswered keeps its reason and never invents a settlement` | 17 |
| 21 | `test/core/service.test.ts` | `history pages older messages without touching the newest window` | 17 |
| 22 | `test/core/service.test.ts` | `resync returns a snapshot whose rev equals the last published event` | 17 |

### Stage 3 — pi adapter

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 23 | `test/runtime/mapEvents.test.ts` | `maps a recorded run to append, delta, append, submission, status` | 11 |
| 24 | `test/runtime/mapEvents.test.ts` | `builds the provisional from message_start content` | 23 |
| 25 | `test/runtime/mapEvents.test.ts` | `applies block and message replacements without loss, including a start block with no delta` | 23 |
| 25b | `test/runtime/mapEvents.test.ts` | `two text blocks receive deltas at their own indexes` | 23 |
| 25c | `test/runtime/mapEvents.test.ts` | `an aborted entry replaces the provisional that a late attach already delivered` | 23 |
| 25d | `test/runtime/mapEvents.test.ts` | `an oversized projection is withheld: the notice takes the entry id, replaces the provisional, and a reconnect sees the same notice` | 23 |
| 26 | `test/runtime/mapEvents.test.ts` | `a failed attempt finalizes its provisional and the retry gets a new id` | 23 |
| 26b | `test/runtime/mapEvents.test.ts` | `deferred_poll drops the provisional through a snapshot with streaming null` | 23 |
| 27 | `test/runtime/mapEvents.test.ts` | `maps every stopReason to a message state` | 23 |
| 28 | `test/runtime/adapter.test.ts` | `one turn appends exactly one pi.assistant entry` | 23 |
| 29 | `test/runtime/idempotency.test.ts` | `the same requestId returns one record and emits no new events` | 28 |
| 30 | `test/runtime/adapter.test.ts` | `abort settles the running and queued inputs with reason aborted` | 28 |
| 31 | `test/runtime/adapter.test.ts` | `a provider error settles unanswered with reason model_error` | 28 |
| 32 | `test/runtime/adapter.test.ts` | `a model asking for a tool gets an error result and the run continues` | 28 |
| 33 | `test/runtime/failures.test.ts` | `a parked task surfaces as task_parked from onReport, once` | 28 |
| 34 | `test/runtime/failures.test.ts` | `a storage failure closes the harness and classifies storage_failed` | 28 |
| 35 | `test/runtime/failures.test.ts` | `open resumes a run interrupted by close` | 28 |
| 36 | `test/runtime/adapter.test.ts` | `close resolves timeout without dropping the handle` | 28 |

### Stage 4 — server, lifecycle and end-to-end

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 37 | `test/server/auth.test.ts` | `rejects a wrong bearer token before upgrade` | 17 |
| 38 | `test/server/socket.test.ts` | `closes 1008 when hello is not the first frame` | 37 |
| 39 | `test/server/socket.test.ts` | `closes 4004 for an unknown bot and 4090 while quarantined` | 37 |
| 40 | `test/server/socket.test.ts` | `a second subscribe on one connection closes 1008` | 37 |
| 41 | `test/server/catalog.test.ts` | `create, rename and delete keep the catalog absolute` | 9, 37 |
| 42 | `test/log/origin.test.ts` | `a failed operation has exactly one error record, at the originating layer, counted by failure id` | 6, 38 |
| 43 | `test/log/trace.test.ts` | `R1–R3 hold with a fake clock and a drain barrier` | 42 |
| 44 | `test/core/registry.test.ts` | `open is idempotent and shared by concurrent subscribers` | 28 |
| 45 | `test/core/registry.test.ts` | `an idle bot closes after idleCloseMs and reopens on demand` | 44 |
| 46 | `test/core/registry.test.ts` | `a timed-out close quarantines and refuses open and delete` | 36, 44 |
| 47 | `test/core/registry.test.ts` | `recovery scan resumes active bots and leaves the rest closed` | 44 |
| 48 | `test/core/singleton.test.ts` | `a live daemon rejects a second instance on the same root` | 44 |
| 49 | `test/e2e/journey.test.ts` | `create, chat three turns, reconnect and delete` | 41, 44 |
| 50 | `test/e2e/journey.test.ts` | `two bots stream independently with separate revisions` | 49 |
| 51 | `test/e2e/journey.test.ts` | `a lost submission reply is recovered by re-sending the requestId` | 49 |
| 52 | `test/e2e/journey.test.ts` | `a bot joining mid-answer receives the partial in the snapshot` | 49 |
| 52b | `test/e2e/outbox.test.ts` | `a send persisted before the socket write is reconciled after a daemon restart` | 49 |
| 52c | `test/e2e/paging.test.ts` | `history pages older messages and the newest window is never re-fetched` | 49 |
| 52e | `test/e2e/outbox.test.ts` | `a not_admitted rejection restores the draft, an unknown result keeps the requestId` | 49 |
| 52f | `test/e2e/outbox.test.ts` | `an admitted input whose status read fails keeps the outbox entry and reconciles on re-send` | 49 |
| 52g | `test/e2e/overflow.test.ts` | `an over-limit attempt is withdrawn; a late join during it sees streaming null, and the notice replaces it after commit` | 49 |
| 52d | `test/e2e/ordering.test.ts` | `a late connection-scoped record never downgrades a settlement` | 49 |
| 53 | `test/crash/sigkill.test.ts` | `killing the daemon mid-answer loses no message and duplicates none` | 49 |
| 53b | `test/crash/delete.test.ts` | `R4: a delete killed after rename reconciles on the next start` | 49 |
| 54 | `test/crash/singleton.test.ts` | `a SIGKILLed daemon is taken over on the next start` | 48 |

### Stage 5 — client

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 55 | `BotsCoreTests/FixtureDecodingTests.swift` | `decodes every committed fixture` | 1 |
| 56 | `BotsCoreTests/ReducerTests.swift` | `append upserts by id and applies replaces` | 55 |
| 57 | `BotsCoreTests/ReducerTests.swift` | `delta applies text, block and message changes in order` | 55 |
| 58 | `BotsCoreTests/ReducerTests.swift` | `a snapshot replaces state and resets the baseline` | 55 |
| 59 | `BotsTransportTests/GapTests.swift` | `a revision gap drops events, resyncs once and reconnects after two failures (fake clock)` | 61 |
| 60 | `BotsCoreTests/ReducerTests.swift` | `a duplicate submission reply does not disturb the transcript` | 55 |
| 61 | `BotsTransportTests/SocketTests.swift` | `speaks the fixture server: handshake, subscribe, stream, paging` | fixture server |
| 62 | `BotsTransportTests/SocketTests.swift` | `maps close codes to connection states and reconnects on 1006` | 61 |
| 62b | `BotsTransportTests/GapTests.swift` | `a snapshot resets the gap counters` | 59 |
| 63 | `BotsFeaturesTests/ConversationTests.swift` | `connecting, ready, resync, reconnect and failed` | 59, 61 |
| 64 | `BotsFeaturesTests/ComposerTests.swift` | `optimistic bubble is replaced by the submission and append` | 60 |
| 65 | `BotsFeaturesTests/ComposerTests.swift` | `retry reuses the same requestId, including after an app restart` | 64 |
| 66 | `BotsFeaturesTests/ComposerTests.swift` | `sending while busy queues with followUp and survives a restart of the view` | 64 |
| 67 | `BotsFeaturesTests/CatalogTests.swift` | `create selects the new bot; delete removes it; a push updates the list` | 61 |
| 68 | `BotsFeaturesTests/RecoveryTests.swift` | `recover reopens an unavailable bot and leaves a healthy one untouched` | 63 |
| 68b | `BotsFeaturesTests/ComposerTests.swift` | `only not_admitted clears the outbox entry; unknown and runtime keep it` | 64 |
| 69 | `BotsCoreTests/DependencyRulesTests.swift` | `no networking API in core or features; no wire decoding outside transport` | 55 |
| 70 | `test/e2e/tools.test.ts` (daemon) | `a tool round is live in the transcript and in a later snapshot` | real stack + faux model |
| 71 | `test/runtime/tools.test.ts` | `a tool call and its result are live transcript rows and survive a late join` | 70 |
| 72 | `BotsCoreTests/FixtureDecodingTests.swift` | `the tool snapshot carries calls and their results` | 55 |
| 73 | `EagleFeaturesTests/BotsPresenterTests.swift` | `a call without its result is a running row while the run works`; `the result pairs with its call by id` | 72 |
| 74 | `test/server/gateway.test.ts` | `settings round-trip, stay 0600 and never expose the key`; `the probe reports reachability, auth and model count` | — |
| 75 | `test/server/settings.test.ts` | `the settings endpoints read, validate, save and test behind the bearer` | 74 |
| 76 | `test/core/registry.test.ts` | `a gateway model change reaches existing bots and new ones` | 75 |
| 77 | `test/server/update.test.ts` | `name, label and face are editable over PATCH` | 75 |
| 78 | `BotsFeaturesTests/CatalogTests.swift` | `testUpdateChangesNameLabelAndFaceAndReloadsTheCatalog` | 77 |

## Golden fixtures

- `fixtures/bots-protocol/*.json` are normative. `npm run fixtures:check` encodes
  every fixture through the daemon codec and fails on any byte difference;
  `npm run fixtures:write` regenerates them after a documented protocol change.
- `test/protocol/fixtures.test.ts` also asserts that the file set equals the table
  in [PROTOCOL.md](PROTOCOL.md#fixtures): an undocumented fixture fails.
- The Swift package decodes the same directory through a relative path, so one
  changed fixture breaks both sides in the same commit.
- Golden event sequences (not just single frames) are checked in under
  `test/runtime/golden/` for: a plain answer, a `message_start` that already carries
  content, an answer with deltas, two text blocks, a retry inside one turn, a
  tool-call attempt, an abort with a queued input, a provider error and a deferred
  poll. Each file holds the recorded pi events and the mapper's frozen output;
  `scripts/record-golden.ts` records from a real Harness over pi-ai's faux provider
  and `npm run golden:record` rewrites the frozen half, which is then reviewed like
  code. Shapes a faux provider cannot reach (a withdrawn over-limit attempt, a
  block change with no delta, the `deferred_poll` reset) are asserted from
  hand-built events in `mapEvents.test.ts`.
- `npm run test:runtime` and `npm run test:protocol` run one stage's suite; `npm test`
  and `npm run coverage` run the deterministic file list that includes both.
- Recovery (`test/runtime/failures.test.ts`) and the restart-count cases use a real
  child process that is `SIGKILL`ed mid-answer, because no in-process shutdown
  produces an interrupted task.

## Fault injection

| Injected fault | Expected |
| --- | --- |
| Wrong bearer token | HTTP 401; no `core.*` log; no bot opened |
| Malformed JSON frame | Close 1008; `protocol.decode.fail` only |
| Unknown command type | `error{invalid_command}`, connection kept |
| `subscribe` to a missing bot | Close 4004; `core.bot.resolve.fail` only |

| `send` before admission rejects | `error{disposition:"not_admitted"}`, **no** `submission` frame; the client restores the draft |
| Admission succeeded, reading its record failed | `error{disposition:"unknown"}`, outbox entry kept, reconciled by re-sending |
| Create or rename whose `BotSummary` would exceed 1 200 encoded bytes (a long title or a long model id) | Refused before the write; the catalog frame stays inside 200 × 1 200 B |
| Session failure on all three channels | One failure identity; a reopen then a new failure gets a new one |
| Retired watch | Re-attach, fresh snapshot, no counter, no error (classifier level; no integration injection exists upstream) |
| Admitted input whose record read fails inside the adapter | Asserted at the service and adapter boundaries; a real storage fault on that read has no injection point yet |
| Reply to `send` lost | Re-send the same `requestId` returns the record; no duplicate entry |
| Provider error | `unanswered{reason:"model_error"}`; provider text absent from logs |
| `runtime.open` rejects | `error` carries `failure` whose origin is `runtime`; core logs `warn` with the same id |
| Oversized message projection | Attempt withdrawn via snapshot (streaming null), notice replaces it after commit, no frame over 256 KiB |
| Late join during an over-limit attempt | Snapshot has no oversized partial; client never receives stale content |
| Abort with a queued input | Both settle `unanswered{reason:"aborted"}`; inbox empty |
| Parked task | One `error{kind:"task_parked"}` within 60 s; `recover` clears it |
| `listener_error` watch end once | Reattach + snapshot; no client-visible error, no failure minted |
| `listener_error` watch end three times in 60 s | Exactly one `error{kind:"internal"}`; bot `unavailable` while it keeps its Harness; `recover` re-attaches that harness's watch, never a second owner |
| `session_failed` watch end | Immediate `storage_failed` failure, same id as `harness.closed{failed}`; one error |
| `retired` watch end | Re-acquire, no counter, no error |
| `session.sqlite` replaced with junk | That bot `unavailable`; other bots unaffected; daemon alive |
| `close` never resolves | Quarantine; open and delete refused; retry every 30 s |
| Subscriber stops reading | Queue overflow, or more than 1 MiB unsent on its socket → snapshot-only; daemon keeps serving others. The queue path is asserted in `test/core/hub.test.ts`; the transport threshold is the same mechanism and is not covered by a deterministic slow-TCP test |
| Second daemon on the same root | Exits non-zero; first unaffected |
| Two daemons racing the same stale lock | Exactly one wins; the loser exits non-zero |
| Provider returns `deferred` then answers | `running:true` throughout, no fake streaming message, one final answer |
| Provider stops at `length` | `Message.stopReason:"length"`; client renders its own notice |
| `SIGKILL` mid-answer | Restart resumes; no message lost or duplicated |
| Delete killed after rename | Restart reconciliation finishes the delete |
| Open during an idle close | The open waits for the close and owns the handle it creates |
| Delete during a warm-up open | The delete waits for the open to settle, then closes the handle it created |
| Two concurrent creates for the last catalog slot | One succeeds, one is refused; the catalog is never 201 |
| Two concurrent sends at the pending limit | Exactly the allowed number is admitted |
| Session storage failure mid-run | The bot becomes `unavailable`; `recover` re-opens it and the next turn works |
| One bot's `session.sqlite` is junk | That bot is `unavailable`; another bot completes a turn |
| Shutdown with several stalled handles | One shared deadline, not one per bot; each is recorded as a degraded close |
| Catalog change between upgrade and `hello` | The change reaches the client in `welcome`, never as a frame before it |

## Crash test

`test/crash/sigkill.test.ts` runs from the stage that implements the daemon
(stage 4) and is mandatory from then on; it is opt-in for the fast gate
(`npm run test:crash`).

The barrier is a fact about the provider, not about timing or a log state. The
test's provider emits one streamed chunk, writes a sentinel file, and then **never
returns** — completion is blocked by construction, so no answer can land between the
barrier and the kill. The test waits for the sentinel *and* for the daemon's
`append` record whose whitelisted `detail` carries `role="assistant"`,
`state="streaming"` and a `messageId`, then `SIGKILL`s the process.

A second case kills **before** any assistant provisional exists, only after
admission (no sentinel chunk emitted), and asserts recovery without requiring an
aborted assistant entry. A third case kills after `rename` during delete
(`test/crash/delete.test.ts`) and asserts only post-restart reconciliation, since a
killed process cannot log its own failure.

After restart it asserts: exactly one admitted submission, the interrupted attempt
retained as an `aborted` assistant entry (RUNTIME F22), exactly one completed
answer for the same input, no duplicate submission and no duplicate user entry. A
second case kills after `rename` during delete and asserts that startup
reconciliation finished the delete; a `SIGKILL`ed process cannot log its own
failure, so the evidence is the post-restart `core.reconcile.ok`.

## Performance measurement

`npm run perf` is separate from `npm run check` because absolute milliseconds are
not deterministic. It records the environment, samples each operation five times,
reports the median, and asserts only generous bounds so a real regression fails
while noise does not.

| Measurement | Bound | Documented value |
| --- | --- | --- |
| `Harness.open` + `root()` on an empty bot | < 250 ms | 7 ms |
| Reopen a bot with 400 entries | < 100 ms | 3 ms |
| One answered turn (faux) | < 200 ms | 2–7 ms |
| 20 bots open in one process | < 1 s | 30 ms |

The script prints machine, Node version, filesystem and sample values; the
observed numbers are copied into [CHECKPOINTS.md](CHECKPOINTS.md). Changing a
bound means changing [PRODUCT.md](PRODUCT.md#speed-targets) in the same commit.

## Gates

```sh
cd apps/bots
npm run fixtures:check
npm test                # deterministic unit and integration tests only (test/tools included)
npm run typecheck       # tsc --noEmit
npm run lint            # biome check --error-on-warnings .
npm run coverage        # same file list as `npm test`, thresholds enforced
npm run test:crash      # test/crash/** only; mandatory from stage 4
npm run perf            # test/perf/** only; informational
npm run check           # fixtures:check, test, typecheck, lint, coverage

cd apps/bots-macos
swift test
./Scripts/coverage.sh    # Bots logic gate, own script
```

One file list, defined once in `scripts/unit-files.sh` and used by both `npm test`
and `npm run coverage`, so the deterministic gate and the coverage gate can never
drift. `test/crash/**` and `test/perf/**` are deliberately absent from it: a real
`SIGKILL` and a real clock are not deterministic. `package.json` is the single
authority for these commands; the README points here instead of restating them.

`npm run coverage` runs Node's own reporter with enforced thresholds:

```sh
node --test \
  --experimental-test-coverage \
  --test-coverage-include='src/**/*.ts' \
  --test-coverage-exclude='src/testing/**' \
  --test-coverage-exclude='src/**/*.test.ts' \
  --test-coverage-include-all \
  --test-coverage-lines=90 --test-coverage-functions=90 --test-coverage-branches=85 \
  $(sh scripts/unit-files.sh)
```

`--test-coverage-include-all` counts files no test imported, so an untested module
cannot hide. The thresholds make the command exit non-zero; stage signoff records
the run.

Rules:

- No skipped or focused tests. A blocked test is deleted or fixed; `test.skip`,
  `.only` or `XCTSkip` in a diff fails review.
- Time-dependent tests inject a clock. Only the crash and perf suites touch real
  time, and neither is part of `npm test`.
- No test opens a network socket other than a loopback fixture server it owns.
- Coverage is a floor: a layer at 95% with no fault-injection test is not done.

## Definition of done for a stage

Gates accumulate: a stage must keep every earlier stage's gates green and add its
own. Requirements that need a later stage's machinery start when that machinery
exists — this prevents the circular gate where stage 1 must pass a `SIGKILL` test
that only stage 4 can run.

| Gate | Enforced from |
| --- | --- |
| `npm test` + `npm run typecheck` + `npm run lint` + `fixtures:check` | stage 1 |
| `npm run coverage` with enforced thresholds | stage 1 |
| `test/log/shape.test.ts` asserting `used ⊆ declared` | stage 1 |
| `test/log/catalog.test.ts` asserting bidirectional equality | stage 4 (the first stage where every emit site exists) |
| `test/log/origin.test.ts` for each layer that exists | stage 4 |
| `npm run test:crash` | stage 4 |
| `npm run perf` | stage 4 |
| `test/tools/**` per-tool tests and the faux-provider tool round | phase 2 slice 1 |
| `swift test` + `Scripts/coverage.sh` | stage 5 |

Per stage:

1. Every ladder row of the stage is green; documents updated in the same commits.
2. The gates listed above for that stage pass; output is quoted in the checkpoint.
3. No widened limits, silenced log, swallowed error or new `test.only`.
4. [CHECKPOINTS.md](CHECKPOINTS.md) records what a user can see, what was run, and
   the next broken hop.


## P0 history handoff evidence

On Node 26.9.0, `test/runtime/history-replica.test.ts` uses independent real Harnesses
and SQLite files with only the provider controlled. It checks actual source file bytes,
`pi.tool-result`, 220+ original records across SDK pages/UI-window size, reset, instruction
changes, compaction, edits/head references, opaque fields, attachments and resource bytes.
Raw imports and reconstructed SDK context are compared independently of receipt re-export.
A same-head source continuation controls system preparation; public pi-ai replay compares
all effective sections and complete ordered tool declarations without dropping system
messages. B runs with A closed; A/B also run independently from the same head and exchange
branches; a third clean SQLite imports fork history and reconstructs its context.
An actual core+Herdr SDK run checks section insertion order, complete prompt text and
mid-conversation update rendering across initial export, pinned receipt and passive B/C
imports. Different section orders must have different heads. Comparisons preserve order
without the production hash encoder; fork exports and third-library receipts also check
original entry/task provenance through the one-time reverse mapping.

`test/e2e/history-replica.test.ts` drives the real authenticated daemon and registry,
including unsupported runtimes, methods and a dedicated 8 MiB request cap. The existing
8 KiB ordinary-body limit is unchanged. `fixtures/bots-sync/history.v1.json` is normative;
`test/runtime/history-validation.test.ts` checks its exact fields and malformed-message,
digest, reference, resource and continuation-compatibility refusals.

`test/crash/history-replica.test.ts` SIGKILLs owned child processes at actual SQLite commit
barriers: output before export, import before reply, fork intent before admission, and
input placed before reply. Reopen/retry uses the original IDs without duplicate input
or model execution. The child receives fixture configuration through stdin and inherits
only an environment allowlist. It never uses a paid/live model or the daily App.

A genuine nested SDK tool call writes a file, then export fails closed both directly
and through a fork ancestor. Its original entries/byTaskId remain intact. This is a
compatibility refusal, not nested-result preservation: full nested facts archival is
outside P0. Instruction/skill bytes not installed in the target similarly prevent
continuation. Passive import itself remains zero-execution.

Local red/green/gate logs are `.local/sync-p0/`. Normal Bots check/coverage, crash suite,
local-run eval and Bots-macOS tests are required before the candidate is handed off;
PLAN/checkpoint record actual results. Cloud, Tailscale, physical Macs and App UI are not
certified by these tests. Root/browser/macOS release gates run at normal pre-push.


## P1 local incremental evidence boundary

`test/runtime/replica-sync.test.ts` uses independent real Harness/SQLite and replica.sqlite
files. It exercises >225 original records, tool bytes/results, compaction/head/edit mapping,
full raw context plus ordered system/tool replay against A's same-head provider control,
A/B branch exchange/reopen and A-offline B continuation. Out-of-order 3/1/2, duplicates,
cross-stream missing dependencies, conflicting IDs, Bot/epoch bindings, resource retention,
invalid digest/edit aliases, standalone resource SRI and the normative page are explicit cases. Invalid sources
remain unapplied across reopen while an existing complete local head can still run.

`test/e2e/replica-sync.test.ts` exercises authenticated real daemon calls, including actual
SDK raw UTF-8 history >8 MiB transferred in multiple pages. Every complete apply wrapper
is measured, duplicate page application is idempotent, target raw bytes/context are read
from SDK after daemon close, and target runs through the real provider path. Subsequent
pulls carry only new facts. A separate oversized-single-entry refusal preserves the source
sequence. The scan-failure test injects a real SQLite table outage: consecutive failures log once,
a successful repair closes the episode, and a later failure has a new identity while local
SDK input continues. A real interleaved entry/AgentDoc commit checks the publication cutoff.
The original compaction 5+5 assertion remains unchanged. A native head test configures v2
after the last entry, pins it, then adds v3/entries/compaction: old context remains exact and
the new run uses v2. SDK adopted-write measurements track representative original data,
real tool-result and attachment bytes across native/incoming heads. Old entry counts and
body bytes remain fixed over three increments; automatic imports docs write no old body.
Only the explicit P0 export in that fixture stores one carrier. Metadata mapping growth
and full local validation cost remain explicit limits, rather than a constant-space claim.
The SQLite body-read test counts real returned rows and proves iteration stops
when the next event will exceed the byte budget.

`test/crash/replica-sync.test.ts` owns children and uses SIGKILL at actual durable intent,
SDK placed-input, output-entry, incoming-log and passive-SDK commit boundaries. Reopen
proves original IDs, one execution, complete outbox recovery, no foreign run recovery and
applied only after passive materialization. Callback barriers block only owned test
children, never production Session callbacks.

Entry404, cumulative-history400, invalid-head/reopen, eager body-read and edit-alias reds
are retained under `.local/sync-p1/`, as are the compaction duplicate-body and old-head
AgentDoc/prefix-growth reds. On Node 26.9.0 the first frozen local candidate passed
`compact-bots-check-final.log`: ordinary and coverage each 673/673 (the same suite, not
1346 distinct tests), typecheck/lint, coverage lines 95.46%, branches 88.76%, functions
90.97%. `compact-crash-final.log` passed 8/8. `compact-eval-final.log` passed all 11 local
cases: the actual `--case=replica-incremental` argument was not parsed as a filter, so
the receipt records the full set rather than claiming a targeted-only run.
`compact-perf-final.log` passed 1/1; its five-sample medians were 3/1/4/10 ms for empty
open, 400-entry reopen, answered turn and 20-bot open. These are existing local Harness
measurements, not incremental-sync latency percentiles. Review and normal pre-push remain
required before delivery. No unchanged Swift gate
is repeated for these Node-only changes; normal pre-push owns final root/browser/macOS.
No evidence here covers App UI, website Herdr/auth/D1, cloud/Tailscale, device authorization
or physical Macs. Local full-history assembly is not a constant-space performance claim.

`test/runtime/replica-compatibility.test.ts` seeds the exact c073 P0 SDK receipt shape
with public passive commits in a separate SQLite, asserting replica.sqlite is absent.
Upgrade immediately runs the selected root or standalone complete branch without warmup,
preserving entry maps, zero passive execution and same-ID admission. A new complete branch
carrier imported without its summarized parent also runs/re-exports; corrupt/unknown
receipts refuse. A real, bounded provider-entry barrier holds a later root run busy while
the fixed-head independent branch completes, publishes and exports without root-later data.
The original nine failures are retained in `compatibility-review-red.log`; later logs and
the next candidate receipt, rather than the old 673 result, record the corrected gates.
The corrected candidate passed `compatibility-affected-final.log` 49/49 and
`compatibility-bots-check-final.log` ordinary/coverage each 682/682, with typecheck/lint,
lines 95.46%, branches 88.70%, functions 91.06%. `compatibility-crash-final.log` passed
8/8; `compatibility-eval-final.log` and `compatibility-p0-eval-final.log` each passed
their one selected local case. `compatibility-perf-final.log` passed 1/1 with medians
3/1/3/10 ms. All commands exited zero; incremental Review and normal commit/pre-push
remain pending. Prior frozen-candidate logs are preserved separately.


### Passive saved-history recovery

On Node 26.9.0, `test/e2e/replica-recovery.test.ts` uses real independent SQLite runtimes,
public SDK seeding and authenticated daemon requests. Two legacy full receipts are seeded
at the actual `directory.botDir`: export of one head is a visible storage precondition,
while the second remains absent from P1 heads/source pages until inventory. The selected
complete P0 branch is restored alone without a separate parent receipt, then re-exported
and run; invalid carrier hashes cannot damage the complete head. Saved bytes/source DBs
remain unchanged. No active session database is copied into the target.

The page path saves actual SDK facts with cumulative raw UTF-8 bytes >8 MiB, a real tool
result/resource, a branch created before backup without peer upload, and both unadmitted
and genuinely active run facts. Fresh identity/epoch survives restart. Last-page-first
reception leaves an honest gap; repeated pages/reopen retain every original sequence/body.
A separate passive SDK open checks raw entries and full context. B's actual provider request
keeps all original message categories in order and replays effective instructions/sections
and complete ordered tools against A's same-head control; only the effective cwd maps and
new local system messages/new input are allowed. The SDK may insert a system update after
the new user input. B and a saved-record holder exchange distinct branches and B reopens
with all heads; saved pending/active work is never executed on the fresh instance.

`test/runtime/replica-receipts.test.ts` checks >128 full receipts with interleaved compact
and empty records, checked-document limits/empty-page progress, one-body-at-a-time reads,
repeat/restart continuation, malformed/key/map/version rejection and storage-error
propagation. Entry validation runs on public Harness.commit/Tx reads: the first actual
storage error propagates, and later calls get SessionFailed without reaching Storage.
HTTP tests cover auth, Bot isolation, strict fields/limits and summary-only output/logs.
The existing SIGKILL suites continue to own real same-instance and passive-import commit
recovery; this slice's new tests do not claim a new SIGKILL window or whole-directory
rollback detection. The existing local-run eval now also exercises receipts before run.

Evidence is under `.local/sync-p1-recovery`. Original legacy-inventory/paths red/empty logs
had an incorrect seed directory and do not prove a scan defect. `corrected-baseline-red.log`
fixes the directory/export precondition but retains an unrelated old provider-position
assertion failure. `corrected-final-baseline-red.log` uses the final test assertions with
c8d8fd4 production sources: only the missing receipts route fails, while the >8 MiB
recovery path passes as existing capability verification. Final affected/gate receipts
record current source bytes separately. No website/Herdr/auth/D1, daily App/Swift, cloud,
network transport, physical-Mac or P2 resource-installation acceptance is claimed here.

The current recovery candidate's `affected-final.log` passed 42/42; `types-final.log`
and `lint-final.log` exited zero. `bots-check-final.log` passed ordinary/coverage each
688/688 (one suite, not 1376 unique tests), typecheck/lint; coverage lines 95.49%, branches
88.76%, functions 91.15%. `crash-final.log` passed 8/8; `eval-local-final.log` and
`eval-incremental-final.log` each passed its one selected case using `--case name`.
`perf-final.log` passed 1/1, five-sample medians 3/1/3/11 ms for the existing four Harness
operations. All exited zero. Frozen path/tree/log hashes are in the candidate receipt;
final Review and normal commit/pre-push are still pending for this recovery increment.


Receipt I/O Review follow-up preserves the frozen 4de501/68475d candidate and its green
logs. `receipt-io-review-red.log` proves both scanDocuments/document errors re-entered the
backend through actual ReplicaSync receipts commands. `receipt-io-and-log-red.log` also
proves duplicate origin errors; `receipt-close-cleanup-red.log` includes the cleanup path.
The accepted public-close solution is deliberately different from SDK Session failure:
first I/O rejects the identical raw error, public close ends with reason closed, and later
commands perform zero new backend reads. The pre-existing checkedEntries test still proves
true SDK SessionFailed semantics. Real held backend results for empty/compact inventories
are discarded after close. Invalid protocol, StorageRequestError and an actually aborted
Context leave the Session usable. Runtime assertions include cleanup, original trace/layer,
one error identity, propagated warnings and redaction. The duplicate eval notes are merged.
New final gate logs/tree hashes, rather than the old 688 result, bind this follow-up.

The receipt-I/O follow-up passed `receipt-review-affected.log` 51/51 and
`receipt-review-types.log` / `receipt-review-lint.log`, all exit0. Its new
`receipt-review-check.log` passed ordinary/coverage each 697/697 (one suite), types/lint;
coverage lines 95.51%, branches 88.88%, functions 91.13%. `receipt-review-crash.log` passed
8/8; `receipt-review-eval-local.log` / `receipt-review-eval-incremental.log` each passed
one selected case. `receipt-review-perf.log` passed 1/1 with medians 3/1/4/11 ms. All
commands exited zero. `receipt-io-candidate.json` binds new path/tree/log hashes relative
to the preserved 4de501 candidate; incremental Review and normal hooks remain pending.

The remaining close-queue Review regression calls real runtime receipts and handle.close
in the same turn, then joins both promises. Synchronous scanDocuments/document I/O failures
first produced two error origins (`receipt-close-queue-red.log`: 12/14 pass); no sleep or
held disk call is needed. The unchanged raw-I/O, identity, propagated-warning and redaction
assertions now pass for both queued and sequential cleanup. A separate healthy-close test
commits a real SDK entry before the scheduled scanner runs and reads replica.sqlite after
close to prove the final scan persisted that exact entry/body once. The first green is
15/15; the affected suite is 54/54 with typecheck/check-only lint exit0. New final gate and
candidate receipts bind this delta; the previous eb874d/697 evidence is retained separately.

`receipt-close-queue-check.log` passed ordinary/coverage each 700/700 (one suite), types/lint;
coverage lines 95.50%, branches 88.88%, functions 91.13%. The new crash log passed 8/8,
the two exact `--case replica-local-run` / `--case replica-incremental` evals each passed
one case, and perf passed 1/1 with five-sample medians 3/1/4/11 ms. All eight final
affected/type/lint/check/crash/eval/perf commands exited zero. The new candidate receipt
binds the delta to eb874d; narrow Review and normal commit/push hooks remain pending.


## P1 tombstone slice contract

Two real independent daemon/runtime SQLite roots exercise delete, passive root metadata
transfer, old-page/import/bind/run refusal and restart before SDK recovery. Actual original
trash data and an unuploaded peer branch stay intact, with no deletion/import model or
tool execution. Root pagination/forwarding/duplicates, strict auth/Origin/schema/caps,
group writes and legacy Bots without replica.sqlite are covered. Existing fault-injection
and owned SIGKILL children cover saved-mark-before-move, failed move, failed mark and
close timeout. Evidence belongs to .local/sync-p1-tombstones; no cloud/App assertion follows.
The original entry-red has missing root marks and two HTTP 404s; later tests assert the
actual tool files, original SDK entry/tool-result rows and source stream bytes both before
delete and in trash. binding-ownership-red proves whole-daemon startup failure and a
leaked post-open SDK owner before the per-Bot isolation/close fix. boundaries-first retains
the duplicate cleanup origin failure, and bind-origin-red retains an unlogged refusal.
startup-recover-red contains three actual failures: persistent pending cleanup, a newly
discovered deleted alias and a subscribed socket invoking recover after lease quarantine.
The narrow green covers those cases plus root catalog read/write still failing closed;
its 19/19 result is not the final complete Bots gate. A real owned child is SIGKILLed
after marking and before moving; restart opens zero SDK owners and preserves the trash
bytes. Quarantine tests execute the close retry itself and verify the fence remains.
The first expanded affected run retains one invocation-stack fixture failure: handle
absence also described a warm-up still awaiting binding discovery. Its cold-admission
barrier now waits for an actual counted idle close and handle absence together; the
original lease/one-open/one-close assertions and timer bounds are unchanged.

Final local gate evidence at 2026-10-30 19:36 +0800: affected-verified 171/171 and
lint-verified exited zero. bots-check-final passed ordinary/coverage each 720/720
(one suite), fixtures, strict types and check-only lint, exit0; coverage lines 95.71%,
branches 89.15%, functions 91.39% over the unchanged 90/85/90 gates. crash-final passed
9/9 including the new marked-before-move SIGKILL. eval-local-final and
eval-incremental-final each ran exactly one existing local case, exit0; tombstone-specific
acceptance is the real dual-daemon e2e/crash suite, not a new scripted-model eval case.
perf-final passed 1/1 with five-sample medians 3/1/5/10 ms under the documented bounds.
The candidate receipt binds these logs and all path hashes to the staged tree, not a
commit; final Review/Lead acceptance and normal commit/pre-push remain pending. Website,
browser, macOS/Swift, cloud, networking and physical Macs were not re-tested here.

The 19:45 +0800 unrelated-delete Review follow-up preserves the frozen 019abfdc tree,
tombstones-candidate receipt and all 720-test logs. unrelated-delete-red runs the real
HTTP DELETE after A's subscribed socket reaches persistent tombstone/lease quarantine.
Both different-shared-identity and legacy-unbound B already reached trash, with A's
directory/mark/history unchanged, before their 409 versus 204 assertions failed (6/8 pass).
The bound case uses real SDK SQLite and a real write tool; the legacy case uses the
existing fake runtime and a real directory without replica.sqlite. The smallest fix
reads B's actual binding after its primary cleanup and only cleans that identity's
aliases. The first local green is 8/8; added assertions keep the same-identity B alias,
catalog broadcast, original file/raw entry/source facts, zero extra provider execution
and A's single originating failure intact.
New unrelated-affected passed 173/173, unrelated-types and unrelated-lint passed,
unrelated-check passed ordinary/coverage each 722/722 (one suite), fixtures/types/lint,
and unrelated-crash passed 9/9, all exit0. Coverage is 95.71% lines / 89.18% branches /
91.39% functions. Existing eval/perf implementation and SDK measurement paths did not
change in this predicate fix; their prior evidence remains scoped to 019abfdc and was
not independently repeated or labeled a new-candidate run. unrelated-delete-candidate
binds the new tree/path/delta/log hashes; Review and normal commit/hooks remain pending.


## P2 fixed-head resources acceptance

Use two independent real daemons/SQLite runtimes and a controlled provider. Preserve the
initial run-rejected red, then assert original AGENTS/SKILL/scripts/references/binary and
attachment bytes, passive zero admission/execution, source-offline continuation, effective
ordered system/tools and native read/bash results. Interleave two heads with same-named
versioned files behind a real provider barrier; each branch and restart retains its pin.
Reject unsafe/incomplete/conflicting manifests, corrupt installs, invalid selected UTF-8
and real installation I/O with zero provider/tool work and one originating failure.
An owned SIGKILL covers complete installation before pin/admission; incomplete packages
never become ready. Start preflight precedes all pending submits, including root intents.
Affected checks/types/lint, normal Bots check, corresponding invocation eval and necessary
crash checks bind final source bytes; keep old failures and distinguish prior evidence.

The original 20:22 candidate (tree 766f101) evidence is `.local/sync-p2-resources/`. `entry-red`
reached the real imported head and rejected continuation before installation. The verified
installation-I/O red exposed a non-rejected intent and execution after disk repair, plus
an opened SDK owner left behind by failed startup. `rename-race-red` retained the real
ENOTEMPTY race; the earlier affected red retained mkdir EEXIST. The final implementation
uses standard filesystem collision checks, without an installation queue. Concurrent
version expectations come from independent user inputs, including post-tool requests.

`affected-third` passed 46/46. The first normal `bots-check-final` failed 733/734 because
an older concurrent-branch fixture assigned different answers by provider arrival order.
Its two factories now answer by actual user input; every original branch/provenance and
system assertion remains. `branch-input-verified` passed 9/9, and final types/check-only
lint passed. `bots-check-verified` passed ordinary and coverage 734/734 each (one shared
test list), with 95.84% lines / 89.28% branches / 91.42% functions. `crash-final` passed
10/10, including actual SIGKILL after complete installation but before pin/admission.
`eval-local-final`, `eval-incremental-final` and `eval-resources-verified` each passed
their one exact selected case. The new resource eval asserts the real provider's version
and complete skill section; native relative script/file results are asserted by the dual
daemon and crash tests. Its JSON fixture received only whitespace formatting after the
Bots gate; the final resource eval and root check-only fixture formatter bind those bytes.
`perf-final` passed 1/1 with five-sample medians 3/1/3/10 ms for the existing four Harness
measurements, not a resource-installation, network or device benchmark. Old red logs and
type/format failures remain separate. Final documentation changes do not reuse old gate
bytes as new executions. Review, normal commit and pre-push are still pending; no extra
root/browser/Swift or cloud/physical-Mac acceptance is claimed.

Resource retry regression uses the real RuntimeHandle replica command and SQLite/SDK:
completed and active admitted runs retain their status, execution/results and admitted
ledger after resource damage or EACCES. A failed replica admission-receipt write leaves a
real SDK submission with local admitted=false; retry must find that SDK record. In contrast,
an owned SIGKILL after branch pin but before SDK admission must still reject damaged
resources without executing. New IDs and conflicting head/text keep their original refusal
semantics. The old 766f101 candidate and its 734/10 gates remain prior evidence; new source
requires its own affected/check/crash/eval logs, while unchanged Harness perf remains scoped
to that old candidate.

Warm HTTP task-retry regression uses an already open real daemon handle, a pinned resource
branch and a committed native bash task. Damaged installed bytes, invalid manifest and real
EACCES each reach the resource preflight with no new provider/tool work. Each produces
exactly one runtime.task.retry.fail error with the HTTP trace/Bot and original failure
identity/cause, no retry.ok and no resource text/manifest/full local path in logs. The
catch covers this newly added preflight only, leaving later SDK retry errors unchanged.

The two Review fixes retain `admitted-retry-red` (31 tests, 11 pass/20 fail) and
`warm-task-retry-red` (10 tests, 1 pass/9 fail). The first fixed-head retry affected run
passed 60/60; the warm HTTP/log run passed 27/27. The final combined
`review-fixes-affected` passed 87/87; `review-fixes-types` and `review-fixes-lint` passed.
`review-fixes-bots-check` passed ordinary and coverage 763/763 each (one shared list),
with 95.89% lines / 89.27% branches / 91.57% functions. `review-fixes-crash` passed 11/11,
including the real committed pin without SDK submission. `review-fixes-eval-local`,
`review-fixes-eval-incremental` and `review-fixes-eval-resources` each passed their one
exact selected case. New crash-fixture options, paused-state and wrapped-cause oracle
failures are retained separately from product reds. All final implementation/tests match
these new gate source hashes; only final evidence documentation follows the runs. Perf
was not rerun: the unchanged Harness measurements remain prior 766f101 evidence, without
claiming a new resource performance measurement. `review-fixes-candidate.json` binds the
new tree, path/delta SHA and original log/exit files. Independent delta Review/Lead
acceptance and normal commit/pre-push remain pending; ordinary root-chat resource
selection, cloud/network and physical-device acceptance remain outside this slice.

## Ordinary root resource admission and queue acceptance

First prove a ready resource head through real authenticated import/export, then ordinary
WS send and Invocation on independent real daemon/SQLite roots. Provider scripts consume
the production section's local paths and run native relative package tools; preserve local
root history/cwd, raw tool results and original file bytes. A controlled provider barrier
separates active v1, queued v1 and edited/captured v2; independent user/request inputs name
the expected version for every initial/post-tool request. Assert FIFO and single user
append/settlement/history, retry conflicts, preflight refusal, steer and queue mix rejection.
An owned SIGKILL covers durable admission/queue recovery with stable IDs/versions and zero
foreign execution. Startup preflight precedes any pending submit/resume. Preserve every
actual red; run affected/types/check-only lint, normal Bots check, necessary crash and
invocation eval. Prior fixed-head gates remain prior evidence; no new perf/platform claim.


The ordinary-root fixtures additionally cover a real SDK overflow compaction child with
unchanged retention/queue/failure settings and distinct generation handOver owners: the
first placed v1 submission remains fixed through compaction/tool rounds, then queued v2
runs. Warm tool-group changes and crash reopen retain the runtime resource extension.
The dual-daemon busy test edits real source files, derives v2 from a fixed base while both
v1 providers are blocked, and checks every initial/post-tool request by its user marker,
local native read/bash outputs and raw tool results. Invocation and WS stored-ID conflicts
reach the runtime; live/resync/history render only user text. Empty-version queue mixtures
are exercised in both enqueue orders at final and postTools. Resource inputs hold only
references; immutable resource facts are checked for unique count and exact byte total.

The existing eval runner's replicaRun step can select `root:true` after passive import;
root-resources uses ordinary WS send on the original Inbox, checks the actual provider's
version/complete skill binding and exports the resulting root history. It does not claim
native execution (the daemon/e2e/crash fixtures do). Run it with the three existing replica
evals after this invocation change; unchanged Harness perf remains prior evidence.


Ordinary-root candidate evidence is saved under .local/sync-p2-root-resources. The final
production bytes pass affected-fixed 131/131, protocol-verified 100/100, crash-final 13/13
and four exact selected eval cases (replica-local-run, replica-incremental,
replica-resources, root-resources). The first normal check passed 785/786: its only old
fixture still required head+resources to reject. The necessary contract adaptation now
asserts deterministic parent/agent/empty-manifest export and keeps head+branch rejection;
validation-compatibility-fixed passes 10/10. bots-check-verified then passes ordinary and
coverage 786/786 each (one suite, not 1572 distinct tests), types and check-only lint,
with coverage 95.92% lines, 89.22% branches and 91.64% functions. Original reds, the
intermediate fixture/strict-JSON errors and all receipts remain; they are not relabeled
as final green. No new perf, root/browser/Swift or physical-device claim is made here.
The final candidate binds exact source/path/tree and actual log/exit hashes for Review;
commit/push and the fresh empty-Bot package entrance remain pending.


## Ordinary-root Review: mode binding and lost done receipt

Preserve tree19d9929/root-candidate/source-v2 and their786-test evidence unchanged.
The two narrow Review findings are demonstrated on those production bytes in
.local/sync-p2-root-resources/whenbusy-startup-red-verified.log:31 items,18 passed and
13 failed (12 leaf failures plus the parent). Real provider barriers first establish a
busy refusal, then selected/legacy reject→followUp/steer retries incorrectly admit.
Actual SDK-admitted and lost-local-UPDATE receipts also allow changed modes. Real WS
and Invocation stored-record lookups return success when the selector is omitted.
Separate done/no-busy/lost-UPDATE fixtures damage bytes or cause real EACCES, then fail
reopen in startup's unnecessary pending installation. Earlier red logs remain mixed
with a test predicate mistaking failure.reason for failure.kind; those predicate failures
are fixture errors, not additional product reds. The intermediate tuple type error is
also retained. No skip/focus, queue-policy or timeout change was used.

The shared durable intent check fixes whenBusy for refused/admitted IDs; legacy omitted
mode means followUp. Admission-only request-ID lookup carries retry{whenBusy,trace};
pure status and SDK-only legacy records retain their behavior. Tests assert unchanged
intent/outbox, no extra SDK entries/tasks/submissions/provider execution, matching retries
without installation, and one runtime.submit.fail origin with the incoming trace and the
same failure ID through WS/Invocation. Startup uses public Tx.submissionByRequest before
installing ledger-pending root resources. Existing active/Inbox and genuinely unsubmitted
resource preflight remains mandatory before any submit/global resume. Reopened done IDs
recover the original answer/version/mode and fill admitted without reinstalling bytes.

Final new-source gates: whenbusy-startup-affected-final180/180, types-final and check-only
lint-final203 pass. whenbusy-startup-bots-check passes ordinary and coverage796/796 each
(one suite), fixtures32, types and check-only Biome203; coverage95.93% lines/89.30% branches/
91.65% functions. whenbusy-startup-crash13/13 retains owned SIGKILL and bad pending/queued
preflight assertions. The four exact evals each pass one selected case: replica-local-run,
replica-incremental, replica-resources and root-resources. All final21 source/test/eval/
fixture hashes match these new gates. Only final evidence docs follow the runs; the new
candidate binds their tree/path hashes separately. Prior perf/platform evidence keeps its
original scope; no new root/browser/Swift, cloud, physical-Mac or fresh-empty-Bot claim.
Independent delta Review/Lead acceptance and normal commit/pre-push/push remain pending.


## Final lookup failure-attribution Review delta

The accepted whenBusy/startup fixes remain frozen in historical tree271eb439 and
whenbusy-startup-candidate2f34ac68. This remaining delta changes only the admission
retry-check catch in PiDurableRuntime.submission. Existing ClassifiedFailure objects,
failure identities and causes are rethrown intact; raw read errors reuse submit's
sessionEpisode/operationFailed/#logFailure with unknown disposition and original cause.
Plain status and the later SDK lookup are untouched.

lookup-read-attribution-red demonstrates the actual SQLite boundary:38 items,32 pass,
6 fail (four child assertions plus two parents). Each fixture first admits and completes
a real SDK request, then renames only its owned replica.sqlite local_runs table while
preserving all rows. Direct checked lookup exposes an unclassified error; two warm WS
retries and Invocation mint three core origins/identities. The fix yields one runtime
origin with each command's trace/Bot, a shared failure ID and warn-only repetitions.
Direct/Invocation failures retain the original ERR_SQLITE_ERROR read cause and stack.
Pure status remains readable, no SDK entries/tasks/submissions/provider work is added,
and restoring the original table preserves every intent and makes matching retry usable.
Business-conflict and matching resource retry tests remain unchanged. No runtime, SDK,
admission or store.run mock is used. The first green is38/38; an intermediate Frame[]
inference type failure is retained, fixed only by the existing Frame type.

Final lookup-read-attribution-affected-final passes134/134; types-final and check-only
lint-final203 pass. lookup-read-attribution-bots-check passes ordinary/coverage802/802
(one suite), fixtures32, types and check-only Biome203, coverage95.93% lines/89.34%
branches/91.65% functions. lookup-read-attribution-eval-root passes its exact root-resources
case. All five final new gates match all21 frozen source/test/fixture/eval paths. Final
evidence docs are bound separately by the new candidate tree/path hashes.

The prior796 gate and three other replica evals remain prior271eb439 evidence. Prior
whenbusy-startup-crash13/13 is reused only for unchanged startup/submit/recovery/owned
SIGKILL windows; the new raw-error catch is exercised by these real SQLite tests. No
new crash run or unchanged perf/platform run is claimed. Preserve both older candidates,
all red/type-intermediate logs and source receipts. Independent final delta Review/Lead
acceptance and normal commit/pre-push/push remain pending; fresh-empty first resources,
cloud/transport/UI and physical-Mac acceptance remain outside this candidate.


## Fresh empty first-package acceptance (in progress)

Before implementation, two real independent daemons bind empty replicas and prove zero
provider calls, SDK user/model entries, submissions and history receipts. Actual AGENTS,
complete relative skill scripts/references/assets and attachment bytes then cross public
kind:resources export/import and incremental pull/apply, without a placeholder turn.
The first real ordinary WS/Invocation input must obtain paths from its production section
and execute native read/bash in the target local cwd, including with the source offline.
Duplicate/reordered pages stay passive; missing refs never receive a complete/applied ACK.
Edited queued versions, reopen, same-ID/mode binding, rejected I/O and unchanged history
continuation refusals keep their existing strict oracles. New evidence is isolated in
.local/sync-p2-fresh-resources; prior delivery/push and gate scopes remain historical.

The actual first entry-red uses unchanged production9475e2e (all production hashes
verified against base), passes fresh SQLite/SDK/binding/original-byte preconditions and
fails public resource-only export400. Its original test is archived alongside the log.
The later imported-facts rebind regression genuinely fails before facts are added to the
existing populated-binding query. These are product reds. Intermediate invalid Invocation
origin, consumed append accounting, strict types/import lint and a crash-loop formatting
parse error are retained separately; they are fixture/editing failures, not product reds.

`test/e2e/fresh-resources.test.ts` proves empty SDK entries/submissions/tasks and no history
receipt, then stable full carrier re-export, reversed/duplicate pages and passive import
with provider0. A's first Invocation and B's first WS input run native read/bash from
production section paths; the script reads nested package references/assets and writes
exact original bytes in each local workspace. A closes before B executes. Independent
user labels assert every initial/tool-after request's version, complete selected skill
and instructions. Busy local edits queue v1 then v2 on the original root; FIFO user/done
events, raw tool results, exact installed bytes and source-offline execution are checked.
Reopen same-ID omitted-selector retries add no execution, changed modes conflict, and
resource facts/manifests remain one immutable copy rather than bodies in each intent.

Runtime/protocol cases refuse history export/run from a resource-only head, malformed
carrier combinations and empty manifests. Missing refs on another stream keep applied0
until actual facts arrive; foreign input stays passive. Invalid SRI never applies. Path,
incomplete-skill, invalid UTF-8 and actual EACCES failures are not_admitted with one runtime
origin and original classification/cause, persisted rejected intent, and no execution after
repair/reopen. Owned SIGKILL tests cover incoming log commit before drain, fresh intent
before SDK, and queued version recovery/preflight before any global resume. Existing active,
true-pending, known-SDK duplicate and history recovery oracles remain unchanged.

Final evidence is under `.local/sync-p2-fresh-resources`. Source receipt795e6556 freezes13
source/test/fixture/eval paths. Affected-final122/122 and standalone types/lint passed before
the final crash-loop formatting; the final normal bots-check-final, crash-final and exact
eval-fresh-final/eval-root-final/eval-replica-final all bind13/13 frozen paths before/after.
Normal check passes fixtures32, ordinary810/810 and coverage810/810 on the same deterministic
suite, types and check-only Biome206 with zero fixes; coverage95.95% lines/89.31% branches/
91.69% functions. Crash is16/16; each exact eval is one case. Earlier affected/crash8/eval
evidence retains its actual prior byte scope. All original red/intermediate logs remain.

No unchanged perf or root/browser/Swift gate was repeated for this local slice; normal
platform hooks follow formal candidate acceptance. Prior delivery receipt31d8ccef retains
the distinct failed push attempt1 and successful attempt2. Current fresh evidence awaits
independent Review/Lead acceptance and normal commit/push; cloud/transport/UI/physical-Mac
acceptance and complete P2 remain outside this candidate.


## P3 device identity/access metadata - first red contract

On unchanged production264cc9e, register two independent real Ed25519 identities
against an owned Miniflare DeviceRegistry SQLite and pair them through existing
public/private helper interfaces. Start two owned Node services with private sockets;
prove current shared group, valid identities and local readiness before requesting the
new sync.identity metadata interface. Record the actual refusal, not static reachability.

The completed slice must independently check explicit sharedBotId/purpose access,
revocation/epochs/credentials, identity/scope spoofing and self-only Tailscale publication,
without treating All approve or local-directory fallback as authorization. Bots owns
its port codec, imports no Eagle contracts, and local model/tool runs remain independent
of cloud. Source/gates and physical Tailscale/cloud claims stay separate. Evidence uses
.local/sync-p3-device-access; prior P2 delivery/gates are not rerun as P3 evidence.

P3 source freeze: `source-v1.json` binds22 changed non-document paths at base264cc9e.
Real public Host forbidden and uppercase-peer response mismatch reds are separate
from the first identity red. The Bot process suite holds a real Registry response,
then rebinds/deletes the local Bot before release; it asserts stale scope is refused.
Positive endpoint discovery crosses owned Node -> Registry -> peer access with a
controlled CLI emitting Self plus unrelated Peer data. Self-only dedup, chosen port,
server timestamp and identity binding are asserted; this is not physical Tailscale.
Current affected checks distinguish whole root device tests, Bots core/adapter/codec/
log dependency tests and normal platform gates. No runtime invocation/source-event/
recovery code changes in P3: prior P2 eval/crash/perf results remain explicitly prior.

Final P3 local gates: affected root27/27 + Bots64/64; root264/264 plus types/lint/build;
Bots fixtures33, ordinary813/813 and coverage813/813 from the same deterministic suite,
types/check-only Biome210 (95.73 lines/89.31 branches/91.68 functions); real device
integration8/8 including counted parent/subassertions; normal Swift194/44/50 plus strict
format. Six final gate receipts bind all22 source paths before/after. The first normal
Bots run812/813 failed the documentation fixture inventory only, retained verbatim;
a bare normative table entry fixes it without source changes. Browser/platform hooks
remain for accepted normal delivery; physical network/cloud/installed App are unverified.
Agent1.2.0 is unpublished source, onboarding1.0.0 remains unchanged. No new crash/eval/
perf result is claimed for this metadata-only slice.


P4 first authenticated page evidence lives in .local/sync-p4-authenticated-pull. The original
entry-red uses paired real Registry SQLite/independent Ed25519 Node services, actual bound
Bots and an existing full resource page before sync.peer.authorize fails unknown_local_method
on base460b60d. Initial run.py receipts cover only196 existing production paths; they do not
bind new P4 files. run-v2 separately hashes tracked+new production/tests/fixtures/scripts before
and after each command, with cwd/start/exit/log SHA. Stable-source gates must match the final
manifest; old and intermediate failures retain their actual scope and filenames.

Owned tests cover exact page bytes through mutual proof/X25519/HKDF/AEAD, one-way grants,
wrong-origin helper refusal, consumed challenge replay, signature-wait revocation, local
rebind/tombstone and alias refusal, passive0model/tool/admission before explicit native local
work. Crypto tests explicitly retain a legal full AAD>1024, plus direction/transcript/sequence
and tamper refusal. The actual HKDF1026>1024 red is retained; no truncation/limit increase.
An archived original Node writer plus real Registry pre-write barrier reproduces stale publish
following a later withdraw, and current endpoint-only serialization proves the final empty set.
Owned CLI discovery and mapped real TCP sockets exercise Self-only whole-set binding, second
bind failure, discovery fencing and drain; these are not physical Tailscale interface evidence.
Owned SIGKILL leaves a real local pending intent. Corrupt installation makes startup unavailable;
after repair sync still refuses0execution, and explicit local recover executes the original once.
Cold/stale handles cannot reopen via sync. All prior active/Inbox preflight assertions remain.
Public NSApplicationDelegate tests exercise actual owned child quit/exit, confirmed vs unknown,
unresponsive cancellation and one reply, plus adopted pid with unavailable health. Normal Swift
raw summaries are195/45/50 at quit-entry-first-green, not194/46/50. That earlier local scope and
later WIP source changes are not a final frozen-source gate. No P2/perf or installed/live/CF/
physical-Mac evidence is relabeled as P4 acceptance. Complete checks/Review are recorded only
when actually run on the stable final source; P4 later cache/key/fallback slices remain open.

Original P4 source-v1 e57db583 binds31 changed/new production/test/fixture/script paths to
base460b60d, including null base blobs for new files. Seven new gate receipts each hash
532 selected tracked+new production/test/fixture/script paths before/after and match31/31
frozen paths. Normal root-check-v1 passes265 tests, types/check-only Biome202 and build.
bots-check-v1 passes fixtures34, ordinary817/817 and coverage817/817 from the same suite,
types/check-only Biome215; aggregate coverage is93.92% lines/89.07% branches/90.69% functions.
swift-check-v1 passes196/45/50 and strict recursive format; device-process-v1 passes10/10;
crash-v1 passes17/17 including ready-only pending recovery; exact eval-root-resources-v1
passes one case/two rows. No P2/P3/perf result is substituted for these new gate results.

The seventh gate runs the unchanged `sh apps/macos/Scripts/coverage.sh` at its default90
threshold. It passes196/45/50 and reports1465/1549 lines,94.6% for the existing logic-file
filter: WorkspaceViewModels, SettingsViewModel, DeviceSettingsViewModel, SettingsModels,
SidebarComposition, Theme and SidebarList. The raw report retains its relative/macOS-prefixed
Theme/SidebarList entries; no report/filter normalization is applied. This is not a90% claim
for all new synchronization logic. Existing compiler concurrency warnings in unchanged
BotsTransport remain visible, as do root build chunk notices and informational lint suggestions.
Old196-path/WIP receipts and every real red/intermediate fixture/type failure remain unchanged;
misnamed quit-startup-race-green is exit1, while quit-generation-second is exit0.
Source Review/Lead acceptance and normal commit/pre-push remain pending; browser runs only in
the normal pre-push. No physical Tailscale bind/two-Mac path, installed App, live Herdr collection,
cloud authentication/D1/rendering, CF cache/fallback or deployment/release evidence is claimed.

P4 expiry-after-await delta contract: keep candidate88a203b6/sourcee57db583 and its seven
gate scopes immutable. On that production, real Registry final-response barriers and an owned
clock advance cross expiry only after a legal proof has entered. B's final challenge/page and
A's final request/apply must refuse; A's actual binding-return barrier must also refuse before
apply. Real page/source/applied/SDK counts stay unchanged, provider/tools remain0 and trace/
single-origin attribution is retained. The older entry-before-60001 test remains separate.
The same internal synchronous guard must survive ReplicaSync's own serial/commit awaits and
check the original exchange generation/closed state before receive; apply admitted within the
lifetime retains its existing atomic completion semantics. Other accepted P2 contracts require
same-daemon endpoint reconfirmation after real pairing/epoch changes, owned private-Self-I/O
shutdown cleanup before reply release, and actual headers-then-truncated TCP body attribution
as network failure with the original cause. No new limits, SDK behavior or cancellation framework.
The actual publication test uses the public Supervisor with a narrow trusted-parent fixture
bridge to owned Node/Registry and a real daemon/listener. Original shared process helpers are
extracted unchanged except owned gates into device-fixtures.ts for reuse; Bots imports no Eagle
code. Fixture Self addresses map to real loopback sockets only inside that owned child, so this
proves the protocol/lifecycle chain, not physical Tailscale binding. Ready positive publication
reconfirms on existing polling rounds plus request/retry time; withdrawal remains deduplicated.
Deep guard tests delay only the return of actual public binding reads/Harness commits, then
advance the owned clock or invalidate exchange generation; no SDK result/admission is stubbed.

### P4 four-P2 repair candidate evidence

Source-v4 `4095cb04` freezes36 production/test/fixture/script paths at base460b60d, with11
source deltas from the original tree88a203b6. Source-v2 `70d7e0d0`, v3 `85e188e0`, the original
candidate/source and all original103 artifacts/seven gates remain immutable. The v3/v4 old-tree
metadata mistakenly used the original changed-path inventory for three existing files;
`old-tree-metadata-correction.json` (`e5302a2b`) records their actual Git blobs/bytes. It does
not alter source or gate results. The final candidate resolves old values from the full tree.

The original expiry-await red `37dfd17a` crosses final Registry/binding waits. Final tests also
cross actual public SDK commit returns on both A and B, and invalidate exchange generation
inside command queues. All refuse403 before page/receive, preserve original page/replica/SDK
counts and provider/tools0. Guard failures preserve ClassifiedFailure identity or raw cause,
auth_failed/runtime and the actual use point. `bots-check-v2` is an actual819/820 architecture
failure (`78cfc793`), fixed by using the existing runtime classifier without changing allowlists.
The resulting remote classifier red `93b69474` returns403 but replaces B's f_1/f_2 at A;
two new tests plus their parent fail, while the original14 assertions retain their behavior.
Only remoteFailure's id codec changes to the existing protocol FAILURE_ID. Final process
assertions require B's single error origin, A warnings with the same id/trace and each local
Bot id, and no apply or execution. V2->v3 classifier and v3->v4 propagation deltas are separate.

The other three genuine reds are publication-identity-second `f51e5a0c`, shutdown-self-second
`052df103` and body-transport `67256758`. They cover current-session positive publication after
real pairing, local cleanup starting while private Self I/O is held, and headers-then-truncated
TCP body classification. Body errors preserve the original TypeError/UND_ERR_SOCKET cause as
network/internal503; complete bad JSON remains auth_failed403. No route status mapping changes.

Final v4 receipts each bind all36 frozen paths and534 selected tracked+new source/test/fixture/
script paths before=after: `bots-check-v4` (`2c99aaa2`) passes fixtures34, ordinary820/820 and
coverage820/820 on the same suite, types/check-only Biome215; aggregate coverage is93.84% lines,
89.16% branches and90.71% functions. `device-process-v4` (`516d943c`) passes22/22, including the
expanded16-case process file; `crash-v4` (`3ca2fa1a`) passes17/17; `eval-root-resources-v4`
(`cc11463c`) passes one exact case/two rows. `remote-classifier-types-third` (`c95ca5d4`) binds
the same final36/534 paths and passes root/Bots strict types plus check-only Biome204/215.

Reused earlier scope is explicit: root-check-v2 (`5bf235c5`) passes265 tests/types/Biome204/build;
swift-check-v2 (`00d0d7f2`) passes197/45/50 and strict recursive format. Their global maps differ
from v4 at ReplicaSync, sync-pull and the process test (33/36 frozen paths match), so they are
not v4 whole-source runs. The final types/lint receipt above checks the changed process test.
Unchanged `sh apps/macos/Scripts/coverage.sh`, default90, actually ran at v3 (`86fa0395`):
197/45/50,1465/1549 lines=94.6% for the existing logic-file filter only. Its global map differs
from v4 at sync-pull/process test (34/36 match); Swift/fixture inputs are unchanged. The existing
relative/macOS-prefixed filter entries and imported BotsTransport compiler warnings remain raw.
No90% claim for every new synchronization file and no new Swift run for the final codec delta.

All intermediate failures stay separate: Self fixture166836ed lacked0600 and never reached
the target; a0a0722b is a nested Swift macro compile failure; body-transport-green0a023ee0 is
exit1 because its fixture wrongly expected500 instead of the existing503. Missing helper
export1e3bacec, types/formatf6ba7248, new trace-row annotation793ea288 and formatb2f97340 are
editing failures. No raw log/exit is rewritten or renamed into a successful gate. Browser
remains normal pre-push; unrelated perf/P2/P3 gates are not repeated. Physical Tailscale/two-Mac,
installed App, cloud authentication/D1/rendering, CF cache/fallback, long-term keys and P5/P6
remain unverified/outside this first-page candidate. Formal Review/Lead acceptance precedes delivery.


### P4 durable objects and offline capability slice

The previous4f7d035 direct-page delivery stays closed. New evidence is isolated under
.local/sync-p4-encrypted-objects. entry-second4ce5258a/receipt05632cb5 is the real missing typed
key descriptor red after Registry SQLite pairing,B->A grant,dual owned helper/Node/Bots and
original resources page;227 production paths equal base and534 selected inputs are unchanged.
entry-red49924650 was a fixture /tmp symlink/insecure-storage failure. descriptor-firsta46ba95f
was a signature equality oracle failure; both original failures remain unmodified.

Tracked tests/device-integration/encrypted-objects.test.ts compiles real Swift CryptoKit/Host
against an isolated DeviceFileVault and runs real Node/private socket/Miniflare Registry SQLite
plus independent Bots daemons. It covers concurrent different-key candidates/first-winner,actual
SIGKILL after link and after publish before response,reopen,unknown hardlinks,corrupt winner,
verified same-body descriptors with distinct observed signatures and one original recipient slot,
actual EACCES/cause/storage_failed503/single origin,crypto rejection remaining403,and helper reply
held across current grant revocation. Test-only owned pipes/syscalls mount the production handler;
no production bypass,real private key,Tailscale kernel bind or physical Mac/App claim is involved.

Staged B object/recipient slot and A capability pin cross actual file-fsync barriers before
binding/expiry/exchange-generation changes; full local binding,delete,close and grant revocation
also refuse before publication or SDK admission. A cold offline case stops B and Registry first,
then restarts A helper/Node/Bots from old owned directories waiting only localReady. A separately
forced unavailable handle refuses sync even after repair until explicit local open. Stored apply
preserves original12826-byte Page/history5 entries/head/section order; passive provider delta0
is separate from source native run2 and final explicit local native run2. Actual member removal
changes recipient group/credential and blocks new issuance; the old stored offline capability
still opens. Missing wrap account refuses without minting; listener setReady(undefined) during
actual key.open does not cancel offline apply,while daemon close/full-binding change still refuse.
Replica/SDK table counts fence rejected paths. Unit tests independently exercise object storage,
AEAD and typed/canonical codecs; shared signed fixtures are checked in Node,Bots and CryptoKit.

Retained intermediate failures include history-offline-first4a1532b8 (ordinary startup already
ready,so the cold-must-reject oracle was wrong),object-io-first5b6da4ef (fixture URL),and staged
status oracles e956c18a/c6c1c1f5 (localBot corruption503/changed epoch400). Formal additional reds
are hardlinkd21c1c7a,missing-wrap4b7e52ab,EACCES4917cea2 and offline-readiness6a928d8c. The two
history runs selected542 unchanged paths; second eb2394bd is1/1. No handwritten13/14/15 figure
is a test count or evidence scope. New full gates and final source bindings are recorded only
when complete; original P4/P2/P3/perf evidence is not relabeled as this slice's gate.

Frozen source-v1 `ccdfe1ae` binds29 changed/new inputs and550 full selected tracked+new paths,
plus203 historical originals. Every gate below independently records command/cwd/start/exit/log
SHA and sourceBefore=sourceAfter=that full550 mapping. Source remains frozen for independent
Review; successful local checks are not commit/push/delivery or physical-network acceptance.

| Actual gate | Raw log SHA prefix | Result |
| --- | --- | --- |
| root-check-v1 | c30e31cc |267 tests,strict types,check-only lint211,build; exit0 |
| bots-check-v1 |7ae0837b |fixtures34,ordinary825,coverage825,types,check-only lint219; exit0 |
| swift-current-first |aa54c732 |197/51/50 actual suites; exit0 on the same frozen inputs |
| swift-strict-v1 |e3b0c442 |original recursive Sources/Scripts/Tests strict check; exit0 |
| swift-coverage-v1 |50b7dd5c |original script/default90;197/51/50,1465/1549=94.6%; exit0 |
| device-process-v1 |098867c5 |23/23,including production helper/Registry/object protocol and old P4 deep guards; exit0 |
| crash-v1 |50dd494b |17/17; exit0 |
| eval-root-resources-v1 |cc11463c |one exact case/two rows; exit0 |

Bots aggregate coverage is91.85% lines,88.92% branches,90.24% functions. Swift94.6% applies
only to the existing script's filtered logic-file collection, not all new synchronization code.
The tracked integration Swift fixture also receives its own check-only strict lint because it
lives outside apps/macos's recursive roots. Browser remains the normal future pre-push hook;
unaffected perf/P2/P3-specific gates and physical/live/cloud/App checks are not repeated.

Review target-slot P2 retains the old v1 receipts above. On unchanged f070889e production,
wrong-object-winner-red e8bb2510 substituted a fully signed,digest-valid same-Bot/full-binding/
publisher record with another objectId after target read miss. Actual HTTP returned200/stored
with the wrong ID; EEXIST and unknown-result complete rereads also accepted it. Bad JSON was
not used. Archived red inputs bind550 before=after and all production equal frozen v1.
Source-v2 7126eb18 changes only the shared objectId-bound decoder and the tracked integration/
store fixture. Green1a7ed8ea refuses both rereads and actual route403/no stored ACK,while retaining
same-ID concurrency,crash/lost-reply,recipient-slot and cold-offline history/zero-execution cases.
Root/Bots types/check-only lint01edac90 and complete Bots checka453f6ed pass on v2's550 inputs.
Devices b6ee01bd and6a9f9cf3 each retain actual22/23 failures: respectively an immediate disk
propagation snapshot and later offline DB-count change after explicit native execution. The
unmodified original device-bots file passes16/16 in isolation; at v2,timing diagnosis and normal
full devices completion were pending. No failure is removed or relabeled as success. Unchanged
root267/Swift197/51/50/filtered coverage94.6/crash17/exact eval keep only their original v1 map;
they are not claimed as new whole-v2 executions. Independent delta Review precedes acceptance.

Source-v3 `fe2e2ecd` freezes30 changed/new inputs and550 full selected paths,with282 originals.
Production remains identical to v2's reviewed decoder fix. Its exact two-test delta waits via
the existing until for this trace's core propagation before the same origin/failure/Bot assertions,
and moves explicit offline-native run after epoch/closeSync refusal. Both refusal windows still
assert every DB table count unchanged and provider===baseline; native afterward must actually
succeed with+2. No timeout,production flush/settle API,log level or protocol status is changed.
Read-only diagnostic9b7acfea ran both original complete files17/17; actual runtime/core records
share one origin/failure/trace/Bot and post-native baselines already contained the projection
counts seen late in the failed run. Original failed directories were removed,so this observation
does not claim a capture of either failed run's precise late-write timing.

| Repair gate | Raw log SHA prefix | Actual input scope and result |
| --- | --- | --- |
| device-process-v3 | b096c98c | normal complete devices command23/23; full v3 mapping550 before=after; no observer/skip/focus |
| root-types-lint-v3 | d74afdc8 | strict types/check-only lint211; full v3 mapping550 before=after; exit0 |
| bots-check-v2 | a453f6ed | fixtures34,ordinary825,coverage825,types/lint219; v2 mapping550 before=after; Bots inputs unchanged in v3 |

Root test/build,Swift/strict/default90 coverage,crash17 and exact root-resources receipts retain
their earlier v1 full map; current root lint/types and affected device execution are rebound above.
The candidate lists the actual map differences and reuse rationale instead of claiming those
older commands ran the final v3 map. All old reds,oracle/editor failures and both22/23 gates stay
bound. Browser remains normal pre-push; independent test-delta/final acceptance still precedes
commit/push. No physical Tailscale/Mac/App,CF cache,deploy/npm/PR or next-slice evidence is added.

### Durable-object delivery and #109 ancestry preparation

The accepted slice was normally committed and first-pushed as8b5ca36/tree20d3fe12,parent4f7d035,
39 paths. objects-delivery-final.json SHA072acfa9 binds289 historical+40 delivery originals and
source30/full550/complete index681 before/after. Both real hooks and main commit/push exit0.
Actual pre-push ran root267/267,strict types/check-only lint211/build,browser191 with the existing
11 conditional skips,and Swift197/51/50. Independent own ls-remote and clean/ahead0/behind0
confirmed delivery. Older local gates keep their original maps and reuse scope;no old failure
or raw receipt is rewritten.

Settled trace correctiona40bae3e verifies the original commit-exit declarations as exact
3888/28010-byte prefixes. Detached Git maintenance/repack ended0 after the main commit and
appended to complete5074/43436-byte traces;final delivery uses their settled hashes. Push traces
had no analogous append. Two Swift exact-tag Git probes ended128 because no tag exactly matches
8b5ca36;subsequent Swift summaries,pre-push hook and push passed. The first settle helper's
all-child-code0 assertion error is retained as an evidence-script error,not a product gate or
an assertion that all nested Git commands succeeded.

The following ancestry/docs preparation has separate .local/sync-upstream-109 evidence. Actual
fetch found upstream/main5d48ba0a,parents d69359b/165d154,tree d3923690 identical to165d154.
Merge-base is165d154 and the upstream content delta is empty. Normal --no-ff --no-commit merge
left the index at8b5ca36's tree20d3fe12 before status-doc edits,with no conflicts. All550 selected
source/test/fixture/script paths were separately compared with real8b5 blobs;old289+40 originals
and their delivery/candidate receipt hashes remain intact. Only the five authorized status docs
are prepared for Review. Static diff checks cover this step;no unchanged Bots/crash/eval/coverage
gate is repeated or relabeled. Merge commit/push and their normal hooks await candidate
acceptance;MERGE_HEAD alone is not integrated or delivered ancestry. No CF/physical/App scope added.

### P4 CF72h local cache slice: contract and first-red scope

Base ee26b2bb/tree92d79c1e is delivered and independently closed, receipt293f1f74.
New evidence root .local/sync-p4-cf72h-cache protects1018 prior refs plus final itself.
[SYNC-CACHE.md](SYNC-CACHE.md) fixes the additive API and strict boundary cases.
At the initial contract checkpoint no cache gate had run. The real capability red follows durable
Swift helper keys, independent Node registration/pair/grant, Registry SQLite and
actual bound ready page prerequisites, with production exactly base before/after.
Later first-red/green and actual gate rows will distinguish tool/fixture/oracle
errors. The main chain requires A descriptor/offline before new B history/cache,
then B offline before A cold receive/apply; passive execution delta0, native run.
Full root/Bots/Worker/devices and affected Swift/crash/eval will bind stable inputs.
Browser remains normal pre-push; no deployment/physical/App/automatic fallback claim.

Local implementation evidence now includes descriptor-entry-fourth12bf5388 (2/2),
Registry authority404 red55ed2a88→b3fb9a66 (1/1), and genuine cache-publish entry404
127ae353. The earlier resource bytes/digest mismatcha0a71415 is a fixture failure.
Worker pending7/8 red and failure/list12/14 reds precede their narrow fixes; latest
worker-bindings-firstf813ec8c is18/18 with real Miniflare DO/R2 and a fixture Registry
RPC. It covers immutable winners, repaging/forwarding clocks, unknown pending,
late put/deletion, DO reconstruction, final authorization/expiry and bounded truthful
listing; one distinct object's body is verified once per request, including failure.

cache-origin-offline-first878911cb is2/2 WIP process evidence: actual Swift helper,
Registry SQLite, two Node/Bots and Sync DO/R2 exercise A offline before new B history,
B offline before A cold receive/apply, exact16564 bytes/head/sections and native +2.
Execution baselines precede list/receive. It also checks four publisher/slot and eight
receive stage fences, Worker error1/Bots error0 with shared failure/trace/Bot, and cold
stored apply after Registry stops. Its726 map changed during execution in production
apps/bots/src/device-sync.ts and test/device-sync.test.ts; it is not stable-source gate
evidence. The new port attribution red56c39b87→green2df48d0e is separately retained.
Final ordinary/coverage Bots suites include tracked cache tests; root process tests
do not replace that independent gate. At source freeze, full root/Bots/Worker/devices
were pending; their actual results follow below. Old scopes require exact input binding.

All original fixture/oracle/tool failures remain: descriptor signature-byte equality,
TDZ edit, no-op-capable badCipher mutation, localBotId503 oracle, RPC barrier context,
formatter wrong cwd and static import ordering. The corrected cipher fixture XORs an
actual byte and asserts inequality; no claim recovers the old random failed byte.
Dependency recovery is recorded in [the project runbook](../NPM-RECOVERY.md), its raw
receipt and Retrospective; normal offline ci ran real native postinstall, locks intact.

Frozen source-v1 SHAba1bc514 maps726 complete files and685 selected source/test/config
inputs (prior614 extended to every non-document input, including unchanged inputs).
Its relative ee26 delta is47 paths,35 selected. All1019 previous delivery originals
are protected. The following normal executions have identical726 before/after maps,
matching all685 frozen source inputs; later edits only add actual results to docs.

| Actual command/evidence label | Result and precise scope |
| --- | --- |
| `npm run check` / root-check-frozen | exit1,267/268; unchanged styled redaction performance ratio3.1545 exceeded its existing assertion while the other three gates ran. No source/threshold change. |
| `node --test tests/realtime-redaction-perf.test.ts` / root-timing-diagnostic | Original whole file6/6 in isolation, styled128k/256k12.06/23.22ms versus first26.16/82.52ms. This is diagnostic evidence, not a substitute root gate or a proven cause. |
| `npm run check` / root-check-serialized | exit0,268/268, types/check-only lint/build; original styled timings15.20/40.78ms. Original failure retained; no weakening or automatic retry loop. |
| `npm --prefix apps/bots run check` / bots-check-frozen | exit0; fixtures/types/check-only lint and identical ordinary884/coverage884 suite. Existing aggregate thresholds unchanged:92.76% lines,88.35% branches,90.49% functions. New cache/metadata denial tests are in that ordinary suite. |
| `npm --prefix apps/bots-sync run check` / worker-check-frozen | exit0; strict types/check-only lint,18/18 actual Miniflare DO/R2 with fixture Registry RPC, Wrangler dry-run build. No remote resource or deployment. |
| `npm run test:devices` / devices-frozen | exit0,24/24; full real Swift helper/Node/Registry SQLite/Bots/Miniflare cache chain and existing direct expiry/binding/network/first-winner/offline/peer/PR cases.16564-byte new staggered chain/passive delta0/native+2 now runs on stable final source. |
| `npm --prefix apps/bots run test:crash` / bots-crash-frozen | exit0,17/17 normal suite, rebinding the changed main/config/HTTP/private-channel startup inputs. |
| `npm --prefix apps/bots run eval -- --case chat-basic` / eval-chat-basic-frozen | exit0,1 case, real daemon startup/ordinary chat under changed main/config/HTTP. |
| `npm --prefix apps/bots run eval -- --case root-resources` / eval-root-resources-frozen | exit0,1 case, passive import plus explicit native root resource execution under changed entry wiring. |

Swift source/manifests/scripts/fixtures are unchanged. Reuse the fixed-baseline
swift-build-first,swift-strict-official,swift-macos-coverage (208/51/60;93.2% default
filtered coverage) and swift-client-coverage-peer-pull (40/46/52;90.9%) only for their
recorded input scopes; no new Swift-wide gate is claimed. The devices gate actually
rebuilds/uses the real helper. Other prior exact eval cases retain historical scopes,
not a claim they reran on this full map. Browser remains normal delivery pre-push.
Independent Review/Lead candidate acceptance and normal commit/push are still pending.

Final staged diff-check found five trailing ASCII-space runs in the new Wrangler
generated worker-configuration.d.ts. Original index-check exit2, exact626388-byte
original file, proposala9d0acca and receipt315a1bc3 are retained. Lead approved only
those five removals (lines12599/13113/13181/13749/14261); no regeneration, full-file
formatting or ignore change. Source-v2 differs from v1 in this one source path,
SHA0c30471d→c67155ea. Normal Worker typecheck and both diff/cached checks pass.
All preceding full gates retain their exact v1 execution maps; they are reused
through this pure generated-declaration whitespace delta, not labeled v2 full runs.

### CF Review P2#1: real SQLite read attribution

The original source-v1/v2, candidate-v1/tree0baf8df8 and its1407 references plus
candidate itself remain protected. Owned Miniflare renames preserve original rows:
objects/get, events/list, recipients/get+list and event_objects/list. Worker red
725418df returns403/auth_failed or a swallowed200 gap; green dacf6273 passes24/24
with503/storage_failed, actual local SQL cause identity and one runtime origin.
The original process red e9f5accb reaches the same legal get refusal.

Registry red8291864c retains original Registry6c9b8f16 and returns ok:false/403
after renaming sync_cache_authorities with a legitimate existing authority row;
the Worker was already fixed, so this is not all-production-equals-old evidence.
Process red174b2182 gates after legitimate mint and before actual RPC SQL read,
then reaches403/auth_failed. Registry green e6f2d886 checks actual cause identity
at the throwing layer; known invalid input/JSON/schema/scope/grant still refuse.
The first named green96993903 failed a cross-RPC exception-text oracle and remains
an oracle failure. Static66986452 failed the new test's inferred type.
The inferred-type error is fixed by an explicit test annotation; the successful567e6493
run binds source-v3, including the separately reviewed Registry SQL fix.

Full encrypted-objects file dd9434b9 is2/2 on a stable726 map. Its five DO read
windows return503/storage_failed and two Registry get/list windows503/internal,
all with one Worker origin, original trace/Bot/failure propagated as Bots warn,
unchanged DB/pin/execution/provider and no supplied body/raw SQL. Restoring each
table permits reading the original object. Existing R2 gap/crypto and offline
history/passive0/native+2 assertions remain. Source-v3 SHA67ead90b freezes exactly
seven authorized source/test/fixture deltas from v2,685 selected/726 full inputs.

| Actual new command/evidence label | Result and precise scope |
| --- | --- |
| `npm --prefix apps/bots-sync run check` / worker-check-v3 | exit0,24/24, strict types/check-only lint and dry-run build; log04a4c35d. |
| `npm run test:devices` / devices-v3 | exit0,24/24, including all seven SQL windows and the original real Swift/helper/cache/offline/peer/PR chains; log20861827. |
| `npm run check` / root-check-v3 | exit0,268/268 plus strict types/check-only lint/build; log8952586b. Ran after Worker/devices completed, without concurrent owned heavy gates. |

Each new gate has an identical726 before/after map matching all685 frozen inputs.
reuse-v3.json SHA3e32be3a binds307 unchanged independent Bots/fixtures/eval/PROTOCOL
inputs to original ordinary884/coverage884, crash17 and the two exact eval cases.
OBSERVABILITY's changed classification narrative leaves the exact consumed event
table lines unchanged. The four original Swift input scopes181/142/181/71 also
match exactly. No new Bots/Swift/crash/eval-wide execution is claimed. Browser
remains normal pre-push; independent delta/candidate acceptance precedes delivery.

review-p2-sql/red-input-archive-v1.json and its supplement bind exact matching
historical test/fixture bytes where available. Four distinct intermediate test
SHAs have no matching byte archive:755bd007,bab630bc,5e6fa392,fd8ab06a. Their
original execution maps/logs remain; later formatted/current bytes are separate
and are never substituted as those historical versions.

### Automatic transport slice on delivered abec9dbb

[SYNC-AUTO.md](SYNC-AUTO.md) is the finite local contract. Source-v1 receipt
`.local/sync-p4-auto-transport/source-v1.json` SHA0c42a94c freezes689 selected inputs,
731 full files and19 actual source/test/fixture deltas; its archive/patch preserves
the exact bytes. All1553 prior delivery references remain protected. This source
freeze requests read-only Review; it does not certify candidate acceptance/delivery.

- auto-entry-second is the real paired/granted/bound connection PUT404 red;
  earlier method/cleanup fixture errors retain their scope. No manual transfer loop
  is used after the trusted baseline in the automatic cases.
- prefs-cold-first is a real corrupt optional file stopping daemon startup. The
  isolated controller retains the file/failure and pauses synchronization;
  prefs-cold-second4/4 proves native+2. The latest full file additionally tests an
  actual live prefs rename failure/native+2. Component permission EACCES checks
  preserve original bytes/cause and one origin; connection management returns503.
- Actual loopback TCP refusal/truncated body differ from remote SQL/auth/bad JSON
  and active cancellation. bots-deadline-first proves private authorization waiting
  wrongly started the competitor; the final deadline starts at actual qualified
  network connection and ends after the authenticated response/current auth.
- auto-stage-first4/4 and auto-pages-first5/5 cover direct/CF alternate winners,
  disable/rebind refusal and Self-loss preserving CF at actual owned filefsync
  barriers. The real chain then creates history after A closes, automatically
  caches it, closes B, cold starts A at localReady and explicitly opens locally.
  It receives exact7788-byte final object plaintext, full38-entry head/section
  order, zero passive submission/task/local_runs/peer/PR/provider and native+2.
- auto-pages-first uses actual SDK commits130 entries, a first page8320199 bytes
  cut before128 events, real DO metadata availability barrier with original R2
  winner/uploaded preserved, second gap revisit and a new tail before release.
  Exact full events drain with list6/get3/R2get10 and no passive execution.
  Test-only I/O counters record metadata, not request bodies/authority/keys.
  auto-pages-first d316a7b8 is format-before evidence: its731 execution map is
  stable, but only676/689 source-v1 selected bytes match. It is not a final
  full-source run; the normal v1 gates below bind all689 separately.
- bots-probe-drain-first has two genuine component reds: successes too close
  after a slow probe and a redundant third apply after another source drained it.
  The second run's remaining direct expectation was a fixture that still forced
  every direct attempt to fail. The corrected third29/29 includes the original
  real SDK dependency suite; core drain already loops all sources and is unchanged.
- worker-mixed-first26/26 retains actual unknown first ACK/event clocks across72h,
  specific event-expired versus generic authority expiry and fresh suffix ACK.
  The uploaded-clock proxy and Registry RPC double are owned fixture scope;
  this is not elapsed72h or deployed-cloud evidence. Controller recovery separately
  retries the persisted ID, bounds single-event probing to the original manifest
  window and returns to128-event batching. Normal scanning never uses limit1.

The initial static run retained five new test non-null warnings; a later run
retained the resulting formatter error after the formatter was mistakenly invoked
from root for the isolated Bots path. The corrected own-package formatter and
static-third pass strict types/check-only lint in root/Bots/Worker and diff-check.
All original logs/maps are retained; formatting edits are not behavior reds.

| Normal gate | Current actual scope |
| --- | --- |
| bots-check-first | ordinary901/901 and same coverage901/901; strict types/lint/fixtures; lines92.72/branches87.85/functions90.68, original90/85/90 thresholds. |
| worker-check-first |26/26; strict types/check-only lint and dry-run build. |
| root-check-first |268/268/types/check-only lint/build, serialized after previous heavy gates. |

Those three gates retain identical731 before/after maps matching all689 frozen
inputs. The complete devices-first command retains its15/16 failure: daemon startup
in proof-expiry collided with another parallel fixture's singleton port44236. The
two raw canonical roots independently reproduce that FNV-1a port. It did not reach
the proof-expiry assertions; no product cause or flaky label is inferred.

devices-second runs the same normal complete command without source/assertion/
timeout changes and passes27/27, including all proof-expiry subcases. All689 frozen
source bytes match before/after. Its731 map has exactly three documentation changes
(PLAN/SYNC-ARCHITECTURE/SYNC current-state wording) made during execution; these
files are not loaded by the fixture. The full map is explicitly not called stable.
No extra source gate is run for those prose-only changes.

Changed main startup/close and ReadyReplica/ReplicaSync admission inputs receive a
new normal crash17/17 and the two exact existing eval cases chat-basic and
root-resources (one case/two rows each), all with identical731 maps matching689
frozen inputs. This is no broader eval claim. swift-reuse-v1.json SHA c8e1b571
compares the four original181/142/181/71 Swift package/script/fixture scopes exactly:
macOS build, official strict scope, original filtered default90 coverage93.2%, and
independent client default90 coverage90.9%. No new Swift gate is claimed; devices
actually builds/runs the helper. Normal pre-push still runs its original Swift gates.

Exact current gate logs: Bots4c3e6122, Worker4fde2f01, rootc393f5f9,
devices-firstdc0eeef5, devices-second877ced61, crash11f686c1,
eval-chat-basic28761e3e and eval-root-resourcescc11463c. Every original start/raw/exit
is retained with its actual input map. Source/docs/index/candidate binding follows
these records; independent Review/Lead acceptance is required before delivery.
Browser remains normal pre-push; no physical Mac/App or live CF evidence is implied.

#### Automatic transport Review P2#1/#2: origin and local apply completion

Source-v2 receipt05fee46ec20d06fcb2c6f54d0d0e4fd164ad02c9ab499da37fe7126e2c9be8fd
retains all689 selected/731 full paths and changes exactly four paths from v1:
sync-auto, DeviceSyncConnections, its component test and encrypted-objects process
test. The original source-v1, archives, gates and failures are unchanged. Review
closed the other v1 scope; incremental acceptance of these two fixes is separate.

P2#1's valid-UUID component red5f382e73 and real pre-turn binding red e401c4ef
show the missing origin on the original controller926d95a0. The earlier component
682d8fac used an invalid epoch and is a fixture failure, not that behavior red.
The minimum fix emits runtime.sync.fail only where the controller itself creates
the auth_failed refusal, with the original automatic trace/Bot/failure identity.
Component18/18 and real full-file5/5 b8c6782c pass; lower ClassifiedFailure stays
single-origin. The actual binding changes before the first turn, separately from
late stage fences, with no object/pin/apply/provider changes.

P2#2 red0db3c2a1 (component) and a2b7b0eb (real full-file4/5) use the #1-fixed
controller0852f268, not all old-v1 production. The real ReplicaStore.receive
commits, then an owned facts-table rename causes actual drain SQLite I/O failure:
received21/applied15, original cause retained. Restoring the original table with
no new B/CF data still cannot finish the head. The fix persists one pendingApply
objectId per connection after full cache storage and before apply, retries that
fixed-pin object before online work, and clears only on successful return. A
successful dependency wait clears the slot, so it does not add useless retries.
Same-binding configuration preserves the slot; disable/rebind/close guards remain.

Component green7fa33721 is23/23 on format-before controller8fcc7890. Later formatting
and static3711cc78 bind current controller794bcabf. Real green89ca6f0e is5/5 on
that final source: restored I/O completes actual applied/head with zero additional
get, unchanged event clocks/digests, original cause/trace/Bot and one error origin,
passive0 and native execution preserved. Component reopen separately proves the
persisted slot works with peer/CF ports forbidden; it is not a new physical/cold
cloud claim. Original core drain/CF protocol semantics are unchanged.

| Source-v2 normal command/evidence label | Actual result |
| --- | --- |
| Root/Bots strict types and normal check-only lint / p2-apply-static | exit0; log3711cc78; diff and cached checks pass. |
| `npm --prefix apps/bots run check` / bots-check-v2 | ordinary908/908 and same coverage908/908; lines92.75/branches87.88/functions90.68 at original90/85/90 thresholds; log89705c30. |
| `npm run test:devices` / devices-v2 | complete27/27, including both P2 windows and the original real Registry/helper/Node/Bots/DO/R2 automatic chain; logb5addb5d. |

All three new executions have identical731 before/after maps matching every689
source-v2 input. gates-v2.json SHA5b6cb188 and reuse-v2.json SHAe6b59449 bind
the new commands and exact old scopes; review-p2-results-v2.json SHA64cdb220
preserves each red/green production combination. Worker26 and root268 test/build
retain their v1 execution scopes:
the Worker package/fixtures and root test/build inputs are individually unchanged;
new root/Bots types/lint cover the affected process tests. Crash17 and the two
exact eval cases remain v1 runs; their no-device startup does not instantiate the
changed controller, and their loaded unchanged branches are reused explicitly,
not described as all-source equality or new v2 execution. Original Swift scopes
181/142/181/71 still match; no new Swift-wide gate is claimed. Browser remains
normal pre-push. Final candidate binding and independent acceptance precede delivery.
