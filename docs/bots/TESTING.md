# Bots — test contract

Status: **phase 1 contract**. Tests are the specification of each layer's
behaviour and the enforcement of the boundaries in
[ARCHITECTURE.md](ARCHITECTURE.md). Runtime mapping under test is described in
[RUNTIME.md](RUNTIME.md); log assertions in
[OBSERVABILITY.md](OBSERVABILITY.md).

## The loop (non-negotiable)

For every behaviour change:

1. Update the owning document first if a contract, semantic or log event changes.
2. Add or change the test that demonstrates the behaviour. Run it and record the
   failure text in the commit body (`Red:` line).
3. Write the smallest implementation that makes it pass.
4. Run the layer's tests, then the full gate.
5. Commit once: documents + failing-then-passing test + implementation. `main`
   never holds a red commit.

Commit body format:

```
Red: <test name> — <one line of the failure it produced>
Tests: <files or names>
Checks: cd apps/bots && npm run check
```

## What may be faked, and what may not

| Real, never faked | Faked in unit tests | Notes |
| --- | --- | --- |
| Protocol encode/decode against fixtures | — | A codec that only round-trips its own bug is useless |
| `BotDirectory` file writes (real temp dir) | — | Atomicity is a filesystem property |
| `EventHub` ordering and backpressure | — | Pure in-memory async, no reason to fake |
| SQLite storage + `Harness.open` | — | `test/runtime/**` uses real `openNodeSqliteStorage` in a temp dir |
| HTTP/WS transport (real `node:http`, ephemeral port) | — | Close codes and auth only exist on a real socket |
| pi-durable itself | Model provider only | `fauxProvider()` replaces the network, not the runtime |
| — | `RuntimePort` (core tests) | `testing/FakeRuntime.ts` replays scripted `RuntimeEvent` |
| — | `Clock` | Coalescing and idle close use an injectable clock |
| — | `ConversationPort` / `BotCatalogPort` (Swift VM tests) | Domain fakes, no URLSession |
| — | `URLProtocol` (Swift transport unit tests) | Frame-level, with the real client logic |

A test that mocks the layer it is meant to verify is a deleted test.

## Test ladder

Ordered; each row is one commit-sized step. "First failing test" is the test to
write first.

### L3 protocol and transport (daemon)

| Step | File | First failing test |
| --- | --- | --- |
| P1 | `test/protocol/fixtures.test.ts` | `decodes every committed fixture without loss` |
| P2 | `test/protocol/events.test.ts` | `encodes a snapshot identical to the committed fixture` |
| P3 | `test/protocol/commands.test.ts` | `rejects a send without a requestId` |
| P4 | `test/protocol/limits.test.ts` | `rejects text longer than 8000 characters` |
| P5 | `test/protocol/versioning.test.ts` | `ignores an unknown server event type` / `rejects an unknown command without closing` |
| P6 | `test/protocol/redaction.test.ts` | `never puts message text outside blocks` |
| P7 | `test/server/auth.test.ts` | `rejects a wrong bearer token before upgrade` |
| P8 | `test/server/socket.test.ts` | `closes 1008 when hello is not the first frame` |
| P9 | `test/server/socket.test.ts` | `closes 4004 for an unknown bot id` |
| P10 | `test/server/catalog.test.ts` | `create, rename, delete keep the catalog absolute and idempotent` |

### L2 core

| Step | File | First failing test |
| --- | --- | --- |
| C1 | `test/core/directory.test.ts` | `keeps the previous catalog when a write is interrupted` |
| C2 | `test/core/directory.test.ts` | `rejects a duplicate bot id` |
| C3 | `test/core/hub.test.ts` | `assigns strictly increasing revisions per bot` |
| C4 | `test/core/hub.test.ts` | `delivers the same sequence to every subscriber` |
| C5 | `test/core/hub.test.ts` | `downgrades a subscriber that falls behind to snapshot-only` |
| C6 | `test/core/hub.test.ts` | `coalesces deltas inside one 50ms window` |
| C7 | `test/core/service.test.ts` | `send requires a subscription` |
| C8 | `test/core/service.test.ts` | `maps queued, placed and done submissions to the same submissionId` |
| C9 | `test/core/service.test.ts` | `renders an unanswered submission as a model failure, not a transport failure` |
| C10 | `test/core/service.test.ts` | `resync returns a snapshot whose rev equals the last published event` |
| C11 | `test/core/registry.test.ts` | `open is idempotent and shared by concurrent subscribers` |
| C12 | `test/core/registry.test.ts` | `closes an idle bot after idleCloseMs and reopens on demand` |
| C13 | `test/core/registry.test.ts` | `delete closes, moves the directory to trash and updates the catalog` |
| C14 | `test/core/registry.test.ts` | `recovery scan resumes active bots and leaves the rest closed` |
| C15 | `test/core/lock.test.ts` | `a second daemon on the same root exits non-zero` |

