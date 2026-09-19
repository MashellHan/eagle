# Live Pane summaries

Two independent channels share machine-scoped Bearer authentication. The daemon's v1 report remains a complete deterministic inventory every 30 seconds. A local Manager reads that acknowledged snapshot plus bounded, redacted recent-unwrapped output and native final replies. It calls the machine's Cherry only when stable inputs change, with a minimum interval, and sends semantic updates independently. Unchanged inputs generate checks/heartbeats, never another LLM call.

The v1 summary protocol binds entries to machine + space + pane + task ID. Snapshot and semantic streams are independent: no matching report timestamp or sequence is required. A delayed semantic update (up to 30 days) is assigned to its original UTC observation hour, including when its task is no longer current. Its evidence references must resolve to daemon facts collected for that same Pane/task; empty references are explicitly unverified interpretations. It cannot submit or replace Git/test/deployment facts.

A stable manager ID and durable increasing sequence serialize each machine's semantic writer. Identical sequence/body retries acknowledge without refreshing freshness; a reused sequence with different content conflicts. Sequences at or below the high-water mark are rejected once the receipt window expires. A different writer cannot silently take over. An accepted batch is atomic. Entries are unique by space + pane + task, so old-task updates and current-task checks may share a batch. Only changed semantic content appends a record; timestamp-only checks and identical interpretation updates do not add hourly history. The content hash covers taskId + the complete semantic summary, not observation time.

The DO stores semantic records independently of deterministic current state. Latest pointers are per Pane/task; newer sequence with older observation cannot roll back a more recent interpretation or freshness. Current view resolves the daemon's task ID first. Old tasks remain visible in hourly history and can only appear as superseded when no interpretation exists for the new task. Checks require the daemon's current exact fact basis, current task, a snapshot newer than 90 seconds and observations newer than five minutes; they cannot refresh stale facts. Native activity and Git changes immediately make the interpretation stale. Manager connection freshness is separate.

Changed semantic records are atomically stored in DO and its D1 outbox. Idempotent outbox writes replicate immutable history to D1. The API acknowledgement confirms DO persistence even during D1 outage. Existing report archives and hourly AI aggregation remain paused.

Manager transport failure preserves pending batches. Private state and input files use 0700 directories / 0600 files. Tokens never enter LLM input, summary bodies, browser persistence or D1. Context from terminals is untrusted data, not executable instructions. A single-instance lock prevents overlapping Manager runs; the daemon never waits for the LLM.

## Data contracts

Daemon `POST /api/v1/reports` keeps `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "reportId": "unique-retry-stable-id",
  "capturedAt": "2026-09-19T10:00:00.000Z",
  "machine": { "id": "mac-one", "name": "Mac", "platform": "darwin", "collectorVersion": "0.4.0", "telemetry": "CPU, RAM, disk, uptime and loopback ports" },
  "spaces": [{ "id": "default:w1", "session": "default", "name": "Eagle", "objective": "...", "tabs": [{ "id": "w1:t1", "name": "Build", "panes": [{ "id": "w1:p1", "agent": "codex", "hint": "working", "task": { "id": "native-task-hash", "title": "...", "requiresDeployment": true }, "rect": "normalized x/y/width/height", "evidence": "native final/Goal/activity, Git, process facts with observedAt/taskId/revision" }] }] }],
  "warnings": []
}
```

The shape above abbreviates large nested objects. `src/shared/schema.ts` is the executable, strict contract. Codex native final replies and turn/tool activity are collected; Grok/Pi final messages are read from bounded native files when their session identity matches the running harness. Native tests/deployment claims stay unverified. Unsupported harnesses bind to terminal/session identity; an animated title never creates a new task.

Manager reads `GET /api/v1/agent-state`, authenticated with the same machine credential, and posts:

```json
{
  "protocolVersion": 1,
  "machineId": "mac-one",
  "managerId": "cherry",
  "sequence": 42,
  "sentAt": "2026-09-19T10:00:30.000Z",
  "updates": [{
    "spaceId": "default:w1", "paneId": "w1:p1", "taskId": "native-task-hash",
    "basis": ["sha256-of-daemon-evidence"], "observedAt": "2026-09-19T10:00:00.000Z",
    "summary": {
      "task": "Implement real-time Pane summaries", "phase": "verify",
      "progress": "Live Manager upload is working",
      "outcomes": [{ "kind": "test", "text": "Terminal claims tests passed; no independent receipt", "evidenceRefs": [] }],
      "blocker": null, "nextStep": "Verify production",
      "rationale": "Native activity and Git indicate work continues", "evidenceRefs": ["sha256-of-daemon-evidence"]
    }
  }],
  "checks": []
}
```

Hashes are 64 lowercase hex digits; illustrative placeholders above must be replaced by `evidenceKeys`. `checks` entries have the same binding/basis/observedAt but omit `summary`. Evidence source, kind, status, revision and content are hashed; routine Git/process sampling timestamps are excluded. The immutable history stores the original evidence objects, including timestamps/revisions. Raw recent-unwrapped text is never added to this protocol.

## DO storage and hourly queries

All hour keys use UTC: `observedAt.slice(0,13) + ":00:00.000Z"`. An upload spanning multiple hours splits entries by their observation hours, independently of `sentAt` / receipt time. `source` is stamped by the server as `{managerId,protocolVersion}`; `contentHash` is server-computed SHA-256. Evidence objects retain their own original observation time and revision.

