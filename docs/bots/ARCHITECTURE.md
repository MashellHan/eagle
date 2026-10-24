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
| Daemon | `apps/bots/**`. Own `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`. Not a member of the root npm workspace |
| Client | `apps/bots-macos/**`: a **separate SPM package** with its own executable, tests and gates |
| Shared code | `apps/macos` exposes `EagleDesign` as a library product; `apps/bots-macos` depends on it by path. Adding that product is the only edit to the Eagle package, and it changes no Eagle target |
| Forbidden imports | No Bots file imports `apps/web`, `packages/agent`, `packages/contracts`, or the Eagle `EagleFeatures`/`EagleApp` targets |
| Gates | `apps/bots` and `apps/bots-macos` have their own gates. Root `npm run check`, the Eagle Swift package tests and CI do not run Bots |
| Biome | Root `biome.json` excludes `apps/bots`; the Bots daemon lints itself with its own Biome version |
| Docs | `docs/bots/**`; the root `AGENTS.md` carries a short rules section only |

Because the client is its own package, implementing `Bots*` targets cannot leak
into the Eagle build. The direction of the one shared dependency is fixed:
`EagleDesign` must stay dependency-free and feature-free, so bots code never
reaches it.

## Layers

Five layers. Calls go one way; every crossing logs one `trace` (see
[OBSERVABILITY.md](OBSERVABILITY.md)).

```
L4  client              apps/bots-macos: BotsApp / BotsFeatures / BotsCore / BotsTransport
                          │  CatalogPort, ConversationPort  (domain level, no wire)
                          ▼
L3  wire                apps/bots/src/protocol/**  (maps domain ⇄ frames)
    transport           apps/bots/src/server/**    (auth, socket, dispatch)
                          │  ServerEvent / ClientCommand envelopes (PROTOCOL.md v1)
                          ▼
L2  core                apps/bots/src/core/**
                          │  domain types (domain.ts) + RuntimePort
                          ▼
L1  runtime adapter     apps/bots/src/runtime/pi/**
                          │  pi-durable API
                          ▼
L0  pi-durable          @earendil-works/pi-durable 1.4.0 (pinned dependency)
```

| Layer | Owns | Must not know | Type ownership |
| --- | --- | --- | --- |
| L4 client | Views, view models, reducer, drafts, connection state | Wire encoding, pi-durable, sqlite | `BotsCore/Model`, `BotsCore/Logic`, `BotsCore/Ports` |
| L3 wire | Frames, versions, limits, auth, close codes; mapping domain ⇄ frames | Bots behaviour, pi-durable | Envelope types live in `protocol/`; **domain types are imported from `core/`** |
| L2 core | Domain types, catalog, lifecycle, ordering, fanout, command routing | `@earendil-works/*`, sockets, frame shapes | `core/domain.ts` |
| L1 adapter | pi-durable ⇄ `RuntimeEvent`; failure classification | Catalog, transport, `rev` numbering | `runtime/pi/**` |
| L0 | Durability, model calls, compaction | Anything about Bots | Upstream |

Two depend on the third:

- `protocol/` depends on `core/domain.ts` and maps it to frames. It never defines
  a second copy of `Message`, `ConversationSnapshot` or `Submission`.
- `core/` never imports `protocol/`: a core test constructs domain values and
  never mentions a frame.
- `server/` depends on `protocol/` and `core/`; it owns sockets only.

Guard tests: `test/architecture.test.ts` asserts (a) no `@earendil-works/*`
import outside `src/runtime/**`, (b) `src/core/**` and `src/protocol/**` do not
import each other's internals in the forbidden direction (`core` imports nothing
from `protocol`), (c) `src/runtime/**` imports no `core/` module other than
`core/domain.ts` and `core/RuntimePort.ts`.
`BotsCoreTests/DependencyRulesTests.swift` asserts `BotsCore` and `BotsFeatures`
contain no `URLSession`/`URLRequest`/`WebSocket`/`URLProtocol` and that wire
decoding lives only in `BotsTransport`.

## Module inventory

### Daemon (`apps/bots`)

