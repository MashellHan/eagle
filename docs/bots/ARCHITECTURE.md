# Bots — architecture

Status: **phase 1 contract**. Implementation must match this document; changes
here land in the same commit as the code they describe. Product scope lives in
[PRODUCT.md](PRODUCT.md), the wire format in [PROTOCOL.md](PROTOCOL.md), the
runtime mapping in [RUNTIME.md](RUNTIME.md), logging in
[OBSERVABILITY.md](OBSERVABILITY.md), tests in [TESTING.md](TESTING.md).

## Isolation

Bots is a separate project that happens to live in this repository.

| Aspect | Rule |
| --- | --- |
| Code | `apps/bots/**` (daemon) and the `Bots*` Swift targets. Never imports `apps/web`, `packages/agent`, `packages/contracts` |
| Build | Own `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`. Not a member of the root npm workspace |
| Gates | Own `npm run check`. Root `npm run check` and CI do not run Bots |
| CI | Not configured in phase 1. Local gates are the contract |
| Sharing | Only `apps/macos/Sources/EagleDesign` (tokens and view components, zero dependencies, zero feature state) |
| Docs | `docs/bots/**`; the root `AGENTS.md` carries a short rules section only |

`apps/bots` must stay out of the root `biome.json` include list, and the root
`package.json` must not gain a `test:bots` script. If a Bots rule ever needs to
live elsewhere, it belongs in `docs/bots/**` and the root `AGENTS.md` section.

## Layers

Five layers. A layer may call only the layer directly below it, and every
crossing is logged with the same `trace` (see
[OBSERVABILITY.md](OBSERVABILITY.md)).

```
L4  client UI            BotsApp / BotsFeatures / BotsCore / BotsTransport (Swift)
                          │  ConversationPort, BotCatalogPort
                          ▼
L3  wire contract        apps/bots/src/protocol/**  +  src/server/**
                          │  ServerEvent / ClientCommand (PROTOCOL.md v1)
                          ▼
L2  core                 apps/bots/src/core/**
                          │  RuntimeEvent / RuntimePort
                          ▼
L1  runtime adapter      apps/bots/src/runtime/pi/**
                          │  pi-durable API
                          ▼
L0  pi-durable           @earendil-works/pi-durable 1.4.0 (vendored dependency)
```

| Layer | Owns | Must not know | Tests |
| --- | --- | --- | --- |
| L4 UI | SwiftUI views, view models, reducer, drafts | The wire encoding, pi-durable, sqlite | `BotsCoreTests`, `BotsFeaturesTests` |
| L3 wire | Frames, versions, limits, auth, close codes | Bots semantics, pi-durable | `test/protocol`, `test/server` |
| L2 core | Bots as a product: catalog, lifecycle, ordering, fanout, command routing | `@earendil-works/*`, WebSocket, files' wire format | `test/core` |
| L1 adapter | Translation between pi-durable behaviour and `RuntimeEvent`; failure classification | Bots catalog, transport, `rev` numbering | `test/runtime` |
| L0 | Durability, model calls, compaction | Anything about Bots | Upstream |

Two guard tests enforce the two rules that erode silently:
`test/architecture.test.ts` (no `@earendil-works/*` import outside
`src/runtime/**`; nothing in `src/runtime/**` is imported by `src/core/**` or
`src/protocol/**`) and `BotsCoreTests/DependencyRulesTests.swift` (no
`URLSession` / `URLRequest` / `WebSocket` / `URLProtocol` in `BotsCore`,
`BotsFeatures` or `EagleDesign`).

## Module inventory

### Daemon (`apps/bots`)

```
src/
  main.ts                     argument parsing, root paths, lock, servers, shutdown
  config.ts                   defaults and path derivation (single source)
  log/
    log.ts                    emit(level, layer, evt, fields), rotation, redaction
    layers.ts                 the Layer union and per-layer event name constants
    capture.ts                test helper: capture logs in memory
  protocol/
    version.ts                PROTOCOL_VERSION = 1
    limits.ts                 text/event/queue bounds
    entities.ts               Message, BotSummary, ConversationSnapshot
    events.ts                 ServerEvent encode/decode + validation
    commands.ts               ClientCommand encode/decode + validation
  core/
    RuntimePort.ts            interfaces a runtime must satisfy
    BotDirectory.ts           catalog.json CRUD, atomic write
    BotRegistry.ts            lazy open, idle close, recovery scan, delete-to-trash, lock
    EventHub.ts               per-bot fanout, rev assignment, coalescing, slow-client fallback
    ConversationService.ts    subscribe/send/abort/resync → RuntimePort, submission mapping
  runtime/pi/
    mapEvents.ts              pi AgentEvent → RuntimeEvent (pure, golden-tested)
    PiDurableRuntime.ts       Harness ownership, watchEvents attach, submit, abort, close
  server/
    http.ts                   catalog endpoints
    ws.ts                     /v1/socket, handshake, subscribe, command dispatch
    auth.ts                   bearer comparison, 0600 token file
  testing/
    FakeRuntime.ts            scripted RuntimePort for core tests
    fixtureServer.ts          ephemeral daemon on a random port for transport e2e
test/
  protocol/  core/  runtime/  server/  e2e/  log/  perf/  architecture.test.ts
```

