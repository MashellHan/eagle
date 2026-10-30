# Bots — test contract

Status: **phase 1 contract**. Tests are the specification of each layer and the
enforcement of the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md). Runtime
behaviour under test is described in [RUNTIME.md](RUNTIME.md); log assertions in
[OBSERVABILITY.md](OBSERVABILITY.md).

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
