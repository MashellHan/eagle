# Eagle v1

Owner: Codex integrates on main; Grok/Pi in this Space provide read-only research/review.

- Vite + React 19 + Basalt 2.1.8, Biome, TypeScript exactly 7.0.2.
- Worker with private D1 snapshots, versioned strict schema, per-machine Bearer secrets; viewer uses a separate secret and an expiring HttpOnly session. Tokens are never D1 fields.
- Full inventory includes every Space/tab/pane and normalized layout. Explicit evidence combines final summaries, goals, Git, tests, processes and deployment checks. Lifecycle badges are weak hints. Unknown evidence remains unknown.
- Transactional, content-checked idempotency; stale delivery cannot rewind current state. Independent heartbeat and stale-machine indicator.
- Executive overview, topology, pane evidence drilldown, changes and paginated history. Browser refresh every five seconds with failure and freshness visibility.
- Node agent with durable retry spool and reusable Skill, secrets in a 0600 config. No arbitrary commands from remote reports.
- Local HTTPS eagle.dev.hexly.ai → Vite 7053 → Worker 37053. Tests use 17053/27053. Publish eagle.hexly.ai.

## Test-first slices

1. Schema and evidence reducer adversarial tests → implementation.
2. Actual SQLite/D1 API tests: auth, validation, dedup/conflict/concurrency, late reports, heartbeat, history → implementation.
3. Collector/redaction/retry tests → real inventory pipeline.
4. Browser behavior tests → Basalt app; desktop/mobile visual inspection.
5. Authenticated real local and production capture → upload → D1 → browser; repeat upload; unauthenticated access; ongoing reporter.

## Checkpoints

Every 15 minutes from 2026-09-19 13:43 Asia/Shanghai, record what a user can actually see, the first broken hop and the next correction in CHECKPOINTS.md. No milestone is considered complete solely from a pane badge.