| DO record/key | Purpose / index |
| --- | --- |
| KV `current`, `fact-keys` | daemon's current deterministic snapshot and evidence index; semantic updates never overwrite them |
| SQLite `receipts` | report-ID deduplication, separate from semantic sequence |
| SQLite `fact_evidence` | known facts keyed by `(pane_key,hash)`, task-bound, original payload; supports delayed semantic citations |
| SQLite `semantic_records` | immutable semantic changes with seq, event_id, UTC hour, space/pane/task IDs, Manager sequence, observed/received times, content hash, source, payload |
| `semantic_hours` index | `(hour DESC,seq DESC)` for machine-level hourly aggregation |
| `semantic_pane_hours` index | `(space_id,pane_id,hour DESC,observed_at DESC,seq DESC)` for Pane drilldown |
| SQLite `semantic_current`, `live_tasks` | latest interpretation per `(space_id,pane_id,task_id)`; checks update freshness only; daemon live task pointers are protected from historical retention |
| KV `manager`, SQLite `summary_receipts` | semantic writer/high-water heartbeat and last 128 idempotent batch receipts |
| SQLite `summary_outbox` | durable D1 delivery queue, max 1,000 pending updates with backpressure; alarm retries |

Access-protected query API:

- `GET /api/v1/semantic-hours?machine=M` groups all machine semantic changes by UTC hour. Optional `space=S&pane=P` narrows scope. Returns `{hours:[{hour,count,latest}],nextCursor,retention}`.
- Add `hour=2026-09-19T10:00:00.000Z&mode=latest` for the most recent observation in that hour (sequence breaks equal-time ties).
- Add `hour=...&mode=all` for every record in the hour, paginated by DO record `seq` descending. `limit` is 1–100, default 12. `before` is exclusive: UTC hour for bucket pagination, integer seq for records.
- Each record includes `{seq,hour,contentHash,source,receivedAt,value}`; `value` includes `paneId`, `taskId`, Manager sequence, `observedAt`, summary and original evidence.
- `GET /api/v1/summary-history?machine=M&space=S&pane=P` reads the independent D1 archive, including older replicated records. D1 and DO cursors are distinct.

DO keeps 30 days from receipt, at most 10,000 semantic change records per machine (whichever expires first). Records still in the outbox are protected from deletion until D1 acknowledges them; backpressure bounds the extra queue. Inactive task pointers use the same 30-day / 10,000-entry bound; pointers for the current live inventory (at most 1,000 Panes) remain pinned so delayed historical tasks cannot evict current interpretations. Fact attestations retain 30 days / 50,000 entries; an expired reference is rejected rather than invented. Inputs observed over 30 days ago or more than 30 seconds in the future are rejected. D1 replicas currently retain history without automatic deletion. Retention is enforced on collection, semantic writes and history reads; an idle object's expired rows are removed on its next access.

UI polls DO current state every five seconds, keeps mounted content while refreshing, and shows UTC hour buckets with their latest summary and count. Expanding a bucket fetches all its records with pagination. History polling every 15 seconds updates counts and records without clearing loaded content. This same UTC hour key is the future aggregation unit; no hourly AI job is enabled yet.

## Continuous Manager

Run daemon and Manager as separate supervised processes:

```sh
eagle-agent watch
eagle-agent manager-watch
```

Manager uses the same secure config, with optional `manager: {"id":"cherry","minIntervalSeconds":120,"batchSize":8}`. `command` may be an argv array for another manager executable that consumes the JSON instruction on stdin and returns only the requested JSON array on stdout. The default uses the existing Cherry profile/model with tools disabled, a one-turn budget and a 65-second subprocess deadline; it does not replace your model configuration. Recent output is limited to 100 unwrapped lines / 12,000 characters per Pane, redacted before inference. Unreadable Panes do not refresh. Changed inputs are fairly batched, with a persistent per-Pane attempt cooldown, including failures; unchanged inputs send checks with no LLM call. A process lock prevents overlapping runs for a configuration.

State lives in `manager-MACHINE_ID/` alongside the config. Keep this private directory when restarting/upgrading: it holds sequence, cached interpretations and the exact pending batch. Network/auth/5xx failures preserve pending data; entry-specific binding/evidence failures return the rejected task key; Manager isolates that entry as `rejected-SEQUENCE.json` and immediately retries the remaining valid interpretations under a new sequence without another model call. Schema/sequence/writer conflicts quarantine the batch; the next cycle re-reads authoritative state. Never reset sequence or change manager ID to conceal a conflict. Different machines use independent state directories. Stop the old Manager before moving its configuration to another host.

For Cherry Cron instead of a separate service, put a script under Cherry's profile scripts directory that runs `eagle-agent manager-once` with absolute paths and `EAGLE_CONFIG`, then register it with `cherry cron create 'every 1m' --script SCRIPT --no-agent --deliver local --failure-deliver local`. Verify the installed CLI's `cron create --help` for schedule syntax. Do not schedule an unrestricted agent prompt every 30 seconds. The script's own change detector decides whether Cherry needs to run. Pick service or Cron, not both.

Only semantic Pane history is enabled. Hourly machine summaries and historical whole-report writes remain paused.
