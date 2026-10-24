# Bots — protocol v1

Status: **frozen contract**. The only cross-process contract. The daemon encodes
it, the Swift client decodes it, and both test against `fixtures/bots-protocol/`.
Runtime details live in [RUNTIME.md](RUNTIME.md), layers in
[ARCHITECTURE.md](ARCHITECTURE.md), logs in
[OBSERVABILITY.md](OBSERVABILITY.md).

`PROTOCOL_VERSION = 1`.

## Versioning policy

- v1 is additive only: new optional fields, new event types, new capability flags.
- A client **must ignore unknown event types and unknown object fields**, but it
  must still consume the envelope's `rev` when present, so unknown events never
  look like a gap. It never closes the connection over them.
- The server rejects unknown command types with `error{kind:"invalid_command"}`
  and keeps the connection open.
- Removing a field, changing a meaning, or changing ordering requires v2 at a new
  path (`/v2/...`). A breaking change is visible in this file's diff.

## Transport

| Item | Value |
| --- | --- |
| Bind | `127.0.0.1`, default port `43117` (`--port`) |
| HTTP base | `http://127.0.0.1:<port>/v1` |
| WebSocket | `ws://127.0.0.1:<port>/v1/socket` |
| Auth | `Authorization: Bearer <token>`, token in `<root>/token` (0600) |
| Auth failure | HTTP `401` before upgrade; no socket is created |
| Origin | Not checked: no browser client in phase 1. A browser client would require an origin check and a CSRF decision first |
| Frames | Text only, one JSON object per frame, no batching envelope |
| Compression | None |

## Limits

| Limit | Value | Violation |
| --- | --- | --- |
| `send.text` | 8 000 characters | `error{invalid_command}` |
| `bot.title` (HTTP) | 80 characters | HTTP `400` |
| Any single frame | 256 KiB | Close `1008` |
| `snapshot.messages` page | ≤ 200 messages and ≤ 192 KiB | Older messages are paged |
| `history` reply | ≤ 200 messages and ≤ 192 KiB | `hasMore` says whether more exist |
| Connections | 16 | HTTP `503` before upgrade |
| Subscribers per bot | 8 | `error{limit_exceeded}` |
| `requestId` | 8–64 chars, `[A-Za-z0-9_-]` | `error{invalid_command}` |
| `trace` | 8–64 chars, `[A-Za-z0-9_-]` | `error{invalid_command}` |
| Pending events per connection | 256 frames or 1 MiB | Snapshot-only mode (`core.hub.degrade`) |
| Delta coalescing | 50 ms | — |
| Client `ping` interval | 15 s | Server closes `4000` after 60 s without frames |

## One bot per connection

A connection subscribes exactly once and lives as long as that bot's chat. There
is no `unsubscribe`: switching bots closes the socket and opens a new one. This
removes an entire class of leak (late frames from the previous bot) instead of
marshalling it with generation counters.

## HTTP endpoints

All require the bearer token.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | — | `{ "version", "protocolVersion", "instance", "pid", "bots" }` |
| `GET` | `/v1/bots` | — | `{ "bots": [BotSummary] }` |
| `POST` | `/v1/bots` | `{ "title" }` | `201 { "bot": BotSummary }` |
| `PATCH` | `/v1/bots/:id` | `{ "title" }` | `{ "bot": BotSummary }` |
| `DELETE` | `/v1/bots/:id` | — | `204` |

`instance` is a random id chosen at daemon start; a client that sees it change
knows the daemon restarted and reconnects. Errors use
`{ "error": { "kind": ErrorKind, "message": string } }` with `400`, `401`, `404`,
`409` (bot quarantined or being deleted), `503` (shutting down).

The model is chosen by the daemon's configuration at creation time, not by the
client: a model picker needs the `agent` capability.

## Entities

