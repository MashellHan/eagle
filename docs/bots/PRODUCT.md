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
| D4 | Phase 1 exposes chat only | Tools, tasks, usage, raw entries and agent settings exist behind capability flags and are not rendered |
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
   duplicated or lost.
8. **Quit.** Quitting the app does not stop the daemon. A daemon that was killed
   mid-answer resumes the run when it starts again.

Anything not in this list is phase 2.

## Speed targets

Measured on this machine (Node 26.12.0, `pi-durable@1.4.0`, faux provider, cold
page cache, `/tmp` filesystem). These numbers are the baseline the
`test/perf` smoke test guards; see [TESTING.md](TESTING.md).

| Operation | Measured | Phase-1 target (p95) |
| --- | --- | --- |
| `Harness.open` + `root()` on an empty bot | 7 ms | < 250 ms |
| Reopen a bot with 400 entries / 479 KB | 3 ms | < 100 ms |
| One `submit()` → settled answer (faux) | 2–7 ms | < 200 ms |
| 200 answered turns, same bot | 164 ms total (≈1 ms/turn) | — |
| Storage growth per turn (800-char answers) | ≈2.4 KB | — |
| 20 bots open in one process | 30 ms, RSS 103 MB | < 1 s |
| Create bot (catalog write + directory) | — | < 50 ms |
| Delete bot (close + move to trash) | — | < 50 ms |

Implications recorded here so no later design contradicts them:

- Cold open is cheap enough that a bot is opened lazily on first use, with an
  asynchronous warm-up after creation. No connection pool, no pre-opened pool.
- Memory, not time, is the resource to manage: many open Harnesses cost RSS, so
  idle bots are closed (`idleCloseMs`, default 10 minutes). Reopening is 3 ms.
- Real-model latency is network latency. The client must therefore never wait on
  the daemon to show that a message was admitted.

## Reserved capabilities

The protocol carries a capability set in its handshake. The client renders only
what is enabled, so later phases flip flags instead of rebuilding screens.

| Capability | Phase 1 | Reserved for |
| --- | --- | --- |
| `tools` | `false` | Tool calls, approvals, tool result rendering |
| `tasks` | `false` | Task/pane panel, retry of parked tasks, compactions |
| `entries` | `false` | Raw transcript/entry inspector |
| `usage` | `false` | Token and cost panel |
| `agent` | `false` | Model, thinking level, instructions, working directory |
| `peers` | `false` | Bot-to-bot messages and delegation |

Reserved means: the protocol field, the runtime mapping and the client view
model exist and are tested; the UI does not render them. See
[RUNTIME.md](RUNTIME.md#reserved-capability-enable-paths) for the enable path of
each.

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

1. `cd apps/bots && npm run check` passes from a clean checkout, with no API key.
2. `cd apps/macos && swift test` passes; the Bots logic coverage gate is ≥ 90%.
3. The eight journeys above are exercised end to end with the faux provider.
4. A single injected failure is traceable to exactly one layer from the log alone,
   proven by `apps/bots/test/log/trace.test.ts`, not by reading code.
5. The `test/perf` smoke test passes and prints the numbers it observed.
6. Two architecture guard tests pass: no `@earendil-works/*` import outside
   `src/runtime/**`, and no network API inside `BotsCore` / `BotsFeatures` /
   `EagleDesign`.