### L1 runtime adapter

| Step | File | First failing test |
| --- | --- | --- |
| R1 | `test/runtime/mapEvents.test.ts` | `maps a recorded run to append, delta, append, submission, status` |
| R2 | `test/runtime/mapEvents.test.ts` | `ignores message_start and turn_start` |
| R3 | `test/runtime/mapEvents.test.ts` | `names the provisional message p_1 and finalizes it with replaces` |
| R4 | `test/runtime/mapEvents.test.ts` | `maps aborted and error stop reasons to message state` |
| R5 | `test/runtime/adapter.test.ts` | `submit then wait produces exactly one pi.assistant entry` |
| R6 | `test/runtime/idempotency.test.ts` | `the same requestId produces one user entry and one submission` |
| R7 | `test/runtime/adapter.test.ts` | `abort leaves the conversation idle and settles the submission` |
| R8 | `test/runtime/adapter.test.ts` | `a provider error settles unanswered with reason and detail` |
| R9 | `test/runtime/adapter.test.ts` | `a model asking for a tool gets an error result and the run continues` |
| R10 | `test/runtime/recovery.test.ts` | `a run interrupted by close resumes on reopen` |
| R11 | `test/runtime/adapter.test.ts` | `close is bounded and reports a timeout` |

### End to end, log and performance

| Step | File | First failing test |
| --- | --- | --- |
| E1 | `test/e2e/journey.test.ts` | `create, chat three turns, reconnect and delete` |
| E2 | `test/e2e/journey.test.ts` | `two bots stream independently without interleaving revisions` |
| E3 | `test/log/shape.test.ts` | `every failure carries a closed err.kind` |
| E4 | `test/log/trace.test.ts` | `R1: an open stall stops at core without runtime.open.ok` |
| E5 | `test/log/trace.test.ts` | `R2: a dead watch is attributed to runtime` |
| E6 | `test/log/trace.test.ts` | `R3: a malformed command produces no core events` |
| E7 | `test/log/redaction.test.ts` | `message text never reaches the log` |
| E8 | `test/log/catalog.test.ts` | `every emitted event name is in the catalog` |
| E9 | `test/perf/baseline.test.ts` | `cold open, reopen, one turn and twenty bots stay inside the documented bounds` |
| E10 | `test/architecture.test.ts` | `core does not import pi-durable` |

### L4 client

| Step | File | First failing test |
| --- | --- | --- |
| S1 | `BotsCoreTests/FixtureDecodingTests.swift` | `decodes every committed fixture` |
| S2 | `BotsCoreTests/ReducerTests.swift` | `append upserts by id and applies replaces` |
| S3 | `BotsCoreTests/ReducerTests.swift` | `delta appends text to the target message` |
| S4 | `BotsCoreTests/ReducerTests.swift` | `a revision gap requests a resync and drops later events` |
| S5 | `BotsCoreTests/TranscriptBuilderTests.swift` | `builds rows for user, assistant, notice and a streaming tail` |
| S6 | `BotsFeaturesTests/ConversationTests.swift` | `subscribe to snapshot to live to resync` |
| S7 | `BotsFeaturesTests/ComposerTests.swift` | `optimistic bubble is replaced when the submission and append arrive` |
| S8 | `BotsFeaturesTests/ComposerTests.swift` | `retry reuses the same requestId` |
| S9 | `BotsFeaturesTests/ComposerTests.swift` | `sending while busy queues with followUp` |
| S10 | `BotsFeaturesTests/CatalogTests.swift` | `create selects the new bot; delete removes it` |
| S11 | `BotsCoreTests/DependencyRulesTests.swift` | `features, core and design contain no networking API` |

