# Bots — checkpoints

User-view progress log. One entry per working session, written from the
perspective of what a user or reviewer can observe, not what was typed. Never
claim verification that did not run.

Format per entry:

```
## YYYY-MM-DD HH:MM — <milestone>
Observed: <what can be seen or executed now>
Verified: <commands actually run, with results>
Next broken hop: <the first thing that does not work yet>
```

## 2026-10-25 20:35 — documentation phase complete

Observed: the Bots contract exists as six documents plus a normative fixture set.
No Bots code exists yet, so nothing is runnable. A reviewer can read the product
scope, the layer boundaries, the wire protocol, the runtime mapping, the log
contract and the test ladder without consulting chat history.

Verified:

- `git log` shows seven atomic documentation commits on `main`.
- Every file under `docs/bots/` and `fixtures/bots-protocol/` parses and passes the
  repository pre-commit gate (Biome formats the fixtures, Markdown is excluded).
- `docs/bots/RUNTIME.md` facts F1–F16 were established by running
  `@earendil-works/pi-durable@1.4.0` with `fauxProvider()` on Node 26.12.0 in a
  scratch directory, including: generation appends `pi.assistant` itself
  (`answer` equals that entry id), `message_end` fires for the user entry too,
  `requestId` idempotency, `unanswered{reason:"model_error"}`, late-join
  `watchEvents` snapshots, cold open 7 ms, reopen of 400 entries 3 ms, 20 bots
  open in 30 ms at 103 MB RSS.
- No Eagle code, test or configuration was changed; `apps/bots` does not exist
  yet, so no gate could accidentally start running it.

Next broken hop: `apps/bots` is missing. The first implementation commit has to
create the isolated package (`package.json`, `tsconfig.json`, `biome.json`, test
script) before the protocol codec can be written, otherwise the TDD ladder has
nowhere to run. `apps/macos` still contains only the Eagle client; the `Bots*`
targets do not exist.

## 2026-10-25 21:40 — review round 1 and model endpoint verified

Observed: the contract was reviewed by an independent coding agent (Codex, model
`group/auto-gpt-6-astra`, reasoning `xhigh`) which returned `VERDICT: BLOCKING 7`
with 29 findings. All 29 were accepted as correct or as actionable gaps; the
documents were revised in three commits (ports/ownership/logging, wire, runtime and
tests). The development model endpoint was also verified end to end.

Verified:

- `cd apps/bots && npm run smoke:model` against `http://127.0.0.1:3425/v1`
  (provider `magpie`, model `auto/gpt-6-luna`, OpenAI Responses shape): two turns,
  both `done`, answers `巴黎是法国的首都。`, 1.7 s and 1.3 s per turn, usage
  `68 in / 16 out`. The key is read from the 0600 `.env`, never printed, never in
  argv.
- `npx tsc --noEmit` in `apps/bots` passes for the smoke script.
- Probe P3 established that the assistant `message_start` already carries the full
  partial content, and that `message_update` can be absent entirely (one run had
  zero deltas). Probe P4 established `abort()` settlements (`unanswered{reason:
  "aborted"}`, with `entry` for the running input and without it for queued inputs)
  and duplicate-`requestId` idempotency. Both facts changed the mapping and the
  protocol, so they were applied before code exists.
- `git log` shows the review-fix commits; no Bots code beyond
  `package.json`/`tsconfig.json`/`biome.json`/`scripts/smoke-model.ts` exists yet.

Next broken hop: the daemon has no `src/` code, no lock discipline and no tests, so
the ladder in `docs/bots/TESTING.md` stage 1 cannot run. The skeleton commit carries
`package-lock.json`, the configs and `.env.example` — never the real `.env`, which
holds `BOTS_API_KEY` and stays untracked with mode 0600.

## 2026-10-25 22:30 — documentation signed off

Observed: the contract is signed off by the independent reviewer after eight
rounds. Round 1 found 7 blockers and 29 findings; rounds 2-8 found 7, 5, 4, 3, 2, 2
and finally none. Every finding was accepted and applied, and each round's fix is
its own commit so the reasoning is reviewable.

