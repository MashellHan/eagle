# Bots — protocol v1

Status: **frozen contract**. This is the only cross-process contract. The daemon
encodes it, the Swift client decodes it, and both sides test against the same
files in `fixtures/bots-protocol/`. Runtime details behind it are in
[RUNTIME.md](RUNTIME.md); layer names in
[OBSERVABILITY.md](OBSERVABILITY.md).

`PROTOCOL_VERSION = 1`.

## Versioning policy

- v1 is additive only. New optional fields, new server event types and new
  capability flags may appear in a v1 minor change.
- A client **must ignore unknown server event types and unknown object fields**,
  logging at debug level. It must never close the connection over them.
- The server **rejects unknown client command types** with an `error` event
  (`kind: "invalid_command"`), keeping the connection open.
- Removing a field, changing a field's meaning, or changing ordering semantics
  requires v2 and a new endpoint path (`/v2/...`). Any breaking change must be
  visible in this file's diff.

## Transport

| Item | Value |
| --- | --- |
| Bind | `127.0.0.1`, default port `43117`, overridable with `--port` |
| HTTP base | `http://127.0.0.1:<port>/v1` |
| WebSocket | `ws://127.0.0.1:<port>/v1/socket` |
| Auth | `Authorization: Bearer <token>`, token in `<root>/token` (mode 0600) |
| Auth failure | HTTP `401` before upgrade; WS is never established |
| Origin | Not checked: phase 1 has no browser client. A browser client would require an `Origin` check and a CSRF decision first |
| Compression | None |
| Binary frames | Not used. Text frames only |

Frames are one JSON object per WebSocket text message. No batching envelope:
one message per frame. Events that belong to the same commit may arrive as
separate frames and must be applied in order.

## Limits

| Limit | Value | Violation |
| --- | --- | --- |
| `send.text` length | 8 000 characters | `error{invalid_command}` |
| `bot.title` length | 80 characters | HTTP `400` |
| Any single frame | 256 KiB | Close `1008` |
| Connections | 16 | Reject `503` before upgrade |
| Subscribers per bot | 8 | `error{limit_exceeded}` |
| `requestId` | 8–64 chars, `[A-Za-z0-9_-]` | `error{invalid_command}` |
| Pending events per connection | 256 frames or 1 MiB | Downgrade to snapshot-only (`core.hub.degrade`) |
| Delta coalescing | 50 ms | — |
| Idle command timeout | none (heartbeats keep it alive) | — |

## HTTP endpoints

Every endpoint requires the bearer token.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | — | `{ "version", "protocolVersion", "pid", "bots" }` |
| `GET` | `/v1/bots` | — | `{ "bots": [BotSummary] }` |
| `POST` | `/v1/bots` | `{ "title": string }` | `201 { "bot": BotSummary }` |
| `PATCH` | `/v1/bots/:id` | `{ "title": string }` | `{ "bot": BotSummary }` |
| `DELETE` | `/v1/bots/:id` | — | `204` |

Errors use `{ "error": { "kind": ErrorKind, "message": string } }` with
`400` invalid input, `401` auth, `404` unknown bot, `503` shutting down.

The model for a new bot is not chosen by the client. It comes from the daemon's
own configuration (default model) and is recorded in the bot's `bot.json` at
creation. A model picker requires the `agent` capability, which phase 1 disables.

## Entities

```jsonc
// BotSummary
{
  "id": "b_01J9Z0K2Q3R4S5T6V7W8X9Y0Z",   // UUIDv7 with a "b_" prefix
  "title": "研究员",
  "createdAt": "2026-10-25T02:11:03.412Z",
  "updatedAt": "2026-10-25T02:11:03.412Z",
  "model": { "provider": "magpie", "modelId": "group/auto-gpt-6-luna" },
  "state": "catalogued",                   // see state table below
  "unavailable": { "reason": "session_failed", "message": "…" }  // only when state is unavailable
}

// Message
{
  "id": "e_17",                  // entry id, opaque string
  "role": "assistant",           // user | assistant | notice   (tool | system reserved)
  "state": "complete",           // streaming | complete | aborted | error
  "createdAt": "2026-10-25T02:11:04.001Z",
  "blocks": [ { "type": "text", "text": "Paris." } ]
}

// ContentBlock
{ "type": "text",     "text": "…" }
{ "type": "thinking", "text": "…" }                                  // reserved: not rendered in phase 1
{ "type": "toolCall", "callId": "…", "name": "…", "args": {} }        // reserved
{ "type": "toolResult", "callId": "…", "text": "…", "isError": false }// reserved

// InboxItem
{ "id": "s_3", "mode": "followUp" }   // followUp | steer | queue
```

