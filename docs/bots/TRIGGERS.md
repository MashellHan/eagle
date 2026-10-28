# Bots — triggers, invocation and peers

Status: **planned contract, stage 0 not implemented**. This document owns the
bot-side invocation interface, trigger definitions and delivery, and the peers
group. It precedes the code: the commit that implements a section updates it.
Product scope is in [PRODUCT.md](PRODUCT.md), layers in
[ARCHITECTURE.md](ARCHITECTURE.md), wire format in [PROTOCOL.md](PROTOCOL.md),
runtime mapping in [RUNTIME.md](RUNTIME.md), tool rules in
[Extensions and tools](EXTENSIONS-AND-TOOLS.md), logging in
[OBSERVABILITY.md](OBSERVABILITY.md).

"Trigger" here means **something other than a client connection that admits work
to a Bot**: a schedule, an inbound HTTP delivery, or another Bot. All three become
an ordinary user entry in the same conversation. None is a second execution
engine, a second queue of model work, or a new delivery state machine.

## 1. Scope

| In scope | Out of scope |
| --- | --- |
| One bot-side invocation port every caller uses | A generic job queue, message bus or plugin framework |
| A `trigger` tool group: the Bot creates and manages its own schedule and webhook triggers | Any user-facing creation, editing or deletion of triggers |
| A read-only trigger surface in the app: list, detail, enable switch | Per-trigger editing in the app, templates, folders |
| A `peers` tool group: Bot-to-Bot admission and observation | Broadcast, fan-out, answer forwarding, synchronous peer calls |
| Durable definitions, queues, admission origins, ordered shutdown | Public ingress: the daemon stays loopback-only (§8.3) |
| Additive `origin` on transcript messages | Reusing the website, Worker or D1 as a relay |

The owner's decision that cron is not our product means: no scheduling service the
user registers jobs in. A schedule trigger is a Bot-owned timer inside the daemon,
created by the Bot's own model, visible and switchable in the app. External cron
stays external and calls a webhook trigger, which is the same admission path with a
different origin.

## 2. Why a port instead of three features

`ConversationService.send(connectionId, …)` currently does three things: resolve a
connection, admit the input, and scope the reply to it. Only the middle part is
reusable, and it is already bot-scoped: `#bots` holds one view, one `EventHub` and
one runtime subscription per bot, and the admission chain is keyed by
`bot.snapshot.botId`. The connection dependency is the guard, not the mechanism.

```
src/triggers/**      schedule tick     webhook POST      peer_send
                          │                 │                │
                          └─────────────────┴────────────────┘
                                            ▼
                          core/Invocation.ts  (InvocationPort)
                                            ▼
                 ConversationService.invoke()   ← send() becomes a thin wrapper
                                            ▼
                          RuntimeHandle.submit(SubmitInput)
```

Rules that keep the cut honest:

1. The port knows nothing about time, queues, batching, HTTP or other Bots.
2. A caller never mints a submission identity inside the port; the caller owns a
   durable key (§3.2).
3. Deleting `src/triggers/webhook/**` leaves the daemon compiling and every other
   caller working.

## 3. Invocation contract (stage 0)

```ts
// apps/bots/src/core/Invocation.ts
import type { BusyMode, Submission } from "./domain.ts";

export type InvocationOrigin =
  | { readonly kind: "human" }
  | { readonly kind: "schedule"; readonly triggerId: string }
  | { readonly kind: "webhook"; readonly triggerId: string }
  | { readonly kind: "peer"; readonly fromBotId: string }
  | { readonly kind: "unknown" };

export type Invocation = {
  readonly botId: string;
  readonly requestId: string;
  readonly text: string;
  readonly origin: InvocationOrigin;
  readonly whenBusy?: BusyMode;
  readonly trace: string;
};

export interface InvocationPort {
  invoke(input: Invocation): Promise<Submission>;
  /** Durable lookup, including settled records after a restart (§3.2). */
  submission(query: {
    botId: string;
    requestId: string;
  }): Promise<Submission | undefined>;
  observe(botId: string, sink: (running: boolean) => void): { detach(): void };
}
```

### 3.1 Rules