Verified: the reviewer's final message reports `VERDICT: SIGN OFF`, with B1-B7 all
`FIXED`, all five weak spots closed (content reconstruction, frame budgets, offline
outbox reconciliation, exactly-one-error with attribution, stage-1 signable), and
the note that stage 1 can start "without inventing anything". Its single warning for
implementation: do not lose the "attempt withdrawn" decision — the regression to
watch is over-limit partial, then shorter content, then the entry commits, then a
daemon restart; append, snapshot and history must all yield the same notice.

Nothing has been executed yet beyond the model smoke test and the probe scripts, so
this signoff certifies the contract, not a passing gate.

Next broken hop: stage 1 has no code. The first ladder row is
`test/protocol/fixtures.test.ts` -> `decodes every committed fixture without loss`,
which must fail because no decoder exists, then pass with the protocol module.

## 2026-10-25 22:45 — stage 1 started: the wire decodes and re-encodes

Observed: the protocol codec exists and the normative fixtures are executable. The
ladder rows 1-2 are green; rows 3-8 (command validation, limits, versioning, log
shape and redaction, architecture guards) are not written yet.

Verified:

- `node --test test/protocol/fixtures.test.ts`: 29 tests pass, including "decodes and
  re-encodes <fixture> without loss" for all 17 server fixtures and "the encoder
  reproduces snapshot.server.json byte for byte".
- `npm test` runs the shared unit file list through `scripts/run-tests.sh`; it fails
  loudly when the list is empty, so a gate cannot pass because it found nothing.
- `npm run typecheck` and `npm run lint` pass.
- `npm run check` is expected to fail right now: `npm run coverage` enforces 90 %
  lines over `src/**` with `--test-coverage-include-all`, and most modules
  (`core/`, `runtime/`, `server/`, `log/`) do not exist yet.

Next broken hop: no command validation, no limits enforcement, no log module and no
architecture guard test, so ladder rows 3-8 cannot run. The next commit adds command
validation and limits, then the log module, then the guard tests.

## 2026-10-25 23:20 — stage 1 complete and signed off

Observed: all eight stage-1 ladder rows are implemented, tested and reviewed. The
daemon can decode and encode every protocol frame, validate commands, enforce the wire
budgets, ignore unknown events while consuming their revision, log through a declared
catalogue with redaction, and prove its own layer boundaries by parsing its source.

Verified (all run just now in `apps/bots`):

- `npm test`: 104 tests pass.
- `npm run check`: `fixtures:check` (26 files), tests, `tsc --noEmit`, Biome and
  coverage all pass; coverage is 93.72% lines, 90.30% branches, 96.00% functions.
- Codex reviewed each batch and signed off: rows 1-4 (6 rounds), rows 5-6 (5 rounds),
  rows 7-8 (5 rounds). Every review finding was fixed and re-reviewed; the recurring
  themes were "a test that only round-trips proves nothing", "budgets must measure the
  bytes actually written", and "enforce boundaries with a parser, not a regex".

Next broken hop: stage 2 has no code. `src/core` contains only `domain.ts` and the
components `BotDirectory`, `EventHub`, `ConversationService`, `RuntimePort` and
`BotRegistry` do not exist, so rows 9-22 (directory, hub, service) cannot start. The
agent runtime, transports and client remain unimplemented.

## 2026-10-26 — stage 2 halfway, plan recorded

Observed: rows 1-10 are signed off; rows 11-16 are implemented with 143 tests passing
but are waiting on a review round. The daemon still cannot start: there is no
`ConversationService`, no transport and no entrypoint.

Verified: `npm run check` in `apps/bots` (fixtures 26 files, 143 tests, typecheck, lint,
coverage above thresholds). The catalog, fake runtime and hub are the only core modules.

Next broken hop: `send` has no owner. `src/core/ConversationService.ts` does not exist,
so rows 17-22 cannot start, and nothing wires the protocol codec to a socket. The full
state and order of work now lives in [PLAN.md](PLAN.md).