`Message.role` is `user`, `assistant` or `notice` in phase 1. `tool` and `system`
exist in the vocabulary so a later phase can surface tool results and prompts
without reshaping messages.

`notice` is a client-renderable informational message produced by the daemon
(for example "the run was aborted", "this bot is unavailable"). It is never sent
to the model.

## Bot state

| `state` | Meaning | Composer |
| --- | --- | --- |
| `catalogued` | In the catalog, no Harness open | Enabled (sending opens it) |
| `opening` | `Harness.open` in flight | Enabled (input queues behind open) |
| `idle` | Open, no run | Enabled |
| `running` | A run is active | Enabled (`followUp` queues) |
| `unavailable` | Open failed; carries `unavailable` | Disabled, offers retry |
| `closing` | Idle-evicting or shutting down | Disabled |

## Handshake

```
client → { "type": "hello", "protocolVersion": 1, "client": "BotsApp/0.1.0" }
server → { "type": "welcome", "protocolVersion": 1,
           "server": { "version": "0.1.0", "pid": 4711 },
           "capabilities": { "agent": false, "tools": false, "tasks": false,
                             "entries": false, "usage": false, "peers": false },
           "bots": [ BotSummary, … ] }
```

Order rules: `hello` must be the first frame; anything else closes `1008`. A
`protocolVersion` the server does not serve closes `4009`. `welcome.bots` is the
same list `GET /v1/bots` returns, so a client can build its sidebar without a
second request.

## Subscription

One bot per connection.

```
client → { "type": "subscribe", "botId": "b_…" }
server → { "type": "snapshot", "rev": 42, "trace": "tr_…", "value": ConversationSnapshot }
client → { "type": "unsubscribe" }
```

- `subscribe` while already subscribed closes `1008`.
- Unknown `botId` closes `4004`.
- Every connection starts with no subscription; the app's bot switch is
  `unsubscribe` then `subscribe` (or a fresh connection).
- The first `snapshot` is always sent, including after reconnect or after an idle
  eviction. There is no replay protocol: a client that needs state asks for a
  snapshot.

```jsonc
// ConversationSnapshot
{
  "botId": "b_…",
  "agent": { "model": { "provider": "magpie", "modelId": "…" },
             "thinkingLevel": "off", "instructions": "" },   // reserved: not rendered
  "messages": [ Message, … ],            // committed transcript, oldest first
  "streaming": { "messageId": "e_17" },  // null when no run is active
  "inbox": [ InboxItem, … ],             // committed but not yet placed
  "running": true,
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },  // reserved
  "unavailable": { "reason": "session_failed", "message": "…" }        // only when unavailable
}
```

## Server events

Every bot-scoped event carries `rev`, which strictly increases per bot starting
from the `rev` of the `snapshot` that established the client's baseline.

```jsonc
{ "type": "append", "rev": 43, "trace": "tr_…", "message": Message }

{ "type": "delta", "rev": 44, "trace": "tr_…", "messageId": "e_17",
  "changes": [
    { "kind": "text",     "append": "Par" },
    { "kind": "thinking", "append": "…" },              // reserved
    { "kind": "block",    "index": 0 },                  // a block is (re)declared in full next
    { "kind": "toolcall", "callId": "…", "path": ["arguments","q"], "append": "…" }  // reserved
  ] }

{ "type": "status", "rev": 45, "running": true, "inbox": [ InboxItem, … ] }

{ "type": "submission", "rev": 46, "trace": "tr_…",
  "requestId": "r_…", "submissionId": "s_3",
  "status": "queued",            // queued | placed | done | unanswered
  "entryId": "e_17",             // present for placed and done
  "reason": "model_error",       // only unanswered
  "detail": "provider exploded"  // only unanswered, redacted, ≤ 500 chars
}

{ "type": "error", "rev": 47, "trace": "tr_…",
  "kind": "session_failed",      // ErrorKind
  "message": "…",                // redacted, ≤ 200 chars
  "taskId": "t_3" }              // reserved, present for task-scoped failures

{ "type": "bots", "bots": [ BotSummary, … ] }   // absolute catalog state, not revisioned

{ "type": "pong" }
```