| # | Rule |
| --- | --- |
| I1 | `invoke` returns when the admission record exists; it never waits for an answer or an idle bot |
| I2 | `invoke` is idempotent by `(botId, requestId)`; a repeat returns the stored record and runs nothing new |
| I3 | The port never generates, rewrites or retries a `requestId`; it validates the format and refuses otherwise |
| I4 | `invoke` shares the human admission chain: budget checks, reservations and duplicate lookups are one serial section per bot |
| I5 | The bot cannot idle-close during an admission (§3.3) |
| I6 | Refusals preserve the originating `Failure` identity and a disposition (§3.4); success is always a `Submission` |
| I7 | `observe` delivers the current `running` value on attach, then transitions, for a bot with no connection (§3.5) |
| I8 | `origin` is required and closed; `unknown` exists only for reconstruction and is never passed in |
| I9 | The port owns no queue, batching, timer or rate limit; those are caller policy |
| I10 | One `trace` per admission episode, reused across retries of that episode |
| I11 | `text` is capped at `MAX_SEND_TEXT` code points for every origin; `steer` is refused for every non-human origin |
| I12 | Startup and shutdown order is fixed: producers stop, admissions drain, then the registry closes (§3.6) |

### 3.2 Identity

`requestId` is `[A-Za-z0-9_-]{8,64}`. pi dedupes by `requestId` inside one
conversation's storage and that survives a restart (RUNTIME.md F7), so a key must
carry its producer namespace and must be **fixed-length**: `newBotId()` emits 38
characters (`BotRegistry.ts:95`) and SDK call IDs may contain `/`
(`harness/types.d.ts:213`), so neither can be concatenated.

| Caller | Key | Length | Stability source |
| --- | --- | --- | --- |
| Client `send` | `r_<client id>` | 8–64 | Client outbox |
| `schedule` | `sh_<triggerId>_<dueAtUnixSeconds>` | 3 + 12 + 1 + 10 = 26 | The due instant named by the durable cursor |
| `webhook` | `wh_<triggerId>_<batchId>` | 3 + 12 + 1 + ≤10 = ≤26 | The trigger's durable batch counter |
| `peer` | `pr_<16 hex>` of `sha256(fromBotId ‖ toBotId ‖ conversationId ‖ callId)` | 19 | The durable tool-task call identity |

`triggerId` is therefore fixed at 12 characters (`t_` + 10 base32). A key that names
a moment in time, a random value or a queue position is a defect.

**Durable lookup.** `PiDurableRuntime.submission({requestId})` today reads an
in-memory map and then `inspect().submissions`, which lists only queued and placed
records (`harness/types.d.ts:656`); after a restart a settled record is unreachable,
so `#admit` would skip duplicate detection and could refuse a repeat on a full
budget before pi ever sees its own idempotency. Stage 0 therefore moves the lookup
to `Tx.submissionByRequest(conversationId, requestId)`
(`harness/types.d.ts:845`), which is durable, and covers it with a real reopen test.

### 3.3 Idle close during an admission

A lease alone is not enough. `BotRegistry.#idleClose()` awaits `busy()` and then
rechecks only `entry.subscribers` (`BotRegistry.ts:796`), so a `busy(): false` read
that started before `touch → submit → release` can close a bot whose run is just
starting. Stage 0 closes that hole in the registry, not in the caller:

- `#touch()` increments a per-entry **activity generation**.
- `#idleClose()` reads the generation before `await busy()` and abandons the close
  when it changed, rescheduling instead.
- `invoke` holds the lease across open, dedupe lookup, budget check and `submit`,
  and releases it once in `finally`, so a refusal and a throw balance too.

Test: with `idleCloseMs: 0` and a gated handle whose `busy()` is resolved after
`release`, the bot stays open and the admitted run survives.

### 3.4 Refusals

Existing dispositions are reused; no new `ErrorKind` is introduced. The runtime
throws `ClassifiedFailure`, not `CommandError` (`PiDurableRuntime.ts:452`), so the
new entry point wraps it while keeping the original `failure.id`.

