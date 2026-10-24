# Bots — observability contract

Status: **phase 1 contract**. Logging is a layer-crossing concern with its own
tests, not something added while debugging. Structure is in
[ARCHITECTURE.md](ARCHITECTURE.md); this file says what every layer emits so a
user-visible failure is attributable to exactly one layer from logs alone.

## Why this exists

The requirement is diagnostic, not archival: when the app stops answering, one
lookup must say whether the frame never arrived, the bot was never resolved, the
runtime never acknowledged, or pi-durable failed.

Three rules make that possible, and each is tested:

1. every layer names itself in every record;
2. every crossing carries one `trace`, created once and never regenerated;
3. exactly one layer — the originating one — logs the failure at `error`; layers
   above record a propagated outcome at `warn` and do not repeat the message.

## Layer names

| `layer` | Code | Emits |
| --- | --- | --- |
| `transport` | `src/server` | Connections, auth, frame I/O, close codes |
| `protocol` | `src/protocol` | Encode/decode, version, limits, command validation |
| `core` | `src/core` | Catalog, lifecycle, hub ordering, paging, command routing |
| `runtime` | `src/runtime/pi` | Adapter calls, event mapping, failure classification |
| `pi` | third-party callbacks | `onReport`, `harness.closed`, watch end |

Client-side layers use the same vocabulary: `client.ui`, `client.vm`,
`client.transport` (`os.Logger`, subsystem `ai.hexly.bots`).

## Trace ownership

| Originator | Trace shape | Example |
| --- | --- | --- |
| Client command (`send`, `abort`, `recover`, `resync`, `history`, `ping`) | created by the client: `tr_<uuidv7>` | `tr_0190a1…` |
| Connection episode | created by the daemon on accept: `tr_conn_<n>` | `tr_conn_7` |
| Startup recovery and idle close | created by the daemon: `tr_boot_<n>` | `tr_boot_3` |
| Run progress caused by an admitted input | the trace **stored with that submission** at `send` time | the original `send` trace |

Rules:

1. The client puts `trace` in the command frame ([PROTOCOL.md](PROTOCOL.md)); the
   daemon echoes it on every event it causes.
2. A daemon-originated event (progress of a run whose `send` is long finished, a
   recovery scan) uses the stored submission trace or a `tr_boot_*`/`tr_conn_*`
   id. A run started by several queued inputs uses the first input's trace.
3. Downstream calls inherit the trace; a layer never mints a new one. The only
   exception is the connection trace, which is used until a command arrives.
4. Client logs use the same `trace` string, so Console.app and the daemon JSONL
   join on one value. The app's "Copy diagnostics" surfaces it.
5. `ping`/`pong` are liveness only and carry no trace; their records use the
   connection trace. Phase 1 installs no pi telemetry, so a trace cannot be carried
   into pi-durable or recovered from its storage: a run resumed after a restart is
   attributed to a fresh `tr_boot_<n>`.

## Event names

`<layer>.<subject>.<outcome>`, outcome ∈ `start | ok | fail | drop | degrade |
skip | reject | end | classify`. Names are constants in `src/log/events.ts`; a test
asserts that every constant is used and every used constant is declared. There is
no free-form event name.

| layer | events |
| --- | --- |
| transport | `transport.conn.open.ok`, `transport.conn.open.fail`, `transport.conn.open.reject`, `transport.conn.close.ok`, `transport.conn.close.end`, `transport.auth.fail`, `transport.frame.recv.ok`, `transport.frame.recv.fail`, `transport.frame.send.ok`, `transport.frame.send.drop` |
| protocol | `protocol.decode.fail`, `protocol.encode.fail`, `protocol.limit.fail`, `protocol.version.fail`, `protocol.command.start`, `protocol.command.ok`, `protocol.command.fail` |
| core | `core.catalog.load.ok`, `core.catalog.load.fail`, `core.catalog.write.ok`, `core.catalog.write.fail`, `core.bot.resolve.fail`, `core.bot.open.start`, `core.bot.open.ok`, `core.bot.open.fail`, `core.bot.close.ok`, `core.bot.close.fail`, `core.bot.close.degrade` (quarantine), `core.subscribe.start`, `core.subscribe.ok`, `core.subscribe.fail`, `core.submit.start`, `core.submit.ok`, `core.submit.fail`, `core.history.start`, `core.history.ok`, `core.history.fail`, `core.hub.publish.ok`, `core.hub.coalesce`, `core.hub.snapshot.ok`, `core.hub.degrade`, `core.singleton.start`, `core.recovery.start`, `core.recovery.bot.ok`, `core.recovery.bot.fail`, `core.recovery.ok`, `core.delete.start`, `core.delete.ok`, `core.delete.fail`, `core.reconcile.ok` |
| runtime | `runtime.open.start`, `runtime.open.ok`, `runtime.open.fail`, `runtime.subscribe.start`, `runtime.subscribe.ok`, `runtime.subscribe.fail`, `runtime.submit.start`, `runtime.submit.ok`, `runtime.submit.fail`, `runtime.abort.start`, `runtime.abort.ok`, `runtime.abort.fail`, `runtime.recover.start`, `runtime.recover.ok`, `runtime.recover.fail`, `runtime.close.start`, `runtime.close.ok`, `runtime.close.fail`, `runtime.watch.end.ok`, `runtime.failure.classify` |
| pi | `pi.report`, `pi.session.closed` |