`bots` events are absolute: a client replaces its sidebar state. They carry no
`rev` because the catalog is not part of any bot's sequence.

## Client commands

```jsonc
{ "type": "hello",       "protocolVersion": 1, "client": "…" }
{ "type": "subscribe",   "botId": "b_…" }
{ "type": "unsubscribe" }
{ "type": "send",        "requestId": "r_…", "text": "…", "whenBusy": "followUp" }  // followUp | steer | reject
{ "type": "abort" }
{ "type": "resync" }
{ "type": "ping" }
```

`send` requires a subscription; without one the server replies
`error{kind: "invalid_command"}`.

`whenBusy` default is `followUp`: the input is queued and placed when the current
run answers. `steer` places it after the current tool round (phase 2). `reject`
returns `error{kind: "invalid_command"}` when the bot is busy — used by future
"one-shot" callers, not by the phase-1 composer.

## Invariants

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | `rev` strictly increases per bot; `snapshot.rev` is the last applied event | `test/core/hub.test.ts` |
| I2 | A client that sees `rev != last + 1` must call `resync` and drop in-flight deltas | `BotsCoreTests/ReducerTests.swift`, `test/core/hub.test.ts` |
| I3 | A user message is only rendered after the daemon admitted it; an optimistic bubble is replaced by matching `submission.requestId` then `append` | `test/core/service.test.ts`, `BotsFeaturesTests/ComposerTests.swift` |
| I4 | Retrying a `send` with the same `requestId` never duplicates the message | `test/runtime/idempotency.test.ts` |
| I5 | `unanswered` is not a transport failure: the message was admitted, the model failed | `test/core/service.test.ts` |
| I6 | `bots` events are absolute and idempotent | `test/server/catalog.test.ts` |
| I7 | No message body, prompt or token appears in any frame field other than `send.text` and `Message.blocks` | `test/protocol/redaction.test.ts` |
| I8 | Unknown server event types are ignored; unknown client commands are rejected without closing | `test/protocol/versioning.test.ts` |

## Close codes

| Code | Meaning | Client behavior |
| --- | --- | --- |
| `1000` | Normal close | Do not reconnect unless the user acts |
| `1008` | Protocol violation (bad JSON, oversize, double subscribe, missing hello) | Surface an error, do not auto-reconnect |
| `1011` | Internal daemon error | Reconnect with backoff, show a notice |
| `4001` | Auth failed | Stop reconnecting, ask for a token |
| `4004` | Unknown bot | Remove the bot from the sidebar, ask the daemon for the catalog |
| `4009` | Protocol version mismatch | Stop, show versions of both sides |

## Error kinds

`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`

The same union is used in the daemon log (`err.kind`) and by the client, so one
vocabulary spans layers ([OBSERVABILITY.md](OBSERVABILITY.md)).

## Fixtures

`fixtures/bots-protocol/` holds one file per frame, pretty-printed, exercised by
both sides:

| File | Direction |
| --- | --- |
| `hello.client.json`, `welcome.server.json` | handshake |
| `subscribe.client.json`, `unsubscribe.client.json` | subscription |
| `snapshot.server.json`, `append.server.json`, `delta.server.json` | transcript |
| `status.server.json`, `submission.server.json`, `error.server.json` | run state |
| `bots.server.json` | catalog |
| `send.client.json`, `abort.client.json`, `resync.client.json` | commands |
| `ping.client.json`, `pong.server.json` | liveness |
| `entities.json` | `BotSummary` + `Message` + `InboxItem` samples |

Rules for the fixtures, enforced by `test/protocol/fixtures.test.ts`:

1. They are the normative samples: the daemon encoder must produce them from the
   same values, and the Swift decoder must decode them.
2. Adding a field to the protocol means adding it to the affected fixture in the
   same commit as this document.
3. Fixtures never contain real user data, tokens or paths.