| Situation | `kind` | disposition | Caller action |
| --- | --- | --- | --- |
| Busy with `reject` | `limit_exceeded` | `not_admitted` | Keep the batch, retry after the next admission settles |
| Admission budget full | `limit_exceeded` | `not_admitted` | Keep the batch, retry after the next admission settles |
| Bot `unavailable` | `storage_failed` / `internal` | `runtime` | Hold with backoff, log once, never hot-loop |
| Bot quarantined | `unknown_bot` | `not_admitted` | Hold: the catalog entry still exists (`BotRegistry.ts:597`) |
| Bot truly absent from the catalog | `unknown_bot` | `not_admitted` | Disable the trigger, record the reason |
| Malformed key, text or origin | `invalid_command` | `not_admitted` | Caller bug: fail closed, log once |
| Admission unconfirmed | `internal` | `unknown` | Retry with the same key |

Busy and budget exhaustion are **not** distinguished by kind or disposition: both
are `limit_exceeded/not_admitted`, which is what the adapter already returns for
`ConversationBusy` (`PiDurableRuntime.ts:442`, PROTOCOL.md:584). A caller keeps its
work in both cases. "Quarantined" and "absent" share a kind, so the invocation
layer reports catalog presence separately (`registry.summaries()`), and only true
absence disables a trigger.

### 3.5 Observation without a connection

The per-bot view is not usable yet by a caller with no subscriber:
`#attach()` buffers runtime events until `bot.release()` is called
(`ConversationService.ts:823`), and today only `subscribe()` releases it
(`ConversationService.ts:247`). `invoke` alone would therefore leave the view
frozen at its baseline.

Stage 0 makes the internal view self-ready: `#bot()` releases the buffered events
itself, so an internal open is live whether or not a client ever subscribes, while
`subscribe()` keeps the snapshot-first baseline for the wire. `observe` then reads
`bot.snapshot.running` and subscribes to the bot's transitions:

- `observe` calls the sink once with the current value, then on every change.
- Observers are keyed by `botId` and rebound when the view is replaced (reopen,
  recovery); a detached observer receives nothing.
- An `unavailable` bot reports `running: false`; `observe` never opens a bot.
- `observe` is a scheduling hint, never an admission lock (§5.4).

### 3.6 Startup and shutdown order

Triggers add producers to a process that previously had only a transport:

1. **Startup:** load trigger stores and secrets, then the registry recovery scan,
   then start producers. Injected host callbacks must exist before the first
   `Harness.open`, because recovery can run a tool immediately.
2. **Shutdown:** stop producers (`http` stops accepting, scheduler timer cleared),
   drain in-flight admissions and journal writes, then `registry.shutdown()`, then
   logs and the lock. A producer that admits after the drain is a defect; the
   registry's `closing` flag refuses new work, and `invoke` surfaces that refusal
   instead of retrying.
3. **Delete:** the registry refuses new leases for a bot in a delete window; queued
   items for that bot are discarded with one record in the journal, and the
   directory move takes triggers, secrets and journals along.

### 3.7 Tests that lock stage 0

`test/core/invocation.test.ts`, against `FakeRuntime`, deterministic:

1. Same `requestId` twice admits once and returns the same record.
2. `invoke` on a bot with no subscription opens it, the view is live and the entry
   reaches an observer.
3. Budget exhaustion refuses `not_admitted` while a human `send` still succeeds.
4. Busy `reject` refuses `not_admitted`; the retry with the same key produces one run.
5. Unknown bot refuses `not_admitted` and never opens a Harness.
6. `observe` emits the current value on attach, then transitions, without a
   connection; it detaches cleanly and is rebound after a reopen.
7. `touch`/`release` balance on success, refusal and a throwing submit, and
   `idleCloseMs: 0` cannot close a bot mid-admission (§3.3).
8. Invalid `requestId`, over-long text and non-human `steer` are refused before any
   runtime call.
9. `send` and `invoke` interleave on one bot: admissions stay serialized, no lost
   reservation, budget still atomic.
10. Restart: a new service over a reopened real adapter resolves a settled key
    through `submissionByRequest` and runs nothing, even with a full budget.
11. Shutdown: a producer that admits while draining receives a refusal; no Harness
    opens after `registry.shutdown()` resolves.

`test/architecture.test.ts` gains an edge for `src/triggers/**`: it may import
`core/Invocation.ts`, `core/TriggerStore.ts`, `core/domain.ts` and `log/**`, and
nothing else. `src/tools/**` keeps its rule (only `src/tools/**`), so trigger DTOs
used by tools live in `src/tools/types.ts` and are bound to core shapes by a
compile-time conformance test, the same discipline as `runtime/pi/limits.ts`.

