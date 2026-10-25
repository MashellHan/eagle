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
| Client logic | `apps/bots-macos/**`: an SPM package (BotsCore, BotsTransport, BotsFeatures) with its own tests and gates; it depends on nothing from Eagle |
| Client UI | `apps/macos/Sources/EagleFeatures/BotsWorkspace.swift` and `WorkspaceShellView.swift`: a Bots group in the Eagle main window, built from EagleDesign components; the Eagle app depends on the Bots package, never the reverse |
| Shared code | `apps/macos` exposes `EagleDesign` as a library product for the Eagle targets; Bots logic does not import it |
| Forbidden imports | No Bots package file imports `apps/web`, `packages/agent`, `packages/contracts` or any Eagle target; the Eagle app is the only side that imports Bots |
| Gates | `apps/bots` and `apps/bots-macos` have their own gates. Root `npm run check`, the Eagle Swift package tests and CI do not run Bots |
| Biome | Root `biome.json` excludes `apps/bots`; the Bots daemon lints itself with its own Biome version |
| Docs | `docs/bots/**`; the root `AGENTS.md` carries a short rules section only |

The client UI is one window inside Eagle, not a second app: a bot is a sidebar
item, and selecting it turns the middle column into that bot's conversation. The
logic package stays free of Eagle so it keeps its own tests and gates, and the
dependency direction is fixed: Eagle imports Bots, Bots never imports Eagle (and
`EagleDesign` stays dependency-free).

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
import outside `src/runtime/**` and `src/tools/**` (the adapter boundary), (b) `src/core/**` and `src/protocol/**` do not
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
  main.ts                     paths, singleton lock, servers, closing (composition only)
  config.ts                   defaults; the only place env vars are read
  core/
    domain.ts                 Message, ContentBlock, ConversationSnapshot, Submission,
                              BotSummary, BotState, ErrorKind, BusyMode  (wire-independent)
    RuntimePort.ts            RuntimePort, RuntimeHandle, RuntimeEvent, RuntimeBotSpec
    BotDirectory.ts           catalog.json CRUD, atomic write
    BotRegistry.ts            open/close/quarantine, idle close, recovery scan, deadlock-free lock
    EventHub.ts               per-bot rev, fanout, coalescing, snapshot rerender, paging
    view.ts                   pure fold of runtime events into a ConversationSnapshot
    ConversationService.ts    connections, command routing, submission ranking, history, resync
  protocol/
    version.ts  limits.ts     PROTOCOL_VERSION, frame and page budgets
    events.ts   commands.ts   encode/decode domain ⇄ frames, validation
  tools/                      the bot's tools, inside the adapter boundary
    registry.ts               installs `bots-tools` and, when configured, `bots-herdr`
    files.ts                  read_file, write_file, list_files
    shell.ts                  run_command (deadline, output cap, minimal env, sandbox)
    workspace.ts              confinement: every path resolves inside the workspace
    limits.ts types.ts        budgets and the ToolOutcome shape
    herdr/client.ts           the herdr CLI as typed calls (argv, JSON, deadline, abort)
    herdr/tools.ts            the eight herdr tools and the one-space-per-bot rule
  runtime/pi/
    mapEvents.ts              pi AgentEvent / reports / watch end → RuntimeEvent
    PiDurableRuntime.ts       Harness ownership, submission ledger, close, recover
  server/
    http.ts ws.ts auth.ts     catalog endpoints, socket, bearer
  log/                        see OBSERVABILITY.md
  testing/                    FakeRuntime, fixture server
test/
  protocol/ core/ runtime/ server/ e2e/ log/ perf/ crash/ architecture.test.ts
```

### Client logic (`apps/bots-macos`) and its UI in Eagle

```
apps/bots-macos/
Package.swift                 no Eagle dependency; swiftLanguageModes: [.v5]
Sources/
  BotsCore/
    Model/Domain.swift        domain types mirroring core/domain.ts names
    Logic/Reducer.swift       pure fold into ConversationState, ranked submissions
    Logic/RevisionGap.swift   the gap rule the transport applies
    Ports/Ports.swift         CatalogPort, ConversationPort, ConversationEvent, ConnectionState
  BotsTransport/
    Wire.swift                frame codec (decode server events, encode commands)
    CatalogHTTPClient.swift   /v1/bots over HTTP
    ConversationSocket.swift  handshake, subscribe, gap/resync, close codes, backoff
    TokenStore.swift          `<root>/token` (env override for a dev shell), AppPaths
  BotsFeatures/
    AppViewModel.swift        catalog, selection, create/rename/delete
    ConversationViewModel.swift  connection, transcript, composer, outbox reconciliation
    OutboxStore.swift         persisted unsent sends (PROTOCOL.md, client duties)
Tests/
  BotsCoreTests/ BotsTransportTests/ BotsFeaturesTests/
Scripts/coverage.sh           logic coverage gate (90% lines)

apps/macos/Sources/EagleFeatures/
  BotsWorkspace.swift         BotsWorkspaceViewModel (observes the logic view models,
                              republishes as SidebarSection/TranscriptEntry), BotsPresenter
  WorkspaceShellView.swift    merges the Bots group into the sidebar and routes the
                              conversation column to it when a bot is selected