## Golden fixtures

- `fixtures/bots-protocol/*.json` are normative. `npm run fixtures:check`
  re-encodes every fixture through the daemon codec and fails on any byte
  difference; `npm run fixtures:write` regenerates them after a documented
  protocol change.
- `test/protocol/fixtures.test.ts` also asserts the file set matches the table in
  [PROTOCOL.md](PROTOCOL.md#fixtures) — a fixture cannot exist undocumented.
- Swift decodes the same directory via a relative path from `Package.swift`, so
  one change to a fixture breaks both sides in the same commit.

## Fault injection

Each row has a test that asserts both the response and the layer attribution.

| Injected fault | Expected |
| --- | --- |
| Wrong bearer token | HTTP 401; no `core.*` log; no bot opened |
| Malformed JSON frame | Close 1008; `protocol.decode.fail` only |
| `subscribe` to a missing bot | Close 4004; `core.bot.resolve.fail` only |
| `RuntimeHandle.snapshot()` throws | Bot marked `unavailable`; client snapshot carries `unavailable`; `core.bot.open.fail` |
| `submit()` throws | `error{kind:"internal"}`, submission marked unanswered at the client, connection kept |
| Provider error | `unanswered{reason:"model_error"}`; no `error` event |
| Storage corruption (`session.sqlite` replaced with junk) | Bot `unavailable`, daemon alive, other bots unaffected |
| Client disconnects mid-stream | Run continues; reconnect snapshot contains the finished message |
| Subscriber stops reading | Queue overflow → snapshot-only, no daemon stall |
| Second daemon on the same root | Exits non-zero, first daemon unaffected |

## Performance smoke

`test/perf/baseline.test.ts` prints what it measured and asserts generous bounds
so CI noise cannot mask a real regression:

| Measurement | Bound | Documented value |
| --- | --- | --- |
| `Harness.open` + `root()` | < 250 ms | 7 ms |
| Reopen a bot with 400 entries | < 100 ms | 3 ms |
| One answered turn (faux) | < 200 ms | 2–7 ms |
| 20 bots open | < 1 s | 30 ms |

When a bound is intentionally raised, [PRODUCT.md](PRODUCT.md#speed-targets) and
the bound change in the same commit, with the new measurement recorded.

## Gates

```sh
cd apps/bots
npm run fixtures:check     # codec vs committed fixtures
npm test                   # node --test src/**/*.test.ts test/**/*.test.ts
npm run typecheck          # tsc --noEmit (no build output)
npm run lint               # biome check --error-on-warnings
npm run coverage           # node --test --experimental-test-coverage, lines >= 90
npm run check              # all of the above

cd apps/macos
swift test                 # Bots targets, Swift Testing
./Scripts/coverage.sh      # logic coverage >= 90%
```

Rules:

- No skipped or focused tests. A blocked test is deleted or fixed; a
  `test.skip`/`.only`/`XCTSkip` in the diff fails review.
- Slow tests are opt-in by environment, not by skip: `PI_BOTS_SLOW=1` enables
  `test/e2e/kill.test.ts` (SIGKILL a daemon mid-run, restart, assert no message is
  lost or duplicated) and any test that sleeps for real time. The default gate
  runs in under 30 seconds.
- Every gate is deterministic: no network, no API key, no wall-clock ordering
  assumptions. Time-dependent tests inject a clock.
- Coverage is a floor, not a goal: a layer with 95% coverage and no fault
  injection test is not done.

## Definition of done for a commit

1. The document that owns the behaviour was updated in the same commit (or the
   commit is test-only and says why).
2. The new test failed before the implementation and passes after; the commit
   body records the failure.
3. `cd apps/bots && npm run check` passes; for Swift commits `swift test` passes.
4. No new `test.skip`, no widened limits, no silenced log, no swallowed error.
5. Layer attribution: if the commit adds an error path, a test asserts which
   layer logs it and which layers stay silent.