Stage 0 exit: `npm run check` green, the eleven behaviors demonstrated
failing-then-passing, no caller implemented.

## 4. Trigger definitions

```ts
// apps/bots/src/core/TriggerStore.ts — definition types + the file-backed store
export type TriggerKind = "schedule" | "webhook";

export type TriggerDefinition = {
  readonly id: string; // t_ + 10 base32, exactly 12 characters (§3.2)
  readonly botId: string;
  readonly kind: TriggerKind;
  readonly name: string; // 1..64 chars, unique per bot
  readonly prompt: string; // 1..4000 chars, the Bot's standing instruction
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schedule?: {
    readonly cron: string; // 5 fields, minute resolution
    readonly timezone: string; // IANA
    readonly cursor?: string; // absolute next due instant; absent when disabled
  };
  readonly counters: { fired: number; dropped: number; refused: number };
  readonly lastFiredAt?: string;
  readonly lastSkipped?: {
    readonly at: string;
    readonly reason: "disabled" | "missed" | "rate_limited" | "queue_full";
  };
};
```

| Path | Content | Notes |
| --- | --- | --- |
| `<bot dir>/triggers.journal.jsonl` | Every mutation, decision and counter change, append-only | **Source of truth**, mode 0600 |
| `<bot dir>/triggers.json` | Materialized `{revision, triggers}`, atomic tmp + rename | Rebuildable from the journal; readers use it |
| `<bot dir>/triggers.secrets.json` | `{ [triggerId]: token }`, 0600 | Webhook bearer only; never logged, never in model context, never in a URL |
| `<bot dir>/triggers/<triggerId>.jsonl` | Queue items, frozen batches, delivery receipts | Append-only |

Rules:

1. A Bot owns its triggers; there is no daemon-wide trigger registry and no trigger
   targeting a different bot. Deleting a bot takes all four paths with it.
2. The journal is the only source of truth for definitions: a mutation is one
   append with an `opId`, its payload and its result. `triggers.json` is derived, so
   a crash can never leave a half-applied mutation, and a replayed tool call looks
   up `opId` and returns the recorded result instead of mutating twice (§7).
3. A definition is valid only when its kind matches its payload.
4. `prompt` is model-authored text, never code: it is admitted as a user message and
   has exactly a user message's authority.
5. Enable and disable are read live by the scheduler, the HTTP endpoint and the
   tools. No Harness restart, no registry refresh, no new subscription.
6. The app surface is read-only plus one switch; the model is the only creator,
   editor and deleter.

## 5. Delivery, queue and batching (stages 1 and 2)

### 5.1 Queue

Each `(trigger, bot)` pair owns one FIFO queue of at most 32 **queued** items. Items
moved into a frozen batch are no longer in the queue, so the cap bounds waiting work
only.

| Event | Behavior |
| --- | --- |
| Fire arrives, bot idle and no batch in flight | Cut immediately |
| Fire arrives, bot running or a batch in flight | Append, wait for the drain pump |
| Drain pump finds idle, queue non-empty, no batch in flight | Cut a batch |
| 33rd queued item | Evict the head (oldest), `counters.dropped += 1`, journal the drop |
| Trigger disabled with a batch in flight | Keep that batch; later items are refused as `disabled` |
| Trigger deleted with a batch in flight | Discard the queue with one journal record; the in-flight admission is not aborted |

Eviction prefers the newest window and is always journaled and visible in the
transcript header, so a loss is never silent.

### 5.2 The admitted text

One template for both kinds, rendered by a pure function that is golden-tested:

```
<prompt>

[schedule · 3 items · 2026-10-28T10:02Z..10:31Z · 4 older events dropped]
1. (10:02Z) <item>
2. (10:09Z) <item>
3. (10:31Z) <item>

Answer once, for the batch as a whole.
```

The footer makes a merged batch one turn instead of N. The header clause appears
only when non-zero. Truncation marker is the fixed `…[truncated]` (13 code points).

Budget is computed from the rendered result, not a guessed reserve:

```
budget = MAX_SEND_TEXT - codePoints(prompt) - 64
render the header (name ≤ 64 chars, ≤ 32 numbered lines) — it is bounded
take items from the head while the rendered length stays ≤ budget
always take at least one item, truncating it with the marker when necessary
```