```
src/
  main.ts                     paths, singleton socket, servers, shutdown
  config.ts                   defaults; the only place env vars are read
  core/
    domain.ts                 Message, ContentBlock, ConversationSnapshot, Submission,
                              BotSummary, BotState, ErrorKind, BusyMode  (wire-independent)
    RuntimePort.ts            RuntimePort, RuntimeHandle, RuntimeEvent, RuntimeBotSpec
    BotDirectory.ts           catalog.json CRUD, atomic write
    BotRegistry.ts            open/close/quarantine, idle close, recovery scan, deadlock-free lock
    EventHub.ts               per-bot rev, fanout, coalescing, snapshot rerender, paging
    ConversationService.ts    command routing, submission ledger, history paging
  protocol/
    version.ts  limits.ts     PROTOCOL_VERSION, frame and page budgets
    events.ts   commands.ts   encode/decode domain ⇄ frames, validation
  runtime/pi/
    mapEvents.ts              pi AgentEvent / reports / watch end → RuntimeEvent
    PiDurableRuntime.ts       Harness ownership, submission ledger, close, recover
    registry.ts               empty extension set in phase 1
  server/
    http.ts ws.ts auth.ts     catalog endpoints, socket, bearer
  log/                        see OBSERVABILITY.md
  testing/                    FakeRuntime, fixture server
test/
  protocol/ core/ runtime/ server/ e2e/ log/ perf/ crash/ architecture.test.ts
```

### Client (`apps/bots-macos`)

```
Package.swift                 depends on ../macos (EagleDesign product only)
Sources/
  BotsCore/
    Model/                    domain types mirroring core/domain.ts names
    Logic/                    ConversationReducer (pure), TranscriptBuilder, RevisionGap
    Ports/                    CatalogPort, ConversationPort, Clock
  BotsTransport/
    CatalogHTTPClient.swift   /v1/bots
    ConversationSocket.swift  frames ⇄ domain, backoff, trace ids, paging
    TokenStore.swift          Keychain
  BotsFeatures/
    AppViewModel.swift        selection, lifecycle, window visibility
    BotCatalogViewModel.swift
    ConversationViewModel.swift
    ComposerViewModel.swift
    BotSettingsViewModel.swift   reserved; not rendered in phase 1
    OutboxStore.swift            persisted unsent commands (see PROTOCOL client duties)
  BotsApp/                    main.swift = composition root only
Tests/
  BotsCoreTests/ BotsFeaturesTests/ BotsTransportTests/
```

`BotsCore` names mirror `core/domain.ts` one-to-one so a log line, a fixture and a
Swift type use the same word. Wire decoding is confined to `BotsTransport`.

## Ports

