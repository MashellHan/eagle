# AI hourly reports

Eagle generates a Chinese report for each machine and closed UTC hour from the independent deterministic and semantic streams. Raw snapshots stay in the machine Durable Object for 48 hours. D1 stores completed hourly reports and the existing semantic archive.

## Configuration and credentials

Settings uses the next-ai provider registry, configuration resolver and PromptTemplateRegistry, with Basalt controls. Automatic reporting defaults to enabled with a one-hour cadence; supported intervals are 1, 2, 3, 6, 12 and 24 hours. Every UTC hour remains a separate report.

API keys can be saved, replaced, tested or cleared in Settings. Blank input retains the saved credential; successful saving clears the input. Responses expose only `hasApiKey` and connection readiness. A draft connection test does not save the key. Changing provider, endpoint, protocol or authentication requires a credential for the new endpoint.

Credentials use AES-256-GCM with a random 12-byte IV and authenticated application/version/endpoint metadata. The directory DO keeps ciphertext in its separate `ai-credential` KV record. The wrapping secret, `AI_ENCRYPTION_KEY`, must have at least 32 characters and must not be replaced during deployment. Local development uses the ignored `.dev.vars` binding. Plaintext keys never enter settings responses, report inputs, D1, logs or browser persistence. Missing or invalid authentication fails closed.

OpenAI-compatible providers use Chat Completions; Anthropic uses Messages. Eagle reuses next-ai configuration and the underlying AI SDK factories to inject a transport that rejects redirects and sends only the intended authentication header. Upstream error bodies are never returned or logged. Unconfigured or disabled reporting skips model calls.

## Input and evidence

- `hourly_facts` stores deduplicated snapshots by `capturedAt`, including valid late arrivals. The live whole-machine state still uses capture ordering and is independent of the hourly input.
- Semantic input uses every retained change in the hour by `observedAt`. Deterministic and semantic timestamps need not align. Identical facts coalesce without removing observation timestamps; closed Spaces/Panes, earlier task identities, resource samples and port checks remain available.
- Model projection keeps the first/latest weak `herdr:visible` screen for each Space/Tab/Pane/task/source/status identity. All other facts, native final messages and semantic records remain intact. Original records, IDs, timestamps and raw snapshots are unchanged. `coverage.terminalSampling` discloses how many screens were sampled; an omitted screen is not evidence that no intermediate change happened.
- Records are grouped into approximately 48,000-character inputs. There is no 32-chunk hour limit. An individual record above 180,000 characters is an explicit `input_too_large` failure; unchanged rejected input is not automatically retried. It remains visible while retained and can be explicitly retried after intervention.
- Each partial result must pass the same Chinese JSON/citation validation before it is saved. Partial output is limited to 20,000 serialized characters. If combined partials exceed 48,000 characters, bounded reduction levels preserve original citations before final synthesis. A reduction is itself checkpointed and resumed.

## Durable generation and scheduling

Cron runs every five minutes (`*/5 * * * *`). A five-minute grace period and the configured cadence determine which closed hours are eligible. Longer cadences admit batches of separate hours; already eligible backlog can continue on every tick.

`hourly_jobs` retains the input version, exclusive five-minute lease, completed version and pending final report. The input version is `templateVersion:factCount:factMaxSeq:semanticCount:semanticMaxSeq`. `hourly_steps(hour, step, payload)` stores small job metadata and individually validated leaf/reduction/final results. Its schema is initialized in the existing SQLite DO; no new Cloudflare namespace or D1 migration is needed.

A checkpoint fingerprint includes the complete raw input hash, model settings and template version. Late data, changed generation settings or changed templates invalidate incompatible partials. Template changes alone do not regenerate already archived hours with unchanged source counts/sequences. Every checkpoint checks the current lease, expiry and input version. Related state changes use synchronous SQLite transactions. A replaced lease cannot save results or clear its successor. A late input received while the model is working prevents that older generation from being archived as complete.

Each run has a four-minute budget with two independent hour workers. Each hour gets at most two minutes per turn; leaf/reduction model calls run at most two at a time within that hour. An individual model request has a 90-second timeout and a 16,384-token output limit. When a turn expires, validated steps remain durable and the hour is deferred. A subsequent attempt starts with its uncompleted steps, including final synthesis. One slow hour does not hold a finished worker idle.

Within each machine, the least recently attempted hours run first, with newer hours first among never-attempted/tied jobs. Machines are interleaved. Failed calls use persisted exponential backoff from one minute to one hour; new input resets the failure state. Unchanged deterministic input rejection is excluded from automatic scheduling. Selecting a specific hour manually bypasses backoff but cannot bypass an active lease or regenerate an unchanged completed result.