`prompt ≤ 4000` guarantees `budget ≥ 3936`, so one item always fits. Items that do
not fit stay queued for the next batch, so a 12-item backlog under a small budget
becomes several runs and loses nothing. The one unavoidable loss is an item larger
than the whole budget: it is truncated with a visible marker and `dropped` is not
bumped, because it was delivered.

### 5.3 Batch identity and close

A cut is one journal record: `{batchId, requestId, itemIds, text, cutAt}`. The batch
is **frozen**: its members, text and key never change, so a retry re-submits exactly
the same admission and pi collapses it.

| Record reached | Meaning | Batch |
| --- | --- | --- |
| `queued` / `placed` | Admitted, run pending | Open, items stay frozen, no re-cut |
| `done` | Answered | Closed + receipt |
| `unanswered` | Terminal, no answer (`model_error`, `aborted`, …) | Closed + receipt; **never replayed** |
| refusal `not_admitted` (busy/budget) | Not admitted | Uncut: members return to the queue head, same `batchId` retired |
| refusal `runtime` / `unknown` | Unconfirmed or unavailable | Keep frozen, retry same key with backoff |

Only a terminal record closes a batch. A `model_error` is an answer failure, not a
delivery failure; replaying it would spend tokens twice and could repeat side
effects.

### 5.4 Drain pump

`running` is a hint, never a lock: a run can finish before `submit` returns
(`PiDurableRuntime.ts:408`), so the only `running: false` edge can occur while a
batch is still open, and a `reject` refusal can arrive after the bot is already idle.
A caller that waits for the next edge would strand the rest of the queue.

Each module therefore runs one **drain pump per bot**, and the pump:

1. takes its lock before the first `await` and records every wake that happens while
   it is busy,
2. re-evaluates the cut condition after every admission settles, after every
   refusal and on every observed transition,
3. never waits for an edge to re-check; `observe` only avoids polling,
4. arbitrates **round-robin across that bot's triggers**, so one busy trigger cannot
   starve another (the core port is serial but not fair,
   `ConversationService.ts:536`),
5. hands the final atomic refusal to the runtime (`whenBusy: "reject"`) so two
   callers cannot both cut a batch for one idle window.

## 6. Origin on transcript messages

### 6.1 Why the daemon keeps it

pi stores entries, not origins, and `inspect().submissions` lists only unsettled
records, so `Message.requestId` is not reliable after a restart (RUNTIME.md,
"Submission ledger"). An origin derived from a key prefix would vanish on reboot.

### 6.2 Sidecar

`<bot dir>/origins.jsonl`, append-only:

```
{"requestId":"wh_t_9f2_14","origin":{"kind":"webhook","triggerId":"t_9f2"},"entryId":"12"}
```

| Rule | Detail |
| --- | --- |
| Write-ahead | `{requestId, origin}` lands before `invoke`; a failed write refuses the admission |
| Backfill | When the submission names `entryId`, a second record appends with it |
| Replay | On open the file folds `entryId → origin`, last record wins; malformed lines are dropped with one log line |
| Coverage | Every admission is recorded, including `human`; absence therefore means `unknown`, never `human` |
| Cap | 20 000 records; beyond it the oldest are trimmed and their messages render as `unknown` |

No revision-based pruning: a page boundary does not prove an entry is deleted
(history keeps paging), so trimming is by size only and is documented as such.

### 6.3 One enrichment path

`view.ts` stays a pure fold. The service injects an in-memory `OriginLookup`
(hydrated on open) and applies it in exactly four places, which is what keeps
`snapshot`, live events, `history` and `resync` in agreement:

| Path | Today | Handler |
| --- | --- | --- |
| Attach baseline | `#attach` trims `subscription.snapshot` (`ConversationService.ts:823`) | enrich while trimming |
| Live `append` / `append.replaces` | `apply()` publishes the **raw** runtime event (`ConversationService.ts:818`) | enrich the published message |
| `history` | returns runtime messages directly (`ConversationService.ts:376`) | enrich each page |
| `resync` / rerender | rendered from the fold | enrich the rendered page |

A test asserts the four paths agree on one message.

### 6.4 Wire shape (additive, PROTOCOL.md v1)