```jsonc
// BotSummary
{
  "id": "b_0190a1b0-…",                 // UUIDv7 with a "b_" prefix
  "title": "研究员",
  "createdAt": "2026-10-25T02:11:03.412Z",
  "updatedAt": "2026-10-25T02:11:03.412Z",
  "model": { "provider": "magpie", "modelId": "auto/gpt-6-luna" },
  "state": "idle",                       // catalogued|opening|idle|running|unavailable|quarantined
  "unavailable": { "reason": "storage_failed", "message": "…" }   // only when unavailable
}

// Message
{
  "id": "e_10",                          // entry id, or a provisional "p_a2" while streaming
  "role": "assistant",                   // user|assistant|notice  (tool|system reserved)
  "state": "complete",                   // streaming|complete|aborted|error
  "createdAt": "2026-10-25T02:11:04.001Z",
  "blocks": [ { "type": "text", "text": "巴黎。" } ],
  "requestId": "r_0190a1b3"              // user messages only; ties the entry to a send
}

// ContentBlock
{ "type": "text",     "text": "…" }
{ "type": "thinking", "text": "…" }                                   // reserved, not rendered
{ "type": "toolCall", "callId": "…", "name": "…", "args": {} }         // reserved
{ "type": "toolResult", "callId": "…", "text": "…", "isError": false } // reserved

// InboxItem
{ "id": "s_3", "mode": "followUp" }     // followUp|steer|queue; text is never echoed before placement
```