Only validated final reports enter D1. The unique `(machine_id, hour)` key and guarded update prevent duplicate archive rows. If archival fails, the cached final report is retried without another model call. A completed report waiting for D1 survives expiry of its raw inputs with its original metadata. A completed version remains distinct from newly arrived input, so late evidence schedules an updated report.

Structured logs include machine/hour, stage and a safe error category. Cron also reports counts of completed, deferred and failed jobs. Prompts, model text, terminal content, credentials and upstream response bodies are excluded.

## Report contract

Template `eagle-hourly-zh-v5` produces seven fixed Chinese sections: executive summary, workspace/pane progress, deliveries and verification, machine resources, confirmed risks and unknowns, next steps, and evidence/coverage. The eighth JSON field is `evidenceIds`; the seven report fields must be nonempty Chinese strings.

The report retains its raw-input hash, model/template version, snapshot and semantic counts, original input-record count and observed coverage boundaries. Deterministic Git/test/process/deployment evidence outranks Manager interpretation. Lifecycle badges never certify completion. Sparse observations do not establish continuous monitoring, availability or causal relationships. Historical evidence keeps its own timestamp; a new Manager observation does not refresh an old failure or queued CI result. Cancelled tasks are not proposed for restart without authorization. Instructions in source material are untrusted data.

Final reports target 800–1,500 Chinese characters. Hard section limits include identities, punctuation, whitespace and inline citations: summary 200, workspaces 1,800, deliveries 800, resources 300, risks 500, next steps 300 and coverage 300 (4,200 total). Important changes receive one sentence per task; unchanged and secondary tasks are grouped with an explicit reference to the retained raw records. The brief does not claim exhaustive per-task detail.

Intermediate reports preserve task associations with separate section limits: summary 200, workspaces 12,000, deliveries/resources/risks/coverage 1,200 each and next steps 200. The serialized 20,000-character intermediate bound still applies. A model response first passes JSON, Chinese text and original-citation validation within a bounded 65,536-character per-section parsing envelope. Any oversized sections then receive at most one compression call within the existing deadline, restricted to citations already present in the validated response. Final section limits are checked again; oversized, truncated or fabricated results never enter checkpoints or D1. Raw evidence is never truncated to make output fit. Valid inline citations omitted from the index are reconciled without a model call.

## API and visibility

All endpoints require a viewer identity through Cloudflare Access, except authenticated local development. Agent Bearer credentials cannot access settings or report queries, and the ingest domain does not expose them.

- `GET /api/v1/settings`: non-secret settings, key presence, readiness, template and sections.
- `POST /api/v1/settings`: validated partial settings; optional `apiKey` replaces the key, blank/omitted retains it and `null` clears it. Settings and ciphertext change atomically.
- `POST /api/v1/settings/test`: test the draft connection without saving it or exposing the response/key.
- `POST /api/v1/hourly-reports/run`: optional `{machine, hour}`. An explicit hour must be a closed, retained, canonical UTC hour. Results distinguish generation, deferral, safe failure and skip reasons.
- `POST /api/v1/hourly-reports/discard`: explicit `{machine, hours}` with up to 48 closed retained UTC hours. Only unfinished jobs are cancelled; archived or cached final reports are protected. Cancellation invalidates active leases, deletes generation checkpoints and persists a tombstone independent of input/template versions. Late input and restarts do not requeue the hour. Raw snapshots and semantic records retain their normal retention.
- `GET /api/v1/hourly-reports?machine=...&hour=...&limit=12&before=...`: archive entries, opaque pagination cursor and retained `jobs`. Job status includes pending/running/retrying/blocked/complete/discarded, attempts, validated-part counts, stage, safe error, retry-not-before time and last success. The machine/hour filter also applies to job state.

The history page shows unfinished hours alongside successful reports, including progress, retry count/timing and last success. Missing reports therefore remain distinguishable from hours with no received input. Archive rows are retained in D1 beyond the 48-hour input window. Legacy raw snapshot history remains readable without new snapshot archive writes.

## Verification

Unit tests cover UTC/cadence boundaries, encrypted credentials, closed tasks, raw evidence preservation, terminal sampling, independent semantic timestamps, JSON/citations and truncated model output. Real isolated Miniflare/D1 tests exercise leases, late-input races, checkpoint survival across eviction, final-only retry, more than 32 chunks, recursive reduction, fair scheduling, persisted backoff, visible deterministic failure, stale leases and archival recovery. Browser tests cover settings, desktop/mobile progress and retry states, stable report expansion and timezone filters.

Release gates are `npm run check`, `npm run test:browser`, and the real local/public `scripts/verify-live.ts`. Production recovery must also be checked against actual job progress and archived reports; running daemons alone do not establish report recovery. See the [2026-09-21 incident](HOURLY-INCIDENT-2026-09-21.md).