```json
{ "id": "e_12", "role": "user", "state": "complete", "createdAt": "…",
  "origin": { "kind": "webhook", "label": "deploy-notify" },
  "blocks": [ { "type": "text", "text": "…" } ] }
```

- Present on committed user messages and on a live `send`'s provisional message;
  `{kind:"human"}` is explicit.
- `label` is the trigger's `name`, or the sender Bot's title for `peer`; clients
  must not depend on it for logic.
- `{kind:"unknown"}` renders as a plain user message with no chip.
- Absent `origin` in a decode normalizes to `unknown`, so fixtures recorded before
  this lands stay valid.

### 6.5 Tests

Restart replay; the one-record crash window degrading to `unknown`; a human
admission rendered as `{kind:"human"}`; the four paths agreeing; strict fixture
decode; a trimmed record degrading to `unknown`; no origin for an entry the daemon
never admitted.

## 7. Tool groups

| Group | Extension | Tools | Loader | Default |
| --- | --- | --- | --- | --- |
| `trigger` | `bots-trigger` | `trigger_create`, `trigger_list`, `trigger_update`, `trigger_enable`, `trigger_delete` | deferred (`tool-search`) | off |
| `peers` | `bots-peers` | `peer_list`, `peer_send`, `peer_read` | deferred (`tool-search`) | off |

### 7.1 Registration and injection, all of it

1. `core/domain.ts`: append to `TOOL_GROUP_NAMES`; confirmed absent from
   `DEFAULT_TOOL_GROUPS`.
2. `tools/registry.ts`: `GROUP_EXTENSIONS[group] = [EXTENSION, toolSearch.name]`,
   plus the install guarded by its host options. The loader condition
   (`tools/registry.ts:97`) currently names only Herdr and search and must include
   both new groups.
3. `tools/types.ts`: `TriggerToolHost` / `PeerToolHost` and their DTOs. Because
   `src/tools/**` may import only itself, the DTO shapes are mirrored in core and
   bound by a compile-time conformance test in `test/` (the `runtime/pi/limits.ts`
   discipline).
4. `ToolRegistryOptions` → `PiRuntimeOptions` → `PiDurableRuntime.open()` →
   `createToolRegistry(workspace, { trigger, peers })`: the callbacks are bound per
   bot at the composition root and exist before the first open, including the
   startup recovery scan. `refreshTools()` only reselects installed objects
   (`PiDurableRuntime.ts:650`), so it cannot install a missing host-bound extension.
5. `apps/macos/Sources/EagleFeatures/SettingsViewModel.swift`: vocabulary and row;
   `SettingsView.swift`: the switch.
6. `docs/bots/EXTENSIONS-AND-TOOLS.md` inventory, `PLAN.md`, and this document.

Tool rules, with the replay policy the SDK actually implements (safe re-executes
the handler; it does not cache business results, `harness/tool.js:104`):

| Tool | Replay | Enforcement |
| --- | --- | --- |
| `trigger_list`, `peer_list` | safe | Read-only |
| `trigger_create` | safe | Idempotent by `(botId, name)` **and** by `opId` = tool `callId`; an identical payload returns `created: false`; a different payload under a taken name is refused |
| `trigger_update`, `trigger_enable` | safe | `opId` lookup returns the recorded result, so a replay cannot re-open a switch the user closed |
| `trigger_delete` | safe | `opId` lookup; absent trigger returns the same recorded result |
| `peer_send` | unsafe | Admits work into another Bot; an interrupted call is abandoned, not repeated |
| `peer_read` | safe | Observes an existing submission |

Every trigger mutation therefore goes through the journal's `opId` record (§4 rule
2). Until that journal exists, no mutation tool may be marked safe.

The model never receives a webhook secret: `trigger_create` and `trigger_list`
return an endpoint path without credentials, and the app shows the token separately.

## 8. Stage 1 and 2 — schedule and webhook

### 8.1 Schedule

- Five fields, minute resolution; IANA `timezone`, validated at creation.
- `schedule.cursor` is the absolute next due instant and the only scheduling state.
  It is absent while disabled, so enabling never catches up: enabling sets
  `cursor = next instant after now`.
- Parser: one pinned dependency (candidate `croner`). If it cannot be installed from
  the machine-approved registry, the fallback is `every <n>m|h` and `daily HH:MM`,
  recorded here **before** code.