```ts
// apps/bots/src/core/RuntimePort.ts
// Every event carries the trace that caused it: the submission trace for run
// output, the connection or boot trace otherwise. Failures carry a minted identity
// so one underlying failure reported on several channels collapses to one record.
export type RuntimeEvent = { readonly trace: string } & (
  | { type: "append"; message: Message; replaces?: string }
  | { type: "delta"; messageId: string; changes: DeltaChange[] }
  | { type: "status"; running: boolean; inbox: InboxItem[] }
  | { type: "submission"; record: Submission }
  | { type: "snapshot"; value: ConversationSnapshot }   // watch fell behind: replace everything
  | { type: "error"; failure: { id: string; kind: ErrorKind; origin: Layer }; message: string; taskId?: string }
);

export type DeltaChange =
  | { kind: "text"; index: number; append: string }
  | { kind: "thinking"; index: number; append: string }
  | { kind: "toolcall"; index: number; callId: string; path: readonly (string | number)[]; append: string }
  | { kind: "block"; index: number; block: ContentBlock }   // the whole block
  | { kind: "message"; message: Message };                  // the whole message

export type SubmitInput = {
  readonly requestId: string;
  readonly text: string;
  readonly whenBusy: BusyMode;
  readonly trace: string;
};

export type Submission = {
  readonly id: string;
  readonly requestId: string;
  readonly status: "queued" | "placed" | "done" | "unanswered";
  readonly entryId?: string;        // pi.user entry, once placed
  readonly answerEntryId?: string;  // pi.assistant entry, once done
  readonly reason?: string;         // only unanswered
};

export interface RuntimePort {
  /** Opens, recovers (resume), and returns a handle. Idempotent per bot id. */
  open(spec: RuntimeBotSpec): Promise<RuntimeHandle>;
}

export interface RuntimeBotSpec {
  readonly id: string;
  readonly dir: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly trace: string;
}

export interface RuntimeHandle {
  /** Atomic: returns the committed view at attachment plus a sink for later commits.
   *  No commit is lost between the two, because the runtime acquires the snapshot
   *  and the event stream in one operation (pi `watchEvents`). */
  subscribe(trace: string, sink: (event: RuntimeEvent) => void): Promise<RuntimeSubscription>;
  /** Idempotent by requestId. Returns the submission's current record. */
  submit(input: SubmitInput): Promise<Submission>;
  /** Current record by submission id or requestId; used for duplicate replies. */
  submission(key: { submissionId: string } | { requestId: string }): Promise<Submission | undefined>;
  /** Older messages, oldest first. Byte budgets and paging stay in the wire layer. */
  history(input: { beforeEntryId?: string; limit: number }): Promise<{ messages: Message[]; hasMore: boolean }>;
  abort(trace: string): Promise<void>;
  /** Retries parked work for this bot and leaves a healthy bot untouched.
   *  It never aborts a running answer; `abort` does that. */
  recover(trace: string): Promise<void>;
  /** Live work, so the registry can decide whether closing is safe. */
  busy(): Promise<{ run: boolean; tasks: boolean }>;
  /** Resolves with `closed` or `timeout`. Never silently abandons the handle. */
  close(trace: string, deadlineMs: number): Promise<"closed" | "timeout">;
}

export interface RuntimeSubscription {
  readonly snapshot: ConversationSnapshot;
  detach(): void;
}
```

```swift
// apps/bots-macos/Sources/BotsCore/Ports/ConversationPort.swift
public enum ConnectionState: Equatable {
  case connecting, ready, reconnecting(attempt: Int), failed(reason: String), stopped
}

// `rev` is present on every bot-scoped case and absent on connection-scoped
// replies. BotsTransport owns close codes, envelope decoding and therefore gap
// detection: it drops out-of-order frames and emits `.snapshot` after a resync,
// so the reducer stays pure and never sees a gap.
public struct ConversationEvent {
  public let trace: String              // command trace, or the connection's
  public let rev: Int?                  // nil for connection-scoped replies
  public let body: Body

  public enum Body {
    case connection(ConnectionState)
    case snapshot(ConversationSnapshot)          // initial, resync, or a rerender
    case append(Message, replaces: String?)
    case delta(messageId: String, changes: [DeltaChange])
    case status(running: Bool, inbox: [InboxItem])
    case submission(Submission)
    case history([Message], hasMore: Bool)
    case error(kind: ErrorKind, message: String, failure: String?)
  }
}

public protocol ConversationPort: AnyObject {
  func open(botId: String) -> AsyncStream<ConversationEvent>
  func send(requestId: String, text: String, whenBusy: BusyMode) async throws
  func abort() async throws
  func recover() async throws
  func resync() async throws
  func loadHistory(before messageId: String) async throws
  func close()
}

public protocol CatalogPort: AnyObject {
  func load() async throws -> [BotSummary]
  func create(title: String) async throws -> BotSummary
  func rename(id: String, title: String) async throws -> BotSummary
  func delete(id: String) async throws
  func catalogEvents() -> AsyncStream<[BotSummary]>     // server pushes `bots`
}
```

Notes that the review forced:

- `subscribe` is one atomic operation; a separate `snapshot()` + `attach()` pair
  could drop a commit between them.
- `rev` is not in `RuntimePort`: the hub owns numbering, so a different runtime
  cannot change ordering semantics, and a different transport cannot change pi
  semantics.
- `close` returns an outcome. A timeout leaves the handle owned by the registry
  (see *Quarantine*), never dropped.
