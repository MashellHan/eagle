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
| 17 | 2 | `send` needs a subscription and answers a connection-scoped record | **signed off** |
| 18 | 2 | a repeated `requestId` returns the stored record, no new events | **signed off** |
| 19 | 2 | queued, placed and done map to one submission id | **signed off** |
| 20 | 2 | `unanswered` keeps its reason and never invents a settlement | **signed off** |
| 21 | 2 | history pages older messages, newest window untouched | **signed off** |
| 22 | 2 | resync returns a snapshot at the last published revision | **signed off** |
| 23-36 | 3 | pi-durable adapter: mapping, idempotency, failures, recovery | **not started** |
| 37-54 | 4 | server, lifecycle, end-to-end, crash and perf suites | **not started** |
| 55-69 | 5 | macOS client: decoding, reducer, transport, view models, app | **not started** |

Current tree: 199 tests, coverage 96.5% lines, `typecheck`, `lint`, `fixtures:check`
green. The core is complete: catalog, hub, service, fake runtime. Nothing listens on a
socket yet and no real runtime adapter exists, so the product is not runnable.

## Next work, in order

1. Stage 3: `src/runtime/pi/` (mapEvents, PiDurableRuntime) with the golden
   sequences and fault channels in [RUNTIME.md](RUNTIME.md).
2. Stage 4: `src/server/`, `src/main.ts`, registry lifecycle, crash and perf suites.
3. Stage 5: `apps/bots-macos/` (separate package, `EagleDesign` product only).

`ConversationService` (rows 17-22) is done: `subscribe` renders the current view as
the connection's baseline and goes live in one serial section, `send` reads the stored
record first so a retry is silent, `history` pages without touching the window,
`abort`/`recover` pass through behind the same subscription guard, and `resync`
broadcasts the only reply it produces, at a revision that names its content.

## Open review queue

Empty. Stage 2 (rows 9-22) is signed off. The review rounds closed, in order:
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