Ticking, one daemon-wide scheduler with injected `now`/`setTimer`, 15 s period:

```
for each enabled trigger:
  if cursor is absent: cursor = next instant after now; journal; continue
  if cursor > now: continue
  if now - cursor > 90_000: journal {skipped: "missed"}; cursor = next after now; continue
  journal ONE record {item, dueAt, cursorAfter}   ← the durable decision
  cursor = cursorAfter
```

The single journal record makes enqueue and cursor advance atomic, so a crash can
neither double-fire nor lose a fire. Downtime beyond the freshness window is never
replayed. DST follows the parser's documented rule for the stored zone and is tested
in both directions.

### 8.2 Webhook

`POST /v1/triggers/<botId>/<triggerId>` with `Authorization: Bearer <triggerToken>`.
The URL carries no credential: the token is a per-trigger secret in a header, so a
command line, a tunnel log or a proxy history never records it. This route is the
only one outside the daemon bearer check (`http.ts:311` authenticates everything but
`/v1/health`), and the contract states that explicitly: it is authenticated by the
trigger token instead. Comparison is constant-time, and every trigger token joins
the `Log` secret list (`main.ts:132`) so redaction covers it.

| Condition | Response |
| --- | --- |
| Body > 64 KiB | `413` |
| Unknown bot, unknown trigger or wrong token | `404`, one message, no distinction |
| `enabled: false` | `409`, `{ "reason": "disabled" }` |
| Queue at 32 | `429`, `{ "reason": "queue_full" }` — the queue never evicts to make room for an unauthenticated burst |
| Accepted | `202`, `{ "queued": n, "dropped": n }` — queued, **not** executed |

Other hardening: reject a request carrying an `Origin` header, POST only, no query
parameters, per-token token bucket 120/min, per-trigger `maxFiresPerHour` default 60.

Item identity: `Idempotency-Key` when present, else `sha256(body ‖ content-type)`
truncated to 16 chars, deduped against the live queue and the last delivered batch,
so an at-least-once sender never enqueues one delivery twice inside the window.

Text: `application/json` with string `text`, else the raw body; clamped to
`MAX_SEND_TEXT` with the marker; empty text is `422`.

Loopback only: the daemon binds 127.0.0.1, so this endpoint serves local
integrations (scripts, a local service, system cron calling `curl`) and whatever a
user exposes through their own tunnel. Exposing external traffic is not our product.

### 8.3 Tests

Shared harness, both kinds: queue cap and eviction; budget cut producing several
batches in arrival order with no loss; the single oversize item; the envelope golden
text at the boundary; the drain pump terminating a backlog whose run finished before
`submit` returned; round-robin fairness between two triggers of one bot; refusal
retention with an unchanged key; `unknown` retry producing one run; delete or
disable during an in-flight batch; `stop()` leaving a recoverable journal; restart
mid-batch resuming the frozen batch.

Schedule: one due instant firing exactly once under a fake clock; a restart in the
same minute firing nothing twice; 10 minutes of downtime skipping without firing and
recording `missed`; disable → enable not catching up; DST both directions; an
invalid expression refused at creation.

Webhook: the response matrix; constant-time compare; **no token in any log line or
error body** (redaction test); idempotency with and without the header; a retry
inside the window enqueuing once; `409` leaving the queue untouched; `429` not
evicting.

## 9. Stage 3 — peers

