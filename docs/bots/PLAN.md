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
  src/core/                domain types, catalog, hub, runtime port, service
  src/protocol/            wire codec, limits, validation
  src/log/                 declared event catalogue and the layer logger
  src/runtime/pi/          pi-durable adapter            (not started)
  src/server/              http + websocket transport    (not started)
  src/testing/             fake runtime and test helpers
  test/{protocol,core,log,architecture}.test.ts
apps/bots-macos/           the client: separate SPM package   (not started)
```

Gates, all run in `apps/bots`: `npm run check`
(`fixtures:check`, `npm test`, `typecheck`, `lint`, `coverage` 90/85/90).
`npm run test:crash` and `npm run perf` are separate, from stage 4.

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
| 17 | 2 | `send` needs a subscription and answers a connection-scoped record | **not started** |
| 18 | 2 | a repeated `requestId` returns the stored record, no new events | **not started** |
| 19 | 2 | queued, placed and done map to one submission id | **not started** |
| 20 | 2 | `unanswered` keeps its reason and never invents a settlement | **not started** |
| 21 | 2 | history pages older messages, newest window untouched | **not started** |
| 22 | 2 | resync returns a snapshot at the last published revision | **not started** |
| 23-36 | 3 | pi-durable adapter: mapping, idempotency, failures, recovery | **not started** |
| 37-54 | 4 | server, lifecycle, end-to-end, crash and perf suites | **not started** |
| 55-69 | 5 | macOS client: decoding, reducer, transport, view models, app | **not started** |

Current tree: 167 tests, coverage 95.9% lines, `typecheck`, `lint`, `fixtures:check`
green. Nothing listens on a socket yet, so the product is not runnable.

## Next work, in order

1. Write `src/core/ConversationService.ts`, which owns rows 17-22:
   - `subscribe(botId, trace)`: open through the registry, render the first snapshot
     at the current revision, then attach the runtime sink to the hub.
   - `send(input)`: read `RuntimeHandle.submission({requestId})` first so a duplicate
     returns the stored record; reply on the connection (no revision) and let the hub
     broadcast settlements.
   - `abort`, `recover`, `history`, `resync` (snapshot at `hub.rev`).
   - Failure handling by `disposition`: only `not_admitted` lets a client drop its
     outbox entry.
2. Stage 3: `src/runtime/pi/` (mapEvents, PiDurableRuntime) with the golden
   sequences and fault channels in [RUNTIME.md](RUNTIME.md).
3. Stage 4: `src/server/`, `src/main.ts`, registry lifecycle, crash and perf suites.
4. Stage 5: `apps/bots-macos/` (separate package, `EagleDesign` product only).

## Open review queue

Empty. Rows 9-16 are signed off; the six review rounds that closed them found, in
order: revisions consumed before a delta was folded, unfaithful delta merging, a
silently dead degraded subscriber, reentrant fanout, a missing byte trigger,
non-wire byte counting, a detached subscriber still pumped, a fake-runtime toolcall
path read from the wrong root, a lost streaming pointer, history truncated by a
window rerender, unbounded batches inside one event, a stale anchor served as
current, a starved cross-subscriber pump, an evicted recovery snapshot, and one
test that could not fail.