## 2026-10-26 07:20 — stage 2 hub signed off

Observed: ladder rows 11-16 are implemented, tested and signed off after six review
rounds. The hub now numbers a delta when its batch is broadcast, splits a batch
between whole changes against the 96 KiB soft limit, keeps a per-bot serial fanout
with no sink reentrancy, downgrades a slow subscriber to snapshot-only with a
recovery anchor it never serves stale, and measures encoded bytes through an injected
transport measure. The fake runtime keeps only committed entries in its history,
orders finalization like the window, tracks the streaming pointer and walks a
toolcall path from the block root.

Verified (all run just now in `apps/bots`):

- `npm run check`: `fixtures:check` (26 files), 167 tests, `tsc --noEmit`, Biome and
  coverage 95.88 % lines, 91.19 % branches, 96.77 % functions.
- Codex reviewed each batch read-only and answered `VERDICT: SIGN OFF` on fc7fddc
  after 11 in-memory reproductions and 8 mutations that the suite catches.

Next broken hop: `send` and the connection still have no owner. `ConversationService`
does not exist, so rows 17-22 cannot start and nothing turns a domain event into a
frame.

## 2026-10-26 14:05 — stage 2 complete

Observed: ladder rows 9-22 are implemented, tested and signed off. The catalog is
atomic and resumable, the hub owns revisions, coalescing and per-bot serial fanout,
the fake runtime satisfies the port, and `ConversationService` turns a connection into
a subscription: a current baseline rendered before it goes live, a silent duplicate
send, broadcasts for settlements, paging that leaves the window alone, and a resync
whose only reply is the snapshot it publishes.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check` (26 files), 199 tests, `tsc --noEmit`,
  Biome, coverage 96.49 % lines, 91.60 % branches, 97.40 % functions.
- Codex signed off rows 17-18 on 80315bd and rows 19-22 on cf33bee after 13 in-memory
  reproductions and 6 mutations; six review rounds closed rows 11-16 on fc7fddc.
- Mutation spot checks in this session: a fat batch split, the first-frame guard, the
  post-drain re-check, both rank seedings, the snapshot normalization, the normalized
  broadcast, the resync trace, the resync window and a thin settlement record each
  fail the suite when removed.

Next broken hop: nothing turns a runtime event into a frame and nothing listens on a
socket. `src/runtime/pi/` (stage 3) has no adapter, so there is no real Harness, no
`mapEvents`, and the daemon cannot start; stage 4's server and `main.ts` are next.

## 2026-10-26 — stage 4 closed out: transport, budgets, observability, journeys, crash

Observed: the daemon is a usable local service, not a half-wired server. It binds a
loopback port, refuses a wrong token before the upgrade, caps connections and
subscribers, serves the catalog as measured frames, streams a bot over a socket,
records every crossing in the declared log catalogue with one identity per failure,
and survives a `SIGKILL` mid-answer: the restart keeps the interrupted attempt as
`aborted`, answers once and duplicates nothing.

Verified (all run just now in `apps/bots`):

- `npm run check`: `fixtures:check` (26 files), 310 tests, `tsc --noEmit`, Biome and
  coverage 93.00 % lines, 89.47 % branches, 90.87 % functions.
- `npm run test:crash`: 3/3 — the mid-answer `SIGKILL` (a stub provider that streams
  one chunk, writes a sentinel and never returns), the delete killed after its
  rename, and the lock taken over after a `SIGKILL`.
- `npm run perf`: open 3 ms (bound 250), reopen 400 entries 1 ms (150), one answered
  turn 3 ms (200), 20 bots open 10 ms (1000), on arm64 / Node 26.12.0.
- The review round it is heading into is recorded in [PLAN.md](PLAN.md); no stage-4
  row is signed off yet.

Next broken hop: there is no client. `apps/bots-macos/` does not exist, so a person
cannot open a bot, type at it or see a transcript — that is stage 5 (rows 55-69).

## 2026-10-26 — stage 4 second review round closed

Observed: an independent review (Codex, `group/auto-gpt-6-astra`, high) returned
`BLOCKING 9` against the first round, with 19 further findings. Every defect is
fixed: the daemon no longer opens a second Harness while one is closing, a delete
waits for a warm-up open, a run-time storage failure turns into `unavailable` and
`recover` re-opens the bot, a snapshot page is bounded by bytes as well as count, a
client that stops reading is downgraded instead of buffered, admission and creation
are serialized against their budgets, the catalog event waits for the handshake,
shutdown spends one shared deadline, every refusal has one originating record, and
the catalog follows the run.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check` (26 files), 329 tests, `tsc --noEmit`,
  Biome, coverage 93.22 % lines / 89.54 % branches / 90.02 % functions.
