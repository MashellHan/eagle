# Bots — observability contract

Status: **phase 1 contract**. Logging is a layer-crossing concern with its own
tests, not something added while debugging. Structure is in
[ARCHITECTURE.md](ARCHITECTURE.md); this file says what every layer must emit, so
that a user-visible failure can be attributed to exactly one layer by reading
logs alone.

## Why this exists

The requirement is diagnostic, not archival: when the app stops answering, one
lookup must say whether the frame never arrived, the bot was never resolved, the
runtime never acknowledged, or pi-durable failed. That only works if

1. every layer names itself,
2. every crossing carries one trace id, and
3. the innermost failure is the only one that logs an error.

Corollary rule: **higher layers do not re-log lower-layer failures**; they record
a classified outcome (`err.kind`) and stop. Double logging is what makes traces
ambiguous.

## Layer names

| `layer` | Code | Emits |
| --- | --- | --- |
| `transport` | `src/server` | Connections, auth, frame I/O, close codes |
| `protocol` | `src/protocol` | Encode/decode, version, limits, command validation |
| `core` | `src/core` | Catalog, lifecycle, hub ordering, command routing, submission mapping |
| `runtime` | `src/runtime/pi` | Adapter calls, pi-durable event mapping, failure classification |
| `pi` | third-party callbacks | `onReport` payloads, uncaught task/extension reports |

Client-side layers, same vocabulary:

| `layer` | Code |
| --- | --- |
| `client.ui` | `BotsApp` views |
| `client.vm` | `BotsFeatures` view models |
| `client.transport` | `BotsTransport` |

## Event names

`<layer>.<subject>.<outcome>` with `outcome ∈ {start, ok, fail, drop, degrade}`.
Names are constants in `src/log/layers.ts`; typos are compile errors, and tests
enumerate the catalog below.

| layer | events |
| --- | --- |
| transport | `transport.conn.open`, `transport.conn.close`, `transport.auth.fail`, `transport.frame.recv`, `transport.frame.send`, `transport.send.drop`, `transport.conn.reject` |
| protocol | `protocol.decode.fail`, `protocol.encode.fail`, `protocol.limit.fail`, `protocol.version.fail`, `protocol.command.start`, `protocol.command.ok` |
| core | `core.catalog.load`, `core.catalog.write`, `core.bot.resolve.fail`, `core.bot.open.start`, `core.bot.open.ok`, `core.bot.open.fail`, `core.bot.close`, `core.bot.unavailable`, `core.subscribe.ok`, `core.unsubscribe`, `core.conversation.submit.start`, `core.conversation.submit.ok`, `core.conversation.submit.fail`, `core.hub.publish`, `core.hub.coalesce`, `core.hub.degrade`, `core.recovery.start`, `core.recovery.bot`, `core.recovery.ok` |
| runtime | `runtime.open.start`, `runtime.open.ok`, `runtime.snapshot.ok`, `runtime.attach.ok`, `runtime.submit.ok`, `runtime.submit.fail`, `runtime.abort.ok`, `runtime.watchEvents.fail`, `runtime.close.ok`, `runtime.classify` |
| pi | `pi.report` (always carries `kind`), `pi.session.closed` |

## Record shape

One JSON object per line. Written to
`<root>/logs/daemon-YYYYMMDD.jsonl`, rotated at 10 MB, five files kept.

```json
{"ts":"2026-10-25T02:11:03.412Z","level":"info","layer":"core","evt":"core.conversation.submit.ok",
 "trace":"tr_01J9Z0K3","botId":"b_01J9Z0K2","connId":"c_7","reqId":"r_01J9Z0K4",
 "rev":44,"durMs":3,"detail":{"queued":false,"count":1}}
```

| Field | Presence | Meaning |
| --- | --- | --- |
| `ts` | always | ISO-8601 UTC, millisecond precision |
| `level` | always | `debug` / `info` / `warn` / `error` |
| `layer` | always | See table above |
| `evt` | always | One of the catalog names |
| `trace` | every layer crossing | One id per inbound command or connection episode |
| `botId` | when a bot is involved | Bot id |
| `connId` | transport and downstream of one connection | Connection id |
| `reqId` | commands carrying a `requestId` | Client-generated request id |
| `rev` | hub publishes | Assigned revision |
| `durMs` | on `*.ok` / `*.fail` pairs | Elapsed time of the layer's own work |
| `err` | on `*.fail` | `{ "kind": ErrorKind, "msg": string }`, `msg` ≤ 200 chars, redacted |
| `detail` | optional | Whitelisted numbers/enums/ids only |