```

The UI is the existing Eagle shell: `SidebarPanel`, `ConversationColumn` and
`InspectorColumn` are unchanged, and a bot is a sidebar item whose conversation is
rendered through them. Streaming is real: the reducer folds each delta into the
message, and the presenter re-emits the assistant paragraph as it grows (with the
typing row while an attempt has no text yet).

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
  | { type: "status"; running: boolean; inbox: InboxItem[]; streaming: string | null }
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
    case status(running: Bool, inbox: [InboxItem], streaming: String?)
    case submission(Submission)
    case history([Message], hasMore: Bool)
    case error(kind: ErrorKind, disposition: ErrorDisposition, message: String,
               failure: String?, requestId: String?)
  }
}

// Mirrors the wire field verbatim: only `.notAdmitted` clears an outbox entry, so
// the transport must not collapse it into an ErrorKind.
public enum ErrorDisposition: String { case notAdmitted = "not_admitted", unknown, runtime }

// Command context is created by the view model, so the call site and the daemon
// share one trace and one requestId.
public struct CommandContext { public let trace: String; public let requestId: String? }

public protocol ConversationPort: AnyObject {
  func open(botId: String) -> AsyncStream<ConversationEvent>
  func send(_ text: String, whenBusy: BusyMode, context: CommandContext) async throws
  func abort(context: CommandContext) async throws
  func recover(context: CommandContext) async throws
  func resync(context: CommandContext) async throws
  func loadHistory(before messageId: String, context: CommandContext) async throws
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

Any file-based stale-lock recovery has an unlink race, so the singleton is a
**kernel-exclusive listener**: the daemon binds a second loopback port derived from
the canonical root path, and the kernel releases it when the process dies, including
on `SIGKILL`.

```
lock port = 44000 + (fnv1a(realpath(root)) % 1000)   // no override: the root alone decides
```

The port range sits above the default service port (43117) and has no per-process
override, because an override would let two processes with the same root take
different lock ports and both open the same sqlite files. Changing `--port` does not
change the lock port.

1. `listen(127.0.0.1:<lock port>)`. Success means this process owns the root.
2. `EADDRINUSE` → connect and exchange one line. A daemon answering with the same
   root means a live owner: print its pid and exit non-zero. An answer with a
   different root means a hash collision between two roots; exit with an explicit
   message naming both roots and the derived port (there is no override to reach
   for, so the fix is a different root path).
3. No answer (`ECONNREFUSED`) means nothing is listening even though the port is
   held — a state the kernel does not allow for a live listener — so retry once and
   then fail with the error. There is no file to delete and no takeover.

The unix socket is gone: the client transport is the TCP listener from
[PROTOCOL.md](PROTOCOL.md). Tests: a live daemon rejects a second start with the same
root *and different `--port`*; a `SIGKILL`ed daemon is taken over on the next start;
two different roots that hash to the same lock port fail with the documented
message.

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

### Lifecycle windows

Close, delete and shutdown each own the bot for their whole duration: an `open` that
arrives during one waits for it (the registry's per-bot `settling` promise), then
decides again — a reopened bot gets the handle the close created and released, and a
deleted bot resolves to `unknown_bot`. The service never assumes a cached handle is
alive: it asks the registry, and only reuses a view whose handle the registry still
owns. A path that cannot wait (a warm-up open that a delete meets) is what the windows
are for: the delete waits for the open, closes the handle it created, and only then
moves the directory.

### Concurrency

| Concern | Rule |
| --- | --- |
| One bot, two runs | Impossible: pi queues the second input in `inbox` |
| Many bots | Parallel; each has its own Harness, storage and settings |
| Connection ↔ bot | One bot per connection for the connection's whole life. Switching bots means a new connection; `unsubscribe` does not exist |
| Subscribers per bot | Many; `EventHub` fans out and owns `rev` and coalescing on a per-bot serial queue |
| Shared mutable state | Only the catalog and the log; everything else is per bot |
| Snapshot rerender | When the runtime sends `snapshot` (watch fell behind) the hub renders a fresh wire snapshot to every subscriber at the next `rev` |

`EventHub` requires an injected `measure` function, so the frame encoder owns the
byte count and `core/` keeps no wire knowledge. A delta is numbered only when its
batch is broadcast, so folding never leaves a revision gap, and a batch is split
between whole changes. While a subscriber is snapshot-only, the newest snapshot is
held as its recovery anchor; once an increment is lost after it the anchor is stale
and is never delivered, so the subscriber waits for a current snapshot instead of
silently rendering an outdated state.

`ConversationService` folds those events into the bot's current view, so a new
connection starts from what the bot is now, not from what it was when the bot
opened. The fold keeps the newest page only and remembers `truncatedBefore`, so a
rendered snapshot stays inside the documented page budget however long the
conversation runs; everything older stays reachable through `history`. It reserves the connection before opening, flushes the coalescing window
and captures the baseline's own revision inside the same serial section, and only
then goes live, so a first frame is always the snapshot whose `rev` the reply names.

## Failure containment

| Failure | Layer | Containment |
| --- | --- | --- |
| Auth/token mismatch | L3 transport | HTTP 401 before upgrade; no bot opened |
| Malformed command | L3 protocol | Command rejected, connection kept |
| Unknown bot id | L2 core | Close `4004`, no runtime call |
| Model/provider error | L0 → L1 | Submission settles `unanswered{reason:"model_error"}`; bot usable |
| Provider error echoing user text | L1 | `err.kind` only; provider text never logged, message redacted to a fixed notice |
| Storage error (`SessionFailed`) | L0 | Harness closes itself; L1 classifies `storage_failed`, L2 marks `unavailable` and drops the handle, so `recover` opens a new Harness |
| Parked task (`onReport`) | L0 → L1 | `error{kind:"task_parked"}`; `recover` clears it |
| Watch ended (`listener_error`) | L0 → L1 | Reattach with a fresh snapshot; no client-visible error on the first, three within 60 s mint one `internal` failure and mark the bot `unavailable` while keeping the Harness it owns. `recover` re-attaches that harness's watch; only a dead session may open a second one |
| Watch ended (`session_failed`) | L0 → L1 | Immediate `storage_failed` failure, same identity as `harness.closed{failed}`; no reattach counting |
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
