# Bots — test contract

Status: **phase 1 contract**. Tests are the specification of each layer and the
enforcement of the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md). Runtime
behaviour under test is described in [RUNTIME.md](RUNTIME.md); log assertions in
[OBSERVABILITY.md](OBSERVABILITY.md).

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
| 6 | `test/log/shape.test.ts` | `every declared event name is used and every used name is declared` | log module |
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
| 25 | `test/runtime/mapEvents.test.ts` | `applies block and message replacements without loss` | 23 |
| 26 | `test/runtime/mapEvents.test.ts` | `a retry inside one turn starts a new attempt id` | 23 |
| 27 | `test/runtime/mapEvents.test.ts` | `maps every stopReason to a message state` | 23 |
| 28 | `test/runtime/adapter.test.ts` | `one turn appends exactly one pi.assistant entry` | 23 |
| 29 | `test/runtime/idempotency.test.ts` | `the same requestId returns one record and emits no new events` | 28 |
| 30 | `test/runtime/adapter.test.ts` | `abort settles the running and queued inputs with reason aborted` | 28 |
| 31 | `test/runtime/adapter.test.ts` | `a provider error settles unanswered with reason model_error` | 28 |
| 32 | `test/runtime/adapter.test.ts` | `a model asking for a tool gets an error result and the run continues` | 28 |
| 33 | `test/runtime/failures.test.ts` | `a parked task surfaces as task_parked from onReport, once` | 28 |
| 34 | `test/runtime/failures.test.ts` | `a storage failure closes the harness and classifies storage_failed` | 28 |
| 35 | `test/runtime/recovery.test.ts` | `open resumes a run interrupted by close` | 28 |
| 36 | `test/runtime/adapter.test.ts` | `close resolves timeout without dropping the handle` | 28 |

### Stage 4 — server, lifecycle and end-to-end

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 37 | `test/server/auth.test.ts` | `rejects a wrong bearer token before upgrade` | 17 |
| 38 | `test/server/socket.test.ts` | `closes 1008 when hello is not the first frame` | 37 |
| 39 | `test/server/socket.test.ts` | `closes 4004 for an unknown bot and 4090 while quarantined` | 37 |
| 40 | `test/server/socket.test.ts` | `a second subscribe on one connection closes 1008` | 37 |
| 41 | `test/server/catalog.test.ts` | `create, rename and delete keep the catalog absolute` | 9, 37 |
| 42 | `test/log/origin.test.ts` | `a failed trace has exactly one error record, at the innermost layer` | 6, 38 |
| 43 | `test/log/trace.test.ts` | `R1–R4 hold with a fake clock and a drain barrier` | 42 |
| 44 | `test/core/registry.test.ts` | `open is idempotent and shared by concurrent subscribers` | 28 |
| 45 | `test/core/registry.test.ts` | `an idle bot closes after idleCloseMs and reopens on demand` | 44 |
| 46 | `test/core/registry.test.ts` | `a timed-out close quarantines and refuses open and delete` | 36, 44 |
| 47 | `test/core/registry.test.ts` | `recovery scan resumes active bots and leaves the rest closed` | 44 |
| 48 | `test/core/singleton.test.ts` | `a live daemon rejects a second instance on the same root` | 44 |
| 49 | `test/e2e/journey.test.ts` | `create, chat three turns, reconnect and delete` | 41, 44 |
| 50 | `test/e2e/journey.test.ts` | `two bots stream independently with separate revisions` | 49 |
| 51 | `test/e2e/journey.test.ts` | `a lost submission reply is recovered by re-sending the requestId` | 49 |
| 52 | `test/e2e/journey.test.ts` | `a bot joining mid-answer receives the partial in the snapshot` | 49 |
| 53 | `test/crash/sigkill.test.ts` | `killing the daemon mid-answer loses no message and duplicates none` | 49 |
| 54 | `test/crash/singleton.test.ts` | `a SIGKILLed daemon is taken over on the next start` | 48 |

### Stage 5 — client

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 55 | `BotsCoreTests/FixtureDecodingTests.swift` | `decodes every committed fixture` | 1 |
| 56 | `BotsCoreTests/ReducerTests.swift` | `append upserts by id and applies replaces` | 55 |
| 57 | `BotsCoreTests/ReducerTests.swift` | `delta applies text, block and message changes in order` | 55 |
| 58 | `BotsCoreTests/ReducerTests.swift` | `a snapshot replaces state and resets the baseline` | 55 |
| 59 | `BotsCoreTests/ReducerTests.swift` | `a revision gap requests a resync and drops later events` | 55 |
| 60 | `BotsCoreTests/ReducerTests.swift` | `a duplicate submission reply does not disturb the transcript` | 55 |
| 61 | `BotsTransportTests/SocketTests.swift` | `speaks the fixture server: handshake, subscribe, stream, paging` | fixture server |
| 62 | `BotsTransportTests/SocketTests.swift` | `maps close codes to connection states and reconnects on 1006` | 61 |
| 63 | `BotsFeaturesTests/ConversationTests.swift` | `connecting, ready, resync, reconnect and failed` | 59, 61 |
| 64 | `BotsFeaturesTests/ComposerTests.swift` | `optimistic bubble is replaced by the submission and append` | 60 |
| 65 | `BotsFeaturesTests/ComposerTests.swift` | `retry reuses the same requestId` | 64 |
| 66 | `BotsFeaturesTests/ComposerTests.swift` | `sending while busy queues with followUp and survives a restart of the view` | 64 |
| 67 | `BotsFeaturesTests/CatalogTests.swift` | `create selects the new bot; delete removes it; a push updates the list` | 61 |
| 68 | `BotsFeaturesTests/RecoveryTests.swift` | `an unavailable bot offers recover and returns to live` | 63 |
| 69 | `BotsCoreTests/DependencyRulesTests.swift` | `no networking API in core or features; no wire decoding outside transport` | 55 |