`*.start` pairs with exactly one `*.ok|fail` per layer reached. A layer that is
not reached emits nothing for that trace — that absence is evidence.

## Record shape

One JSON object per line: `<root>/logs/daemon-YYYYMMDD.jsonl`, rotated at 10 MB,
five files kept.

```json
{"ts":"2026-10-25T02:11:03.412Z","level":"info","layer":"core","evt":"core.submit.ok",
 "trace":"tr_0190a1b2","botId":"b_0190a1b0","connId":"c_7","reqId":"r_0190a1b3",
 "rev":44,"durMs":3,"detail":{"queued":false,"count":1}}
```

| Field | Presence | Meaning |
| --- | --- | --- |
| `ts` | always | ISO-8601 UTC, milliseconds |
| `level` | always | `debug` / `info` / `warn` / `error` |
| `layer` | always | See above |
| `evt` | always | One declared name |
| `trace` | always | Per the ownership table |
| `botId` | when a bot is involved | Bot id |
| `connId` | transport and everything below one connection | Connection id |
| `reqId` | commands carrying a `requestId` | Client request id |
| `rev` | hub publishes | Assigned revision |
| `durMs` | `*.ok` / `*.fail` with a paired start | Layer's own work |
| `err` | `*.fail`, `*.degrade`, `*.reject`, `runtime.failure.classify` | `{ "kind": ErrorKind, "failure": "f_…" }`, plus `origin: true` only on the originating record |
| `detail` | optional | Whitelisted ids, counts, enums, byte lengths |

`ErrorKind` is the closed union shared with the protocol:
`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`.

## Failure recording: origin versus propagation

```
runtime.submit.fail   level=error  err={kind:"storage_failed", failure:"f_7", origin:true}
core.submit.fail      level=warn   err={kind:"storage_failed", failure:"f_7"}  detail.propagated=true
protocol.command.fail level=warn   err={kind:"storage_failed", failure:"f_7"}  detail.propagated=true
```

- The failure identity `err.failure` is minted exactly once, at the layer that
  first detects the failure. It is the dedupe unit: **exactly one `level=error`
  record per `failure` id**, on the layer where it originated.
- Layers above log `warn` with the same `err.kind` and `err.failure`, plus
  `detail.propagated=true`, never the message text and never `error`.
- A trace is long-lived (a connection serves many commands); a failure is not, so
  deduping on `failure` rather than on `trace` is what makes "one error" exact.
- Retryable trouble that the layer handles internally (one watch reattach) logs
  `runtime.watch.end.ok` at `warn` and mints no failure id. Three within 60 s mint
  one `internal` failure.

## Redaction

Two different rules, previously conflated:

| Context | Rule |
| --- | --- |
| Wire (protocol frames) | Content is allowed inside these structural carriers only: `send.text`; any `Message` object (`blocks`, and the message inside a `delta` `message` change); `delta.changes[].append`; `delta.changes[].block`; `agent.instructions` (only when the `agent` capability is on). No other field carries text |
| Logs | Never message text, prompts, instructions, tokens, submission `detail`, or provider error strings. Paths under the user's home are shortened to `~` |

Specifics:

- Provider and upstream error text is **not logged verbatim**; it may echo user
  content. The adapter maps it to `err.kind` plus `detail.providerCode` (a short
  token when upstream supplies one) and a fixed `safeMessage`. A test injects a
  provider error that echoes the prompt and asserts the prompt never appears in
  the log.
- The daemon token, `BOTS_API_KEY`, and any `sk-`-shaped value are scrubbed from
  every field including `err` and `detail`.