- `send` at the port level returns when the daemon has the submission record. The
  Swift `send` returns when the frame is written; durable admission arrives as a
  `.submission` event ([PROTOCOL.md](PROTOCOL.md#invariants)).

## Process model

One daemon process owns every bot under one root directory (default
`~/.local/share/eagle-bots`, `--root` to override).

```
botd (single process, launchd-supervised)
├─ <root>/run/daemon.sock           unix socket: the transport AND the singleton lock
├─ <root>/token                     0600 bearer token, generated on first start
├─ <root>/catalog.json              bot list, atomic write (tmp + rename)
├─ <root>/logs/daemon-YYYYMMDD.jsonl
├─ <root>/trash/<botId>/            deleted bots, deterministic name, never auto-removed
└─ <root>/bots/<botId>/
     ├─ bot.json                    { id, title, createdAt, model, thinkingLevel, instructions }
     ├─ session.sqlite              pi-durable storage, 0700
     └─ …
```

### Singleton lock

A check-then-unlink on a socket path can hand the root to two processes, so the
lock is an `O_EXCL` file with an atomic takeover, and the socket is only a
transport.

```
<root>/run/daemon.lock    { pid, startedAt }   0600, kernel-exclusive creation
<root>/run/daemon.sock    unix socket for the client (not a lock)
```

Renaming a path proves nothing about which inode it held, so takeover is guarded by
a **second `O_EXCL` file** that only one process can own:

```
run/daemon.lock            { pid, startedAt }         ownership
run/daemon.lock.takeover   { pid, startedAt }         single-taker guard for recovery
```

Acquire, bounded at five attempts:

1. `open(lock, "wx")` succeeds → write `{pid, startedAt}`, `fsync`, re-read and
   verify our pid; this process owns the root.
2. `EEXIST` → read the pid. `process.kill(pid, 0)` succeeds → a live daemon owns
   the root; print its pid and exit non-zero.
3. The pid is dead (or the file is unreadable and older than 10 s) → try
   `open(lock + ".takeover", "wx")`:
   - `EEXIST` means another starter is already recovering. Re-check that guard's
     pid; if it is alive, wait 100 ms and retry from step 1. If the guard's pid is
     dead and its file is older than 10 s, remove the guard and retry from step 1.
   - Success → **re-read the lock**: if its pid is now alive, another daemon won
     while we waited; release the guard and exit. Otherwise `unlink(lock)`, release
     the guard, and retry from step 1.
4. Every attempt logs `core.singleton.start` and either `core.singleton.ok` or
   `core.singleton.fail`; exhausting the attempts exits non-zero.

Why this is safe: only the holder of the takeover guard may remove the lock, and it
re-reads the lock after acquiring the guard, so it can never delete a lock written
after its own read. Two concurrent starters therefore produce exactly one owner;
the test forces that interleaving with a barrier between step 2 and step 3 rather
than merely starting two processes.

`SIGKILL` leaves a stale file whose pid is dead, which step 3 takes over. Tests
cover: live instance rejects the second, `SIGKILL`ed instance is taken over, and
two processes racing the same stale lock produce exactly one winner
(`test/crash/singleton.test.ts`).

### Bot lifecycle

```
catalogued ──open──▶ opening ──ok──▶ idle ⇄ running ──idle close──▶ closing ──▶ catalogued
    ▲                    │             │                                   │
    │                    └──fail──▶ unavailable ──recover──▶ opening       │
    │                          ▲                                         │
    └── deleted ◀── trash ◀─────┴──────────── quarantined ◀── close timeout
```

- **catalogued**: in `catalog.json`, no Harness, no memory cost.
- **opening**: one in-flight `Harness.open` promise; concurrent callers share it.
  `open` also performs recovery (`harness.resume()`), so a run interrupted by a
  crash continues without a separate recovery call in the port.
- **idle / running**: Harness open, subscription attached.
- **unavailable**: open failed. The client gets a snapshot with `unavailable` and
  can send `recover`; the state is re-entered on the next open attempt.
- **closing**: idle-evicting, deleting or shutting down.
- **quarantined**: `close()` timed out. The handle stays owned, `open` and
  `delete` are refused for that bot, and a background retry repeats `close`
  every 30 s. The bot leaves quarantine only when `close` resolves `closed`.
- **deleted**: directory moved to `trash/<botId>`, entry removed from the catalog.

Rules:

1. `create` never opens a Harness: write `bot.json` + the catalog entry, reply,
   then warm asynchronously. Creation stays under 50 ms
   ([PRODUCT.md](PRODUCT.md#speed-targets)).
2. Opening is serialized per bot; two subscribers never create two Harnesses for
   one sqlite file.
3. Idle close requires `busy() === {run:false, tasks:false}` and no subscribers.
   Phase 1 disables compaction precisely so `tasks` is always false
   ([RUNTIME.md](RUNTIME.md#settings-per-bot)); the condition already reads it, so
   enabling compaction later does not need a redesign.
4. Delete is two idempotent steps with a deterministic destination:
   `rename(bots/<id>, trash/<id>)`, then update `catalog.json`. Startup
   reconciliation finishes any interrupted delete: a catalog entry with no bot
   directory but a `trash/<id>` is removed from the catalog; a `trash/<id>`
   without a catalog entry stays as is. A failure in either step is retryable and
   never leaves a catalog entry pointing at nothing after the next start.
5. Recovery scan at startup: for each catalogued bot, open + resume; keep active
   ones open, queue the rest for idle close. A failing bot is reported and
   skipped; the scan never aborts the daemon.
6. Shutdown: stop accepting work, `close` every handle with a shared deadline.
   Handles that time out are logged as quarantined; process exit releases the
   socket lock and the OS closes their files. A timeout is never logged as
   success.

### Concurrency

| Concern | Rule |
| --- | --- |
| One bot, two runs | Impossible: pi queues the second input in `inbox` |
| Many bots | Parallel; each has its own Harness, storage and settings |
| Connection ↔ bot | One bot per connection for the connection's whole life. Switching bots means a new connection; `unsubscribe` does not exist |
| Subscribers per bot | Many; `EventHub` fans out and owns `rev` and coalescing on a per-bot serial queue |
| Shared mutable state | Only the catalog and the log; everything else is per bot |
| Snapshot rerender | When the runtime sends `snapshot` (watch fell behind) the hub renders a fresh wire snapshot to every subscriber at the next `rev` |

## Failure containment

| Failure | Layer | Containment |
| --- | --- | --- |
| Auth/token mismatch | L3 transport | HTTP 401 before upgrade; no bot opened |
| Malformed command | L3 protocol | Command rejected, connection kept |
| Unknown bot id | L2 core | Close `4004`, no runtime call |
| Model/provider error | L0 → L1 | Submission settles `unanswered{reason:"model_error"}`; bot usable |
| Provider error echoing user text | L1 | `err.kind` only; provider text never logged, message redacted to a fixed notice |
| Storage error (`SessionFailed`) | L0 | Harness closes itself; L1 classifies `storage_failed`, L2 marks `unavailable` |
| Parked task (`onReport`) | L0 → L1 | `error{kind:"task_parked"}`; `recover` clears it |
| Watch ended (`listener_error`, `session_failed`) | L0 → L1 | Reattach with a fresh snapshot; no client-visible error on the first, three failures in 60 s mint one `internal` failure and mark the bot `unavailable` |
| Whole process crash | — | Next start resumes; `SIGKILL` recovery is a mandatory test |
| `close()` timeout | L2 | Bot quarantined; open/delete refused until closed |
| Client disconnect | L4 | Daemon keeps working; reconnect starts from a snapshot |

A layer that cannot classify a failure rethrows it unchanged, so the log shows
the innermost layer rather than a generic wrapper.

## Dependency and version policy

- `@earendil-works/pi-durable` pinned exactly (`1.4.0`); experimental upstream.
- Upgrade = bump the pin, run `npm run test:runtime` (golden mapping), read the
  changed upstream sections (§2.1 context, §5.6 wakeups, §8.2 live, §9.3–9.4
  views/events), update the fact table in [RUNTIME.md](RUNTIME.md), one commit.
- Node ≥ 24 for the daemon (pi-durable needs ≥ 22.19). Verified on Node 26.12.0.
- Runtime TypeScript is erasable only: `type`, `interface`, `satisfies`. No
  `enum`, `namespace`, parameter properties or decorators, because the daemon runs
  through Node's type stripper. `tsc --noEmit` is a type gate, not a build.
- Swift: `ObservableObject` and the `LocalState` shim (no SwiftUI macros), because
  Command Line Tools must build the app; tests and the coverage gate need the
  Xcode toolchain, as in `apps/macos/Scripts`.