Tool faces are owned by
[Extensions and tools](EXTENSIONS-AND-TOOLS.md#64-agents-and-peers-discovery-listing-and-communication);
this section adds the host side and must not contradict it.

- `peer_send` calls `invoke` with `origin: {kind:"peer", fromBotId}` and
  `whenBusy: "followUp"`, returns `{botId, requestId, status}` and never waits for
  an answer.
- The tool handler passes `bid` metadata from `ToolExecutionApi` — `conversationId`
  and `callId`, never model-supplied identity — and the port derives the 16-hex key
  (§3.2). The host signature carries that metadata, not just `{toBotId, message}`.
- **Lost acknowledgement.** `unsafe` stops our retry, but a crash between the
  recipient's admission and the sender's receipt leaves the sender without a
  `submissionId`. Stage 3 therefore writes a sender-side outbound receipt
  (`{requestId, toBotId, callId}`) **before** `invoke`, and `peer_read` is keyed by
  the caller's own `requestId`, not by a `submissionId` the sender may never have.
- **Answer text.** `Submission` carries `answerEntryId`, not text
  (`core/domain.ts:82`), so `peer_read` needs an owner-scoped read of that entry.
  The stage-3 spike decides whether that is a new `RuntimeHandle.entryById` or a
  narrow `history` filter, and the port grows exactly one method for it.
- **Cycle control is a gate, not a follow-up.** EXTENSIONS §6.4 requires a durable
  route origin and visited path with a four-Bot cap; a numeric-only release would
  contradict it, and `peers: false` does not prevent a selected tool from being
  called (EXTENSIONS §6.4 says so itself). So `peer_send` is not registered until
  the spike decides between:

| Option | Mechanism | Cost |
| --- | --- | --- |
| A | Visited path in the admitted text; the model passes it back | Weak: enforcement depends on model compliance |
| B | Host-side route store keyed by the recipient submission, read by the tool | The tool must know which submission started the current run; needs a port addition and an adapter check |

  Whichever wins, `peer_send` ships with the path check, the four-Bot cap and the
  numeric caps together: per-pair 8/hour, per-bot inbound 24/hour.

## 10. Observability

Existing logger constraints: event names must start with their layer
(`log/log.ts:211`), layers are `transport | protocol | core | runtime | pi`
(`log/events.ts:4`), and `origin` is already the failure-origin boolean
(`log/log.ts:187`). New events therefore use existing prefixes, and the invocation
source is a distinct field:

| Event | Fields |
| --- | --- |
| `core.trigger.fire.ok` / `.fail` | `botId`, `triggerId`, `invocationOrigin`, `reqId`, `count`, `failure` |
| `core.trigger.queue.drop` | `botId`, `triggerId`, `count` |
| `core.trigger.tick.ok` / `.fail` | `botId`, `triggerId`, `dueAt`, reason |
| `transport.trigger.http.ok` / `.fail` | `triggerId`, `status`, `count` — never the token |
| `core.trigger.tool.ok` / `.fail` | `botId`, `tool`, `triggerId`, `failure` |
| `core.peer.send.ok` / `.fail`, `core.peer.read.fail` | `fromBotId`, `toBotId`, `reqId`, `failure` |

`core.submit.*` gains `invocationOrigin` and its `detail` schema, so one query
answers "who admitted this run". One trace spans the episode (tick or HTTP →
queue → cut → `invoke` → run); the innermost failure is the only one logged with
`origin: true`.

## 11. Stage order and exit criteria

| Stage | Content | Exit |
| --- | --- | --- |
| 0 | `core/Invocation.ts`; `invoke`/`observe`; thin `send`; registry activity generation; durable `submissionByRequest`; self-ready internal view; ordered shutdown; contract tests | §3.7 green; no caller; `npm run check` |
| 1 | `trigger` group, journal-backed store with `opId`, queue/cut/drain pump, origin sidecar and wire field, schedule scheduler, app list/detail/switch | §8.3 green; a real Harness fires a real schedule; the app shows detail and toggles it |
| 2 | webhook endpoint, per-trigger tokens in headers and log redaction, response matrix, limits, idempotency | §8.3 green; local `curl` enqueues once under retry; no token in logs |
| 3 | `peers` group, route-enforcement spike, outbound receipts, answer read, caps | Two real Harnesses; `peer_read` ownership; path and caps proven; capability decision recorded |

The origin field lands in its own commit at the start of stage 1, before the first
fired message exists, so no migration is needed.

Every stage: failing test first, then the smallest implementation, then the affected
gates. No skipped test, no widened limit, no silenced log.

## 12. Non-goals

- A scheduler service, cron catch-up, or a user-facing job editor.
- Public ingress, cloud relay, or any coupling to the website/Worker/D1.
- A generic event bus, plugin API, or a second queue of model work.
- Trigger chains, broadcast, fan-out, answer fan-in.
- Per-trigger model, tool-group or permission overrides; a trigger inherits its
  bot's settings.
- Editing a trigger's prompt from the app. The model owns the definition; the user
  owns the switch.
- Shipping `peer_send` on numeric limits alone.