- `detail` keys are whitelisted per event; an undeclared key fails the shape test.

## Levels

| Level | Contents |
| --- | --- |
| `trace` | Frame-level encode/decode; off by default (`--log-level=trace`). Records at this level use the same schema and only `protocol.*`/`transport.frame.*` names |
| `error` | Originating failures only (`err.origin: true`) |
| `warn` | Propagated failures, `core.hub.degrade`, `core.bot.quarantine`, drops |
| `info` (default) | Crossings: connection, subscribe, submit, publish counters, recovery, delete |
| `debug` | Coalescing details, snapshot rerenders, paging, per-command byte sizes |
Coalesced deltas log `detail.count`, never contents. Recipes below state the
level they require; `--log-level=debug` is the support default when collecting
evidence.

## Diagnosis recipes

Each recipe injects exactly one fault, waits on an explicit barrier, and asserts
presence *and* absence. The tests use a fake clock and a drain barrier
(`await hub.drain()` / `await log.flush()`) rather than sleeps, so a missing
event is a fact, not a race.

**R1 — a bot cannot be opened.**
Inject: the fake storage handed to core throws on open. Core owns the open step,
so the origin is core.

```
transport.frame.recv.ok    trace=tr_A evt=subscribe
protocol.command.ok        trace=tr_A
core.subscribe.start       trace=tr_A botId=b1
core.bot.open.start        trace=tr_A botId=b1
core.bot.open.fail         trace=tr_A err={kind:"storage_failed", failure:"f_7", origin:true}
core.subscribe.fail        trace=tr_A err={kind:"storage_failed", failure:"f_7"} propagated
protocol.command.fail      trace=tr_A err={kind:"storage_failed", failure:"f_7"} propagated
```
Asserted: no `runtime.open.*` for `tr_A` (the adapter was never reached), exactly
one `level=error`, on `core`, with `failure:"f_7"`; the bot is `unavailable`.

**R2 — the event stream dies mid-answer.**
Inject: the adapter's own sink callback throws once (a defect inside the runtime
layer), then reattach succeeds.

```
core.hub.publish.ok        trace=tr_B rev=42 detail.kind=append
runtime.watch.end.ok       trace=tr_B level=warn detail.reason=listener_error
runtime.subscribe.ok       trace=tr_B detail.reattach=true
core.hub.snapshot.ok       trace=tr_B rev=43
```
Asserted: exactly one `runtime.watch.end.ok`, a reattach, a snapshot rerender, no
`level=error` (handled internally), and no `transport.*` event for `tr_B` after the
first frame. A variant that fails three times in 60 s asserts one `internal`
failure with `origin:true` on `runtime`.

**R3 — the client sends something malformed.**
Inject: one frame with an unknown command type.

```
transport.frame.recv.ok    trace=tr_C
protocol.decode.fail       trace=tr_C err={kind:"invalid_command", origin:true}
protocol.command.fail      trace=tr_C propagated
```
Asserted: no `core.*` and no `runtime.*` for `tr_C`. Attribution: client/protocol.

**R4 — delete interrupted between the two steps.**
Inject: kill the process after `rename` and before the catalog write.

```
core.delete.start          trace=tr_D botId=b1
core.delete.fail           trace=tr_D err={kind:"internal", origin:true}
# after restart
core.reconcile.ok          trace=tr_boot_1 botId=b1 detail.finished="delete"
```
Asserted: the catalog no longer lists `b1` after restart and `trash/b1` exists.

## Client logging

`BotsTransport` and `BotsFeatures` log through `os.Logger` with
`subsystem = "ai.hexly.bots"`, `category` equal to the layer name, and the same
field names. Each crossing logs `start` and one outcome; per-delta logging is
forbidden (a test asserts no emit inside the delta path).

## Tests that keep this honest

| Test | Asserts |
| --- | --- |
| `test/log/shape.test.ts` | Required fields; `err.kind` from the union; `detail` whitelist; declared-and-used event names |
| `test/log/origin.test.ts` | Exactly one `level=error` per `err.failure`, at the originating layer; higher layers log `warn` with `propagated` |
| `test/log/trace.test.ts` | R1–R4 with fake clock and drain barrier, at `--log-level=debug`, asserting presence *and* absence |
| `test/log/redaction.test.ts` | Sentinel prompt, token and home path never appear; provider error echo is scrubbed |
| `BotsFeaturesTests/LoggingTests.swift` | Client emit sites use the shared vocabulary; no per-delta emit |
