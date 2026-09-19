# API v1

All private responses are `Cache-Control: no-store`. Maximum streamed upload size is 1 MiB. Bodies use strict JSON schemas: unknown fields (including credential fields) are rejected. The machine identity in the payload must match the credential binding. IDs are opaque and scoped to machine + Herdr session; the agent uses `session:workspaceId` as Space ID.

| Endpoint | Authentication | Contract |
| --- | --- | --- |
| `GET /api/live` | Public | `{status,service,schemaVersion,revision,stateStore,historyWrites}`; probes the first configured machine DO, no inventory |
| `POST /api/v1/reports` | Machine Bearer | Full v1 report; 201 new / 200 duplicate / 409 reused ID with different content |
| `POST /api/v1/heartbeat` | Machine Bearer | `{schemaVersion:1,machineId,sentAt,warning?}`; requires initial report |
| `GET /api/v1/me` | Verified Access JWT | `{name,email,avatar,local}`; account and optional author-service profile |
| `GET /api/v1/overview` | Verified Access JWT | Server time, DO current state per machine, heartbeat, warning, revision, latest changes, pending machine IDs |
| `GET /api/v1/history` | Verified Access JWT | Existing D1 history only; optional `machine`, `space`, `before` cursor, `limit` 1–100 (default 20); entries and nextCursor |

Browser origin: `https://eagle.hexly.ai`, protected by the nocoo Access application. Local development viewing is unauthenticated. Machine origin: `https://eagle-ingest.hexly.ai`, which serves only the two ingestion endpoints and public health; all other paths are 404. The browser Access JWT is validated by the Worker, and is never accepted as a machine Bearer token. Legacy viewer Bearer credentials and Eagle session cookies no longer authorize requests.

Account email comes from the verified JWT payload, never an unverified email header. `/api/v1/me` queries `https://lizheng.blog/api/authors/profile` with the SHA-256 of the trimmed, lowercase email, forwarding no credentials. The lookup times out after 2.5 seconds and falls back to the account name with `avatar:null`; avatars must use HTTPS. Profile data is not persisted. Local development may use `LOCAL_USER_EMAIL` from `.dev.vars` and returns `local:true`; this setting cannot authorize production requests. Browser logout uses `/cdn-cgi/access/logout`.

## Machine telemetry

Report v1 now accepts optional `machine.telemetry` with `observedAt`, nullable `resources`, and `ports`. Resources include CPU model/core count/utilization/sample duration/load average, total/free memory bytes, nullable home-filesystem total/available bytes, and uptime seconds. Each port has a name, loopback host, port number, `checkedAt`, `status` (`open`, `closed`, `timeout`, `error`) and nullable successful-connection `latencyMs`. Unknown data is not zero. The validator rejects out-of-range values and duplicate watched endpoints. Existing v1 reports without telemetry remain valid; upgrade the server before enabling the new collector.

Telemetry is persisted with the current full snapshot in the machine's Durable Object. Overview returns it; new reports do not enter D1. Resource samples and port observations older than 90 seconds are shown as historical; TCP success never counts as task-deployment evidence.

## Current state and ordering

`MACHINES.getByName(machineId)` selects a SQLite-backed Durable Object. Each object stores exactly one complete `MachineView`: report, name, server receipt time, heartbeat time, collector warning, monotonically increasing revision, and the latest meaningful change summary with its original capture time. An identical snapshot does not refresh that change timestamp. No history payloads are retained in the object. Compact `(reportId, digest, seq)` receipt metadata preserves idempotency across arbitrary retries and restarts; this metadata grows with accepted reports.

`reportId` is generated once and persisted in the agent's local spool. Retries send the same body and ID. A synchronous SQLite transaction checks the canonical content hash, stores the receipt, and advances current state atomically. The existing acknowledgement `{accepted:true, duplicate, seq}` is unchanged, but `seq` is now a **per-machine upload receipt**, not a D1 history cursor. Different JSON object key ordering has the same hash. A conflicting ID returns 409 without touching current state or heartbeat.

Current state is ordered by `(capturedAt, reportId)`. Late reports are acknowledged without replacing current inventory, warning or change summary. Equal capture times use report ID as a deterministic tie-breaker. Capture timestamps more than five minutes ahead of the server are rejected. An authenticated retry updates contact time; freshness still checks the snapshot's original capture time. The server records receipt/heartbeat time itself.

Closing a Space is represented by its absence in a newer complete report. A collection failure preserves inventory and sends a warning heartbeat; an ordinary heartbeat or old retry cannot clear that warning. Only a newer complete report clears it. Stopped sessions retain cached Spaces marked `availability:unavailable`.

The `AGENT_TOKENS` secret's keys are the managed machine directory. A new key automatically provides a named object on first access; `pendingMachines` lists machines awaiting their initial report. The overview contains only configured machines and reads no D1 data. Removing a key revokes reporting and removes the machine from the active directory without deleting its object or old history; restoring the same ID restores access to its state. Failed DO reads fail the overview request, so the browser keeps its last complete fleet view rather than silently hiding a machine.

The browser polls current state every five seconds while visible. Existing cards, focus, search and open detail remain mounted during refresh. Latest changes come from DO state; history is fetched only on explicit navigation.

## History (paused)

New D1 writes, hourly Cron and AI summaries are deferred. Existing `reports` and `machines` tables remain untouched. `/history` continues reading existing reports using the original decreasing sequence cursor. Those cursors are independent of new DO upload receipts. No database migration or scheduled trigger is introduced in this revision.

On first deployment the DO namespace starts empty. Configured machines are marked as awaiting a report until their next successful full upload; old D1 snapshots remain accessible in history, never mislabeled as live DO state. Deploy the Worker before restarting upgraded collectors.

## Evidence semantics

Every evidence item includes `kind`, `status`, `summary`, `source`, `observedAt`, `taskId`, optional `revision`. Kinds: `summary`, `goal`, `git`, `test`, `process`, `deployment`. Statuses: `success`, `failure`, `running`, `waiting`, `unknown`.

Only current-task evidence from the preceding 24 hours (with up to five minutes of clock skew) participates. The newest observation of each kind wins. Explicit failure/waiting produces attention; an active Goal, process, test or deployment produces active. Verification requires success in summary/Goal/Git/tests and, when required, deployment. Git/tests/deployment must attest the same nonempty Git revision. A health endpoint answering 200 without revision evidence cannot certify deployment of a specific change.

This is evidence reconciliation, not an LLM oracle: the management agent is responsible for interpreting final conclusions and binding test/live receipts to the current task. Evidence is displayed with its provenance so the user can inspect the decision.