### Client (`apps/macos`)

```
Sources/
  BotsCore/
    Model/          Bot, Message, ContentBlock, Submission, Usage, AgentConfig
    Event/          ServerEvent, ClientCommand, decode tables
    Logic/          ConversationReducer (pure), TranscriptBuilder, BusyMode, RevisionGap
    Ports/          ConversationPort, BotCatalogPort, Clock
  BotsTransport/
    WebSocketConversationClient.swift   AsyncStream<ServerEvent>, backoff, trace ids
    HTTPBotCatalog.swift
    TokenStore.swift                    Keychain
  BotsFeatures/
    AppViewModel.swift                  selection, lifecycle, window visibility
    BotCatalogViewModel.swift           list/create/rename/delete
    ConversationViewModel.swift         subscribe, reduce, resync
    ComposerViewModel.swift             draft, optimistic send, requestId persistence
    BotSettingsViewModel.swift          reserved (capability-gated, not rendered)
  BotsApp/
    main.swift                          composition root only
Tests/
  BotsCoreTests/  BotsFeaturesTests/  BotsTransportTests/
```

The Swift `BotsCore` mirrors the wire entity names deliberately: one name per
concept across the two languages, so a log line, a fixture and a Swift type use
the same word.

## Ports

Two interfaces carry the replaceability requirement from
[PRODUCT.md](PRODUCT.md#owner-decisions-fixed). Everything else is concrete.

```ts
// apps/bots/src/core/RuntimePort.ts
export type RuntimeEvent =
  | { type: "append"; message: Message }
  | { type: "delta"; messageId: string; changes: DeltaChange[] }
  | { type: "status"; running: boolean; inbox: InboxItem[] }
  | { type: "submission"; requestId: string; submissionId: string; status: SubmissionStatus;
      entryId?: string; reason?: string; detail?: string }
  | { type: "error"; kind: ErrorKind; message: string; taskId?: string };

export interface RuntimePort {
  open(bot: BotRecord): Promise<RuntimeHandle>;
}

export interface RuntimeHandle {
  /** Committed view at attach time; the hub turns this into the first snapshot. */
  snapshot(): Promise<ConversationSnapshot>;
  /** Subscribe to subsequent commits. Returns detach. Called once per open handle. */
  attach(sink: (event: RuntimeEvent) => void): Promise<() => void>;
  submit(input: { requestId: string; text: string; whenBusy: BusyMode }): Promise<{ submissionId: string }>;
  abort(): Promise<void>;
  close(): Promise<void>;
  /** Reserved: agent capabilities arrive through this; unused in phase 1. */
  configure?(patch: AgentPatch): Promise<void>;
}
```

```swift
// apps/macos/Sources/BotsCore/Ports/ConversationPort.swift
public protocol ConversationPort: AnyObject {
  func subscribe(botId: String) -> AsyncStream<ConversationEvent>
  func send(requestId: String, text: String, whenBusy: BusyMode) async throws
  func abort() async throws
  func resync() async throws
  func close()
}

public protocol BotCatalogPort: AnyObject {
  func list() async throws -> [BotSummary]
  func create(title: String) async throws -> BotSummary
  func rename(id: String, title: String) async throws -> BotSummary
  func delete(id: String) async throws
}
```

`rev` numbering is deliberately **not** part of `RuntimePort`: it is a transport
concern owned by `EventHub`. Swapping the runtime therefore cannot change ordering
semantics, and swapping the transport cannot change pi semantics.

## Process model

One daemon process owns every bot in one root directory (default
`~/.local/share/eagle-bots`, overridable with `--root`).

```
botd (single process, launchd-supervised, single-writer lock)
├─ <root>/token                    0600 bearer token, generated on first start
├─ <root>/daemon.lock              O_EXCL; a second instance exits non-zero
├─ <root>/catalog.json             bot list, atomic write (tmp + rename)
├─ <root>/logs/daemon-YYYYMMDD.jsonl
├─ <root>/trash/<botId>-<ts>/      deleted bots, never auto-removed
└─ <root>/bots/<botId>/
     ├─ bot.json                   { id, title, createdAt, model, thinkingLevel, instructions, cwd }
     ├─ session.sqlite             pi-durable storage, 0700
     └─ (pi-durable writes its own tables; nothing else touches this file)
```

### Bot lifecycle

```
catalogued ──open──▶ opening ──ok──▶ idle ⇄ running
    ▲                    │             │        │
    │                    └─fail─▶ unavailable ◀─┘
    └──────────────── deleted ◀── closing ◀──┘
```

- **catalogued**: present in `catalog.json`, no Harness, no memory cost.
- **opening**: a single in-flight `Harness.open` promise; concurrent callers share
  it. Failure marks the bot `unavailable` with a retryable reason.
- **idle**: Harness open, `watchEvents` attached, no run.
- **running**: a run is active. `EventHub` streams deltas.
- **unavailable**: open failed (`session_failed`, corrupt storage, missing file).
  The catalog entry stays; the client shows a retry.
- **closing**: last subscriber left and `idleCloseMs` elapsed, or daemon shutdown,
  or delete. `Harness.close()` is bounded by 5 s.
- **deleted**: directory moved to `trash/`, removed from `catalog.json`.

Rules:

1. `create` never opens a Harness. It writes the directory and the catalog entry,
   replies, then warms the bot asynchronously. This is what keeps creation under
   50 ms ([PRODUCT.md](PRODUCT.md#speed-targets)).
2. Opening is idempotent and serialized per bot; two concurrent subscribes never
   produce two Harnesses for one sqlite file.
3. A bot is closed only when it has no subscribers, no active run and no pending
   submission. Phase 1 has no background tasks, so "no active run" is sufficient;
   when tools arrive, this condition must also consider live tasks.
4. Delete closes the Harness first (bounded), then moves the directory, then
   updates the catalog. A failure between steps leaves the bot present and
   retryable; nothing is silently destroyed.
5. Recovery scan at startup opens every catalogued bot, calls `resume()`, keeps
   active ones open and schedules the rest for idle close. A bot whose open fails
   is reported and skipped; the scan never aborts the daemon.
6. Shutdown stops accepting work, closes all Harnesses within 5 s total, then
   exits. Bots that miss the deadline are logged and left to crash recovery.

### Concurrency

| Concern | Rule |
| --- | --- |
| One bot, many runs | Impossible by construction: pi queues a second input in `inbox` |
| Many bots | Fully parallel; each has its own Harness and storage |
| Subscriptions | Many per bot (`EventHub` fans out); one bot per WS connection in phase 1 |
| Shared mutable state | Only the catalog and the log. Everything else is per bot |
| Ordering | `EventHub` assigns `rev` on a single async queue per bot |

## Failure containment

Failures must not cross bots, and must be attributable to a layer.

| Failure | Layer | Containment |
| --- | --- | --- |
| Auth/token mismatch | L3 transport | Connection rejected, no bot opened |
| Malformed command | L3 protocol | Command rejected, connection kept |
| Unknown bot id | L2 core | `4004`, no runtime call |
| Model/provider error | L0 → L1 | Submission settles `unanswered{reason,detail}`; bot stays usable |
| Tool/extension error | L0 → L1 | Error result in the message; reserved for phase 2 |
| Storage error (`SessionFailed`) | L0 | Harness closes itself; L1 classifies, L2 marks `unavailable`, client offers retry |
| Crash of the whole process | — | Next start resumes interrupted runs; no message is lost |
| Client disconnects | L4 | Daemon keeps working; reconnect starts from a snapshot |

Anything a layer cannot classify is rethrown unchanged, so the log shows the
innermost layer that failed rather than a generic wrapper at the top.

## Dependency and version policy

- `@earendil-works/pi-durable` is pinned exactly (`1.4.0`), never a range. It is
  experimental and its API changes without notice.
- Upgrading requires: bump the pin, run `mapEvents` golden tests, read the
  changed sections of upstream `docs/spec.md` (§2.1 context derivation, §5.6
  wakeups, §9.4 agent events), and record differences in
  [RUNTIME.md](RUNTIME.md). One commit.
- Node ≥ 24 for the daemon (pi-durable requires ≥ 22.19; the daemon uses Node's
  built-in TypeScript stripping). Measured on Node 26.12.0.
- Runtime TypeScript uses erasable syntax only: `type`, `interface`, `satisfies`.
  No `enum`, no `namespace`, no parameter properties, no decorators, because the
  code runs through Node's type stripper, not `tsc`.
- `tsc --noEmit` is a type gate only; there is no build step and no `dist/`.