`notice` is daemon-authored text for the user ("the run was aborted", "this bot is
unavailable"). It is never sent to the model.

## Handshake

```
client → { "type": "hello", "protocolVersion": 1, "client": "BotsApp/0.1.0" }
server → { "type": "welcome", "protocolVersion": 1,
           "server": { "version": "0.1.0", "instance": "i_7f3", "pid": 4711 },
           "capabilities": { "agent": false, "tools": false, "tasks": false,
                             "entries": false, "usage": false, "peers": false },
           "bots": [ BotSummary, … ] }
```

`hello` must be the first frame; anything else closes `1008`. A version the server
does not serve gets a final frame and then close `4009`:

```
server → { "type": "error", "kind": "version_mismatch", "message": "…",
           "server": { "protocolVersion": 1 } }
```

`welcome.bots` equals `GET /v1/bots`, so the sidebar needs no second request.

## Subscription

```
client → { "type": "subscribe", "botId": "b_…", "trace": "tr_…" }
server → { "type": "snapshot", "rev": 42, "trace": "tr_…", "value": ConversationSnapshot }
```

- `subscribe` twice on one connection closes `1008`.
- Unknown `botId` closes `4004`; a quarantined bot closes `4090` (see close codes).
- The first `snapshot` is always sent — after connect, after reconnect, after an
  idle close. There is no replay protocol.

```jsonc
// ConversationSnapshot
{
  "botId": "b_…",
  "agent": { "model": {…}, "thinkingLevel": "off", "instructions": "" },  // reserved
  "messages": [ Message, … ],            // newest page, oldest first
  "truncatedBefore": "e_3",              // present when older messages exist
  "streaming": { "messageId": "p_a2" },  // present while a run is active
  "pending": [                           // admitted, not yet settled
    { "requestId": "r_…", "submissionId": "s_3", "status": "queued" }
  ],
  "inbox": [ InboxItem, … ],
  "running": true,
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },   // reserved
  "unavailable": { "reason": "storage_failed", "message": "…" }          // only when unavailable
}
```

Snapshot semantics:

- A snapshot is **complete for the window it describes**. When `streaming` is
  present, the streaming message is already inside `messages` with its current
  content and `state:"streaming"`, so a client that joins mid-answer needs no
  earlier frames.
- A snapshot **replaces** client state and resets the revision baseline; it can
  arrive at any time (initial subscribe, `resync`, or a hub rerender when the
  runtime's watch fell behind).
- `truncatedBefore` means older messages exist and are loadable with `history`.
  Its presence is not an error and does not block the composer.
- When `unavailable` is present, `messages` may be empty and `agent`/`usage` are
  omitted: those values are **unknown**, not empty. `pending` and `inbox` are also
  unknown. The client shows the reason and offers `recover`.

## Server events

Bot-scoped events are **broadcast to every subscriber of that bot** and carry one
shared `rev`, strictly increasing per bot. Connection-scoped replies (a duplicate
`send` reply, a pre-subscription command error) carry **no `rev`**; a missing `rev`
is never a gap.

```jsonc
{ "type": "append", "rev": 43, "trace": "tr_…", "message": Message,
  "replaces": "p_a2" }                     // optional: provisional id this message finalizes

{ "type": "delta", "rev": 44, "trace": "tr_…", "messageId": "p_a2",
  "changes": [
    { "kind": "text",     "append": "Par" },
    { "kind": "thinking", "append": "…" },                        // reserved
    { "kind": "block",    "index": 0, "block": { "type": "text", "text": "Paris" } },
    { "kind": "message",  "message": { … } },                     // whole-message replacement
    { "kind": "toolcall", "callId": "…", "path": ["args","q"], "append": "…" }  // reserved
  ] }

{ "type": "status", "rev": 45, "running": true, "inbox": [ InboxItem, … ] }

{ "type": "submission", "rev": 46, "trace": "tr_…",
  "requestId": "r_…", "submissionId": "s_3",
  "status": "done",                        // queued|placed|done|unanswered
  "entryId": "e_7",                        // the user entry, once placed
  "answerEntryId": "e_10",                 // the assistant entry, once done
  "reason": "aborted",                     // only unanswered
  "detail": null }                         // only unanswered; never content

{ "type": "error", "rev": 47, "trace": "tr_…",
  "kind": "task_parked",                   // ErrorKind
  "message": "…",                          // redacted, ≤ 200 chars
  "taskId": "t_3" }                        // reserved

{ "type": "bots", "bots": [ BotSummary, … ] }   // absolute catalog state, no rev
{ "type": "pong" }
```

`append` is an upsert by `message.id`. It is used twice per answer: a provisional
message (`id: "p_a<n>"`, `state:"streaming"`, real content) before its deltas, and
the final entry (`id: "e_<n>"`, `replaces: "p_a<n>"`). A client that never saw the
provisional — because it joined later — already has the content from the snapshot.

`submission` semantics (why three states exist):

| `status` | Meaning | `entryId` / `answerEntryId` |
| --- | --- | --- |
| `queued` | Admitted durably, not placed yet (bot busy or opening) | none |
| `placed` | A user entry exists; the run may not have answered | `entryId` |
| `done` | Answered | both |
| `unanswered` | Admitted, will never be answered | `entryId` only if it was placed |

`reason` on `unanswered` is a short code, not prose: `model_error`, `aborted`
(user abort or shutdown), `run_failed` (a previous run failed and the queue was
withdrawn), `stale` (compaction placed past it), `withdrawn`. The client maps
codes to localised text; unknown codes render generically.

## Client commands

Every command except `hello` and `ping` carries `trace`.

```jsonc
{ "type": "hello",     "protocolVersion": 1, "client": "…" }
{ "type": "subscribe", "botId": "b_…", "trace": "tr_…" }
{ "type": "send",      "requestId": "r_…", "text": "…", "whenBusy": "followUp", "trace": "tr_…" }
{ "type": "abort",     "trace": "tr_…" }
{ "type": "recover",   "trace": "tr_…" }
{ "type": "resync",    "trace": "tr_…" }
{ "type": "history",   "before": "e_12", "limit": 100, "trace": "tr_…" }
{ "type": "ping" }
```

- `send` requires a subscription. The daemon replies with a `submission` frame for
  that `requestId` **before** any run starts, so a client that loses the reply and
  reconnects can reconcile from `snapshot.pending`, and a repeated `send` with the
  same `requestId` returns the existing record instead of duplicating work.
- `whenBusy` defaults to `followUp`. `steer` places after the current tool round
  (phase 2). `reject` yields `error{kind:"invalid_command"}` when busy.
- `abort` withdraws the running input and any queued inputs. Their settlements
  arrive as `unanswered{reason:"aborted"}`.
- `recover` is the phase-1 escape hatch for a bot that reports `task_parked` or
  `unavailable`: it aborts the run, retries parked tasks, and answers with a fresh
  snapshot. It is idempotent and safe on a healthy bot.
- `history` returns older messages for scrollback:
  `{ "type": "history", "trace": "…", "messages": [Message…], "hasMore": bool }`.
  `messages` are older than `before`, oldest first, contiguous with what the client
  holds. Pages are read-only: deltas only ever touch the newest window.

## Invariants

| # | Invariant |
| --- | --- |
| I1 | Bot-scoped events broadcast to every subscriber of that bot with one strictly increasing `rev`; `snapshot.rev` is the last applied event |
| I2 | A client that sees `rev != last + 1` discards events until the next `snapshot`, sends `resync`, and gives up (reconnects) after two failed resyncs |
| I3 | A snapshot replaces state atomically and resets the baseline; it may arrive mid-answer and is always complete for its window |
| I4 | A message is rendered optimistically only with a `requestId`; it is replaced when the matching `submission`/`append` arrives, and a repeated `send` with the same `requestId` never duplicates |
| I5 | `unanswered` is not a transport failure: the message was admitted and the run will not answer. `reason` distinguishes model failure, abort, and withdrawal |
| I6 | A command that was never admitted produces `error`, never a `submission`. "Admitted but reply lost" is recovered by re-sending the same `requestId` or by reading `snapshot.pending` |
| I7 | `bots` events are absolute and idempotent; they carry no `rev` |
| I8 | Unknown server event types are consumed (`rev` included) and ignored; unknown client commands are rejected without closing |
| I9 | Wire content appears only in `send.text`, `Message.blocks`, `delta.changes[].append`, and `agent.instructions` |
| I10 | `append` upserts by id; a provisional `p_a<n>` is finalized by an entry carrying `replaces` |
| I11 | `rev` is absent on connection-scoped replies and `bots`/`pong`; absence is not a gap |
| I12 | Older windows are fetched with `history`; the newest window is never re-fetched by paging |

## Close codes

| Code | Meaning | Client behavior |
| --- | --- | --- |
| `1000` | Normal close (client asked, or the app is closing) | Reconnect only on user action |
| `1006` | Abnormal close: daemon crashed or was killed | Reconnect with backoff immediately |
| `1008` | Protocol violation (bad JSON, oversize, double subscribe, missing hello) | Show an error, do not auto-reconnect |
| `1011` | Internal daemon error | Reconnect with backoff, show a notice |
| `4000` | Idle timeout (no frames for 60 s) | Reconnect immediately |
| `4001` | Auth failed after connect | Stop; ask for the token |
| `4004` | Unknown bot | Refresh the catalog, do not reconnect to that id |
| `4009` | Protocol version mismatch | Stop; show both versions |
| `4010` | Daemon shutting down | Reconnect with backoff; expect the port to refuse briefly |
| `4090` | Bot is quarantined (close timed out) | Show the state, offer `recover` later; retry the connection |

Handshake failures that happen before the upgrade use HTTP status codes: `401`
auth, `503` at the connection limit or while shutting down.

## Error kinds

`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`

Shared verbatim with `err.kind` in the daemon log and the client's
`ConversationEvent.error` ([OBSERVABILITY.md](OBSERVABILITY.md)).

## Fixtures

`fixtures/bots-protocol/` holds one frame per file, pretty-printed, used by both
sides.

| File | Direction |
| --- | --- |
| `hello.client.json`, `welcome.server.json`, `version-mismatch.server.json` | handshake |
| `subscribe.client.json` | subscription |
| `snapshot.server.json`, `snapshot.streaming.server.json`, `snapshot.unavailable.server.json` | attach states |
| `append.server.json`, `append.streaming.server.json`, `append.finalize.server.json`, `delta.server.json` | transcript |
| `history.client.json`, `history.server.json` | paging |
| `status.server.json`, `submission.server.json`, `submission.connection.server.json` | run state and the connection-scoped duplicate reply |
| `bots.server.json`, `error.server.json` | catalog and failures |
| `send.client.json`, `abort.client.json`, `recover.client.json`, `resync.client.json` | commands |
| `ping.client.json`, `pong.server.json` | liveness |
| `entities.json` | `BotSummary`, `Message`, `InboxItem` samples |

Rules enforced by `test/protocol/fixtures.test.ts`:

1. Fixtures are normative: the daemon encoder reproduces them from the same
   values, and the Swift decoder decodes them.
2. A protocol change and the affected fixtures land in the same commit as this
   document, and the file set must match this table exactly.
3. No real user data, tokens or paths.
