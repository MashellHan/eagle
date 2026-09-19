# API v1

All private responses are `Cache-Control: no-store`. Maximum streamed upload size is 1 MiB. Bodies use strict JSON schemas: unknown fields (including credential fields) are rejected. The machine identity in the payload must match the credential binding. IDs are opaque and scoped to machine + Herdr session; the agent uses `session:workspaceId` as Space ID.

| Endpoint | Authentication | Contract |
| --- | --- | --- |
| `GET /api/live` | Public | `{status,service,schemaVersion,revision}`; D1 connectivity only |
| `POST /api/v1/reports` | Machine Bearer | Full v1 report; 201 new / 200 duplicate / 409 reused ID with different content |
| `POST /api/v1/heartbeat` | Machine Bearer | `{schemaVersion:1,machineId,sentAt,warning?}`; requires initial report |
| `GET /api/v1/me` | Verified Access JWT | `{name,email,avatar,local}`; account and optional author-service profile |
| `GET /api/v1/overview` | Verified Access JWT | Server time, latest report per machine, last heartbeat and collector warning |
| `GET /api/v1/history` | Verified Access JWT | Optional `machine`, `space`, `before` cursor, `limit` 1–100 (default 20); entries and nextCursor |

Browser origin: `https://eagle.hexly.ai`, protected by the nocoo Access application. Local development viewing is unauthenticated. Machine origin: `https://eagle-ingest.hexly.ai`, which serves only the two ingestion endpoints and public health; all other paths are 404. The browser Access JWT is validated by the Worker, and is never accepted as a machine Bearer token. Legacy viewer Bearer credentials and Eagle session cookies no longer authorize requests.

Account email comes from the verified JWT payload, never an unverified email header. `/api/v1/me` queries `https://lizheng.blog/api/authors/profile` with the SHA-256 of the trimmed, lowercase email, forwarding no credentials. The lookup times out after 2.5 seconds and falls back to the account name with `avatar:null`; avatars must use HTTPS. Profile data is not persisted. Local development may use `LOCAL_USER_EMAIL` from `.dev.vars` and returns `local:true`; this setting cannot authorize production requests. Browser logout uses `/cdn-cgi/access/logout`.

## Snapshot and ordering

`reportId` is generated once before transmission and persisted in the local spool. Retries send the same body and ID. A unique `(machine_id, report_id)` constraint and canonical content hash enforce idempotency. D1 `batch` atomically inserts history and conditionally advances the current pointer. Concurrent retries cannot create two reports. Different JSON object key ordering produces the same hash.

Current state is ordered by `(capturedAt, reportId)`; a delayed older report enters history without replacing a newer snapshot. Equal capture times use report ID as a deterministic tie-breaker. Timestamps more than five minutes ahead of the server are rejected. All sessions must be collected successfully before the inventory can replace the previous snapshot; any missing session aborts the cycle and sends a warning heartbeat. Closing a Space is represented by its absence in a later complete inventory. Stopped sessions retain cached Spaces marked `availability:unavailable`. A heartbeat without a warning cannot clear a collection failure; only a newer complete report clears it.

History pagination orders by received sequence (strictly decreasing integer cursor); capture time is shown separately. Changes compare the prior capture for that machine, so late delivery is not mistaken for a rollback. Space history filters snapshots containing that Space. Closure events are visible in machine history.

The initial release preserves full history. D1 storage growth is proportional to machines × report size × frequency; no silent retention deletion runs. Set collection intervals explicitly for large fleets and monitor database size before increasing fleet size. Future archival can be added without changing report v1.

## Evidence semantics

Every evidence item includes `kind`, `status`, `summary`, `source`, `observedAt`, `taskId`, optional `revision`. Kinds: `summary`, `goal`, `git`, `test`, `process`, `deployment`. Statuses: `success`, `failure`, `running`, `waiting`, `unknown`.

Only current-task evidence from the preceding 24 hours (with up to five minutes of clock skew) participates. The newest observation of each kind wins. Explicit failure/waiting produces attention; an active Goal, process, test or deployment produces active. Verification requires success in summary/Goal/Git/tests and, when required, deployment. Git/tests/deployment must attest the same nonempty Git revision. A health endpoint answering 200 without revision evidence cannot certify deployment of a specific change.

This is evidence reconciliation, not an LLM oracle: the management agent is responsible for interpreting final conclusions and binding test/live receipts to the current task. Evidence is displayed with its provenance so the user can inspect the decision.
