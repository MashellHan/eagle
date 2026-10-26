# Bots — product contract

Status: **phase 1, documentation only**. No Bots code exists yet. This file is the
first of six documents; see [ARCHITECTURE.md](ARCHITECTURE.md) for structure,
[PROTOCOL.md](PROTOCOL.md) for the wire contract, [RUNTIME.md](RUNTIME.md) for the
pi-durable mapping, [OBSERVABILITY.md](OBSERVABILITY.md) for logging and
[TESTING.md](TESTING.md) for the test ladder.

Bots is a **new, isolated product** in this repository. It shares no code,
protocol, build or dependency with the Eagle website, Worker or Agent. Its only
shared asset is `apps/macos/Sources/EagleDesign`, a dependency-free SwiftUI
token/component library with no feature state.

## What it is

A macOS chat client plus a local daemon. A user creates bots; each bot is one
independent durable conversation backed by `@earendil-works/pi-durable`. One bot
is one sqlite file, one Harness, one agent configuration, one working directory
and one event stream. Bots never share mutable state; the daemon only multiplexes
I/O for them.

The daemon lives in `apps/bots`; the client is its own SPM package in
`apps/bots-macos`, which depends only on the dependency-free `EagleDesign`
library. Neither is part of the Eagle web, Worker, Agent or Swift builds.