- `npm run test:crash` exited 0: 5/5, including a second kill before any assistant
  provisional and two daemons starting at once.
- `npm run perf` exited 0: open 3 ms, reopen 400 entries 1 ms, one turn 3 ms, 20 bots
  10 ms; the reopen bound now matches the document (100 ms) and every sample is
  printed.
- The review's own probes reproduced each P1 before the fixes; the new tests assert
  them after.

Next broken hop: stage 4 is awaiting the reviewer's acceptance of this round; the
client (`apps/bots-macos/`, rows 55-69) still does not exist.

## 2026-10-26 — stage 4 third review round closed

Observed: the reviewer's third pass found eight P1s in the neighbourhood of the
round-two fixes — a handle that a subscribe could still hold across a closing or
deleting bot, history byte-paging that skipped messages, a snapshot budget that
ignored the rest of the frame, an unavailable snapshot the production decoder would
reject, reservations that could leak or free too early, replies and catalog events
that bypassed the backpressure bound, a lock server a silent client could hold open,
and concurrent `recover` attaching a second watch. Each is fixed with a test that
fails without the fix.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check` (26 files), 338 tests, `tsc --noEmit`,
  Biome, coverage 95.07 % lines / 90.24 % branches / 90.39 % functions.
- `npm run test:crash` exited 0: 5/5.
- `npm run perf` exited 0 and now asserts the documented load (400 messages) instead
  of only reporting a number.

Next broken hop: waiting on the reviewer's round-four verdict; the client still does
not exist.

## 2026-10-26 — stage 4 fourth review round closed

Observed: the fourth round found five P1s inside the third round's fixes, all of them
one-owner problems: reservations that double-counted or leaked, an escalated watch that
dropped a live Harness so `recover` could open a second owner over one sqlite file, a
view that two concurrent subscribes could build twice (and so exceed the eight-
subscriber cap per hub), and a summary that was only budgeted in its healthy form
although the unavailable variant is longer and could stop a `welcome` from fitting.
All are fixed with tests that fail without the fix, and the P2s are closed too.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check`, 343 tests, `tsc --noEmit`, Biome,
  coverage 94.82 % lines / 89.97 % branches / 90.33 % functions.
- `npm run test:crash` exited 0: 5/5.
- `npm run perf` exited 0: the answered-turn measurement now waits for `done`, and the
  reopen asserts the documented 400-message load.

Next broken hop: the reviewer's round-five verdict; then stage 5 (the client).

## 2026-10-26 — stage 4 fifth review round closed

Observed: the fifth round found three more one-owner and budgeting defects — the
delete's settling window was being replaced by its close's window, a snapshot could
reconcile a reservation whose `submit` had not returned, and an unavailable bot with a
live Harness still admitted work past the 32-entry budget. Also fixed: the catalog
after a recovery, the oversize-versus-backlog order in the writer, validation and
version refusals as origin errors, a recorded refusal for a summary over budget, the
answered-turn measurement, and a real-adapter window test that joins a client while a
provider-blocked over-limit attempt is withdrawn.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check`, 344 tests, `tsc --noEmit`, Biome,
  coverage 94.86 % lines / 89.76 % branches / 90.33 % functions.
- `npm run test:crash` exited 0: 5/5.
- `npm run perf` exited 0 with the settlement waited for.

Next broken hop: the reviewer's round-six verdict; then stage 5 (the client).