`ErrorKind` is a closed union shared with the protocol:
`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`.

## Trace rules

1. A new `trace` is created at the first transport touch: connection open, or a
   frame that starts a command. It is never regenerated downstream.
2. Every call crossing downward carries the same `trace`; every response crossing
   upward keeps it too.
3. One command produces exactly one `*.start` and one `*.ok|fail` per layer it
   reaches. A layer it does not reach produces no event for that `trace`.
4. Client commands carry `trace` as a protocol field (`ClientCommand.trace`), so a
   daemon log line and an app log line share the id. The app's "Copy diagnostics"
   action surfaces the id.
5. Server→client events echo the `trace` of the command that caused them, when
   there is one. Events without a cause (spontaneous run progress) carry the
   trace of the originating `send` through the hub, stored per submission.

## Redaction

Never logged: message text, prompts, agent instructions, tokens, full paths under
the user's home (replaced with `~`), submission `detail` payloads, terminal
content. Logged instead: `count`, `bytes`, `len`, `kind`, ids.

Enforcement: `src/log/log.ts` runs every `detail` and `err.msg` through a
redactor that (a) removes the daemon token, (b) shortens any home-directory
prefix, (c) replaces `text`/`content`/`instructions` keys with `len`. A test
submits a message containing a sentinel string and asserts the string never
appears in the captured log.

## Levels

| Level | What is logged |
| --- | --- |
| `error` | `*.fail` outcomes, `pi.report` |
| `warn` | `core.hub.degrade`, `core.bot.unavailable`, drops |
| `info` (default) | Layer crossings: open/close, subscribe, submit, recovery |
| `debug` | Coalescing, per-publish counters |
| `trace` | Frame-level encode/decode. Off by default; `--log-level=trace` |

Coalesced deltas log `detail.count`, never deltas themselves.

## Diagnosis recipes

These three scripts are the acceptance criterion for this document. Each has a
test in `apps/bots/test/log/trace.test.ts`; the test asserts the presence and
absence of specific events, not the text of the logs.

**R1 — App says "sending…" forever, no answer appears.**

```
transport.frame.recv      trace=tr_A  evt=send
protocol.command.ok       trace=tr_A  evt=send
core.conversation.submit.start trace=tr_A botId=b1
core.bot.open.start       trace=tr_A botId=b1
```
No `core.bot.open.ok` and no `runtime.open.*` within the expected window: the bot
never opened. Stop here, look at `core.bot.open.fail`. Layer: **core → L0 open
stall**.

**R2 — Answer starts streaming, then freezes.**

```
core.subscribe.ok         trace=tr_B botId=b1
core.hub.publish          trace=tr_B rev=44 detail.count=1
core.hub.degrade          trace=tr_B reason=queue_overflow
runtime.watchEvents.fail  trace=tr_B err.kind=internal
```
The freeze is in **runtime** watching, not in transport: publish stopped because
the watch died. Without `runtime.watchEvents.fail`, the fault would be above the
hub (client) since publishes continue.

**R3 — Message is rejected with "invalid command".**

```
transport.frame.recv      trace=tr_C
protocol.decode.fail      trace=tr_C err.kind=invalid_command
```
Nothing below `protocol`: no `core.*` for `tr_C`. That absence is the proof that
the client sent something malformed rather than the daemon mis-handling it.

## Client logging

`BotsTransport` and `BotsFeatures` log through `os.Logger` with
`subsystem = "ai.hexly.bots"`, `category` equal to the layer name, and the same
field names (`evt`, `trace`, `botId`, `rev`, `err.kind`). Console.app filters on
the category, so a support session reads both sides with the same vocabulary.

The client logs exactly three things per layer crossing — `start`, outcome, and
one readiness flag (`client.transport.ready`) — and nothing per delta.

## Tests that keep this honest

| Test | Asserts |
| --- | --- |
| `test/log/shape.test.ts` | Every emit has `ts/level/layer/evt`; `*.fail` has `err.kind` from the union; `detail` has no forbidden keys |
| `test/log/trace.test.ts` | R1–R3 above: expected events present, wrong-layer events absent, one `trace` per command |
| `test/log/redaction.test.ts` | Sentinel message text, token, and home path never appear |
| `test/log/catalog.test.ts` | Every `evt` used in `src/**` exists in the catalog and vice versa |
| `BotsFeaturesTests/LoggingTests.swift` | Client emit sites use the shared vocabulary; no per-delta logging |