Phase 1 is a pure chat product: create, rename, delete and talk to bots. Bots
have no tools. This is deliberate — the runtime, protocol and client are built so
tools and bot-to-bot conversation can be added later without reworking any layer
(see [Reserved capabilities](#reserved-capabilities)).

## Owner decisions (fixed)

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | One daemon process hosts many bots | No per-bot process, no orchestration service |
| D2 | Complete isolation from Eagle | Separate npm project, separate lockfile, separate gates; no import of `apps/web`, `packages/agent`, `packages/contracts` |
| D3 | Every bot executes independently | Per-bot storage, Harness, settings, event stream; one bot's failure never stalls another |
| D4 | Phase 1 exposes chat only | The wire reserves the shape of tools, tasks, usage, raw entries, agent settings and peers; nothing renders them and no half-built UI ships |
| D5 | Tools and bot-to-bot chat are the next phase | Protocol, ports and capability flags reserve them now; no UI work for them in phase 1 |
| D6 | Busy default is `followUp` | A message sent while a run is active is queued and placed when the run answers |
| D7 | Speed is a feature | Bot creation must feel instantaneous; see [Speed targets](#speed-targets) |
| D8 | Local only | Loopback HTTP/WS with a 0600 bearer token; no remote access, no Cloudflare, no multi-user |

## User journeys (phase 1, complete list)

1. **Create.** The user picks "New Bot", types a name, confirms. The bot appears
   in the sidebar immediately and is ready to receive a message.
2. **Rename.** Inline rename from the sidebar; the new name survives a daemon
   restart.
3. **Delete.** Deletion removes the bot from the sidebar at once. The daemon
   closes the bot, moves its directory to `trash/` and updates the catalog.
   Restoring from trash is not a phase-1 feature; nothing is destroyed.
4. **Chat.** Selecting a bot shows its transcript and composer. Sending admits
   the message durably before it is echoed. Streaming answers update in place.
5. **Queue.** Sending while the bot is answering queues the message and shows it
   as queued, not as sent.
6. **Abort.** Stopping ends the run; the partial answer stays visible and is
   marked aborted.
7. **Reconnect.** Closing and reopening the window, or a temporary daemon
   restart, restores every transcript without user action. No message is
   duplicated or lost. Messages are bounded by construction; in the impossible case
   of an answer above the transport limit, the chat shows a notice instead of a
   silently shortened answer.
8. **Recover.** When a bot reports `unavailable` or a parked task, the chat offers
   one action: retry. It re-opens an unavailable bot or retries parked work, then
   reloads the transcript. It never interrupts a healthy answer; abort is a
   separate, explicit action.
9. **Quit.** Quitting the app does not stop the daemon. A daemon that was killed
   mid-answer resumes the run when it starts again.

Anything not in this list is phase 2.

## Delegation (phase 2)

A bot runs code and shell commands in its own workspace without asking (slice 1), and can
open a herdr space of its own, start a controller agent there, exchange messages with it,
wait for it, read its screen and close the space (slice 2). Tool calls are bot-side
activity: they stay on the left at the answer card's width, show what is running while it
runs, collapse into one line when the run's calls settle, and open a detail dialog with
each call's arguments and output.

## Profile editing

A bot's name, optional label and face are editable from its profile in the right panel:
hovering the face dims it and offers a pencil (the face editor reuses the create grid),
and clicking the name or the label edits it in place. A change is written over
`PATCH /v1/bots/:id` and the catalog push repaints the sidebar and inspector.

## Setup and guidance

The app starts the local Bots daemon on launch when it can find `apps/bots`
(settings shows its state and lets a person start, stop or restart it), and stops the daemon
it started when the app quits; a daemon that was already running is left alone. The model
gateway (URL, API key, model) is configured in the app's Settings under
`Bots 模型`; the same tab tests the endpoint and reports latency and model count. Setup is
progressive: a bot stays readable and usable until a send is attempted without a configured
gateway, and only then the conversation offers a short "去设置" hint. Nothing asks for
credentials at launch.

## Speed targets

Measured on this machine with Node 26.12.0 and `pi-durable@1.4.0`, using the faux
provider in `/tmp`: one bot, 200 turns with a 456-character answer and a
~140-character prompt, then a reopen immediately after close (warm page cache),
then 20 bots opened in one process. Single sample per row, not a percentile; the
scope of each claim is recorded in
[RUNTIME.md](RUNTIME.md#evidence). Real-model latency is network latency and is
excluded: the smoke test against the pinned development endpoint measured 1.3–1.7 s
per answered turn, which is upstream time, not Bots time.

| Operation | Measured (single sample) | Phase-1 bound (median of 5 samples, see [TESTING.md](TESTING.md#performance-measurement)) |
| --- | --- | --- |
| `Harness.open` + `root()` on an empty bot | 7 ms | < 250 ms |
| Reopen a bot with 400 entries / 479 KB | 3 ms | < 100 ms |
| One `submit()` → settled answer (faux) | 2–7 ms | < 200 ms |
| 200 answered turns, same bot | 164 ms total (≈1 ms/turn) | — |
| Storage growth per turn (456-char answers) | ≈2.4 KB | — |
| 20 bots open in one process | 30 ms, RSS 103 MB | < 1 s |
| Create bot (catalog write + directory) | — | < 50 ms |
| Delete bot (close + move to trash) | — | < 50 ms |

Implications recorded here so no later design contradicts them:

- Cold open is cheap enough that a bot is opened lazily on first use, with an
  asynchronous warm-up after creation. No connection pool, no pre-opened pool.
- Memory, not time, is the resource to manage: many open Harnesses cost RSS, so
  idle bots are closed (`idleCloseMs`, default 10 minutes). Reopening is 3 ms.
- The client never waits on the daemon to show that a message was admitted: the
  optimistic bubble is local, and durable admission arrives as a `submission`
  event.

## Reserved capabilities

The protocol carries a capability set in its handshake. The client renders only
what is enabled, so later phases flip flags instead of rebuilding screens.

| Capability | Phase 1 | What actually exists in phase 1 | Reserved for |
| --- | --- | --- | --- |
| `tools` | `true` (phase 2) | Tool calls and results render as transcript rows: name, arguments, status and output, live and after a snapshot; the workspace and herdr tools produce them | Approvals (none: tools execute without asking) |
| `tasks` | `false` | An `error` kind for parked tasks and a `recover` command | Task panel, per-task retry, compaction control |
| `entries` | `false` | Nothing beyond the transcript itself | Raw entry inspector |
| `usage` | `false` | A `usage` field in snapshots, populated from `pi.usage` (the data is live; only the panel is missing) | Token and cost panel |
| `agent` | `false` | Per-bot model stored in `bot.json` and used for every request | Model, thinking level and instructions editing |
| `peers` | `false` | A capability flag | Bot-to-bot messages and delegation |

Reserved means exactly two things: the wire can represent the concept, and a
client that receives it while the flag is off must ignore it. It does **not**
mean a hidden implementation exists. Each enable path is a change set of its own,
listed in [RUNTIME.md](RUNTIME.md#reserved-capability-enable-paths).

## Non-goals (phase 1)

- Tools, file access, shell, code execution.
- Bot-to-bot conversation, subagents, delegation, orchestration.
- Multi-user, sharing, remote access, mobile.
- Attachments, images, voice.
- Search across transcripts; export/import; transcript editing.
- Migrating existing pi coding-agent sessions (formats are unrelated and
  `pi-durable` explicitly does not provide a compatibility layer).
- Cloudflare Workers / Durable Objects hosting. The ports allow it later; nothing
  in phase 1 assumes it.

## Success criteria

Phase 1 is done when all of the following hold, each verified by a command
recorded in [CHECKPOINTS.md](CHECKPOINTS.md):

1. `cd apps/bots && npm run check` passes from a clean checkout, with no API key,
   and `npm run coverage` holds 90% lines / 90% functions / 85% branches with
   `--test-coverage-include-all`.
2. `cd apps/bots-macos && swift test` passes and `Scripts/coverage.sh` holds the
   90% Bots logic gate for its own target list.
3. The nine journeys above are exercised end to end against a real socket with the
   faux provider.
4. `npm run test:crash` passes: a `SIGKILL` mid-answer admits the input once,
   keeps the interrupted attempt as an aborted message, completes the answer once,
   and a delete interrupted between rename and catalog write reconciles on the next
   start.
5. One injected failure per layer is attributed to exactly one layer by
   `test/log/origin.test.ts` and `test/log/trace.test.ts`, not by reading code.
6. `npm run perf` prints its environment and samples and stays inside the bounds
   above.
7. Architecture guards pass: no `@earendil-works/*` import outside
   `src/runtime/**`, no protocol import from core, and no networking API in
   `BotsCore`/`BotsFeatures`/`EagleDesign`.
8. Isolation holds: root `npm run check`, the Eagle Swift package tests and biome
   do not touch `apps/bots` or `apps/bots-macos`.