## Golden fixtures

- `fixtures/bots-protocol/*.json` are normative. `npm run fixtures:check` encodes
  every fixture through the daemon codec and fails on any byte difference;
  `npm run fixtures:write` regenerates them after a documented protocol change.
- `test/protocol/fixtures.test.ts` also asserts that the file set equals the table
  in [PROTOCOL.md](PROTOCOL.md#fixtures): an undocumented fixture fails.
- The Swift package decodes the same directory through a relative path, so one
  changed fixture breaks both sides in the same commit.
- Golden event sequences (not just single frames) are checked in under
  `test/runtime/golden/` for: a plain answer, an answer with deltas, a retry inside
  one turn, a tool-call attempt, an abort with a queued input, and a provider
  error.

## Fault injection

| Injected fault | Expected |
| --- | --- |
| Wrong bearer token | HTTP 401; no `core.*` log; no bot opened |
| Malformed JSON frame | Close 1008; `protocol.decode.fail` only |
| Unknown command type | `error{invalid_command}`, connection kept |
| `subscribe` to a missing bot | Close 4004; `core.bot.resolve.fail` only |
| `runtime.open` rejects | Bot `unavailable`; snapshot carries `unavailable`; one `error` at core |
| `send` before admission rejects | `error`, **no** `submission` frame; client keeps the draft |
| Reply to `send` lost | Re-send the same `requestId` returns the record; no duplicate entry |
| Provider error | `unanswered{reason:"model_error"}`; provider text absent from logs |
| Abort with a queued input | Both settle `unanswered{reason:"aborted"}`; inbox empty |
| Parked task | One `error{kind:"task_parked"}` within 60 s; `recover` clears it |
| Watch ends once | Reattach + snapshot; no client-visible error |
| Watch ends three times in 60 s | `error{kind:"internal"}`, bot `unavailable` |
| `session.sqlite` replaced with junk | That bot `unavailable`; other bots unaffected; daemon alive |
| `close` never resolves | Quarantine; open and delete refused; retry every 30 s |
| Subscriber stops reading | Queue overflow → snapshot-only; daemon keeps serving others |
| Second daemon on the same root | Exits non-zero; first unaffected |
| `SIGKILL` mid-answer | Restart resumes; no message lost or duplicated |
| Delete killed after rename | Restart reconciliation finishes the delete |

## Crash test

`test/crash/sigkill.test.ts` is **mandatory at every stage signoff** and opt-in
for the fast gate (`npm run test:crash`).

The barrier is a fact about commits, not a sleep: the test starts a daemon with a
provider that streams slowly, waits for the first `core.hub.publish.ok` with a
delta in the daemon log (deltas are only ever emitted from committed state), then
`SIGKILL`s the process. After restart it asserts exactly one user entry and one
assistant entry, that the answer is complete, and that no duplicate submission
exists. A second case kills after `rename` during delete and asserts the startup
reconciliation removed the catalog entry.

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
npm test                # fast gate: no sockets left open, under 30 s
npm run typecheck       # tsc --noEmit
npm run lint            # biome check --error-on-warnings
npm run coverage        # thresholds enforced, see below
npm run test:crash      # mandatory at stage signoff
npm run perf            # informational + generous bounds
npm run check           # fixtures:check + test + typecheck + lint + coverage

cd apps/bots-macos
swift test
./Scripts/coverage.sh    # Bots logic gate, own script
```

`npm run coverage` runs Node's own reporter with enforced thresholds:

```sh
node --test \
  --experimental-test-coverage \
  --test-coverage-include='src/**/*.ts' \
  --test-coverage-exclude='src/testing/**' \
  --test-coverage-include-all \
  --test-coverage-lines=90 --test-coverage-functions=90 --test-coverage-branches=85 \
  'src/**/*.test.ts' 'test/**/*.test.ts'
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

1. Every ladder row of the stage is green; documents updated in the same commits.
2. `npm run check` (daemon) and `swift test` + `Scripts/coverage.sh` (client) pass.
3. `npm run test:crash` passes and its output is quoted in the stage checkpoint.
4. One injected failure per layer was demonstrated and attributed by
   `test/log/origin.test.ts` for that layer.
5. No widened limits, silenced log, swallowed error or new `test.only`.
6. [CHECKPOINTS.md](CHECKPOINTS.md) records what a user can see, what was run, and
   the next broken hop.
