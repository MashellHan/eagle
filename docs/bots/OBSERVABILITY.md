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

## Event names

`<layer>.<subject>.<outcome>`, outcome ∈ `start | ok | fail | drop | degrade |
skip`. Names are constants in `src/log/events.ts`; a test asserts that every
constant is used and every used constant is declared.

| layer | events |
| --- | --- |
| transport | `transport.conn.open.ok`, `transport.conn.open.fail`, `transport.conn.close`, `transport.auth.fail`, `transport.frame.recv.ok`, `transport.frame.recv.fail`, `transport.frame.send.ok`, `transport.frame.send.drop`, `transport.conn.reject` |
| protocol | `protocol.decode.fail`, `protocol.encode.fail`, `protocol.limit.fail`, `protocol.version.fail`, `protocol.command.start`, `protocol.command.ok`, `protocol.command.fail` |
| core | `core.catalog.load.ok`, `core.catalog.load.fail`, `core.catalog.write.ok`, `core.catalog.write.fail`, `core.bot.resolve.fail`, `core.bot.open.start`, `core.bot.open.ok`, `core.bot.open.fail`, `core.bot.close.ok`, `core.bot.close.fail`, `core.bot.quarantine`, `core.bot.unavailable`, `core.subscribe.ok`, `core.subscribe.fail`, `core.submit.start`, `core.submit.ok`, `core.submit.fail`, `core.history.ok`, `core.history.fail`, `core.hub.publish.ok`, `core.hub.coalesce`, `core.hub.snapshot.ok`, `core.hub.degrade`, `core.recovery.start`, `core.recovery.bot.ok`, `core.recovery.bot.fail`, `core.recovery.ok`, `core.delete.start`, `core.delete.ok`, `core.delete.fail`, `core.reconcile.ok` |
| runtime | `runtime.open.start`, `runtime.open.ok`, `runtime.open.fail`, `runtime.subscribe.ok`, `runtime.subscribe.fail`, `runtime.submit.ok`, `runtime.submit.fail`, `runtime.abort.ok`, `runtime.abort.fail`, `runtime.recover.ok`, `runtime.recover.fail`, `runtime.close.ok`, `runtime.close.fail`, `runtime.watch.end`, `runtime.classify` |
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
| `err` | `*.fail`, `*.degrade`, `runtime.classify` | `{ "kind": ErrorKind }`, plus `origin: true` only on the originating record |
| `detail` | optional | Whitelisted ids, counts, enums, byte lengths |

`ErrorKind` is the closed union shared with the protocol:
`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`.

## Failure recording: origin versus propagation

```
runtime.submit.fail   level=error  err={kind:"session_failed", origin:true}
core.submit.fail      level=warn   err={kind:"session_failed"}          detail.propagated=true
protocol.command.fail level=warn   err={kind:"session_failed"}          detail.propagated=true
```

- The originating layer logs `error`, sets `err.origin`, and may include a
  redacted `detail.safeMessage` from a fixed catalogue.
- Every layer above logs `warn` with the same `err.kind` and
  `detail.propagated=true`, never the message text, never `error`.
- A test asserts exactly one `error` per failed trace, and that its `layer` is the
  innermost layer that reached the failure.
- A failure the layer can retry internally (one watch reattach) is logged
  `runtime.watch.end` at `warn` and is not an error; three within 60 s escalate.

## Redaction

Two different rules, previously conflated:

| Context | Rule |
| --- | --- |
| Wire (protocol frames) | Content is allowed and expected in exactly these carriers: `send.text`, `Message.blocks`, `delta.changes[].append`, `agent.instructions` (only when the `agent` capability is on). Nowhere else |
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
| `error` | Originating failures only (`err.origin: true`) |
| `warn` | Propagated failures, `core.hub.degrade`, `core.bot.quarantine`, drops |
| `info` (default) | Crossings: connection, subscribe, submit, publish counters, recovery, delete |
| `debug` | Coalescing details, snapshot rerenders, paging, per-command byte sizes |
| `trace` | Frame-level encode/decode, off by default (`--log-level=trace`) |

Coalesced deltas log `detail.count`, never contents. Recipes below state the
level they require; `--log-level=debug` is the support default when collecting
evidence.

## Diagnosis recipes

Each recipe injects exactly one fault, waits on an explicit barrier, and asserts
presence *and* absence. The tests use a fake clock and a drain barrier
(`await hub.drain()` / `await log.flush()`) rather than sleeps, so a missing
event is a fact, not a race.

**R1 — submit never reaches the runtime.**
Inject: `RuntimePort.open` rejects once.

```
transport.frame.recv.ok    trace=tr_A evt=send
protocol.command.ok        trace=tr_A
core.submit.start          trace=tr_A botId=b1
core.bot.open.start        trace=tr_A botId=b1
core.bot.open.fail         trace=tr_A err={kind:"storage_failed", origin:true}
core.submit.fail           trace=tr_A err={kind:"storage_failed"} propagated
```
Asserted: `runtime.open.ok` absent, exactly one `level=error`, at `core`. The
attribution is to core's open step, which is what failed.

**R2 — the stream stops mid-answer.**
Inject: the runtime's sink throws once after the first delta, then reattach
succeeds.

```
core.subscribe.ok          trace=tr_B rev=41
core.hub.publish.ok        trace=tr_B rev=42 detail.count=1
runtime.watch.end          trace=tr_B level=warn
runtime.subscribe.ok       trace=tr_B detail.reattach=true
core.hub.snapshot.ok       trace=tr_B rev=43
```
Asserted: exactly one `runtime.watch.end`, a new `runtime.subscribe.ok` for the
same bot, a snapshot rerender, and no `transport.*` event for `tr_B` after the
first frame. Attribution: runtime watch lifetime, not transport.

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
| `test/log/origin.test.ts` | One `level=error` per failed trace, at the innermost layer; higher layers log `warn` with `propagated` |
| `test/log/trace.test.ts` | R1–R4 with fake clock and drain barrier, at `--log-level=debug` |
| `test/log/redaction.test.ts` | Sentinel prompt, token and home path never appear; provider error echo is scrubbed |
| `BotsFeaturesTests/LoggingTests.swift` | Client emit sites use the shared vocabulary; no per-delta emit |
