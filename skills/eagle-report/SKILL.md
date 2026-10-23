---
name: eagle-report
description: Connect a machine to Eagle and continuously report all Herdr Panes through the deterministic daemon. Use for machine onboarding, full-inventory reporting, credential rotation, service supervision and reporting recovery.
---

Install `@nocoo/eagle-agent@1.0.0` with Node 24+ and Herdr:

```sh
npm install -g @nocoo/eagle-agent@1.0.0 --registry=https://registry.npmjs.org
# If npm is unreachable, prefer Tencent Cloud:
npm install -g @nocoo/eagle-agent@1.0.0 --registry=https://mirrors.cloud.tencent.com/npm/
eagle-agent --version
```

Choose one install command; mirrors may lag (`404` / `ETARGET`). Keep HTTPS and the pinned version. The Connect prompt supplies the machine-scoped credential. Keep `~/.config/eagle/agent.json` mode 0600, directory 0700; `EAGLE_CONFIG` selects another file. Preserve existing settings when rotating credentials. Never put a token in argv, terminal output, source, evidence or database. Website authentication is Cloudflare Access; reporting uses the machine Bearer at `https://eagle-ingest.hexly.ai`.

## Continuous reporting

First run `eagle-agent once`, then supervise `eagle-agent watch`. Use user launchd/systemd services with absolute executables and the required PATH. Add `eagle-agent realtime-watch` only when the user wants remote terminal viewing and input; it is a separate optional service that reuses the same 0600 configuration and must not run twice for one configuration.

The daemon collects every running local Herdr session and every Space/tab/pane, not only the focused tab. Reports are complete replacements: a newer report removes closed Spaces, and stopped sessions stay visible as `availability:unavailable`. Each report carries deterministic evidence only — native final replies, Goal, Git revision, test and deployment receipts, and process facts. Lifecycle badges and completion claims are weak hints; a terminal's final answer never certifies tests or deployment on its own.

## Storage and recovery

Each machine has one SQLite-backed Durable Object holding the current snapshot, resource samples and 48 hours of daily-report inputs. Receipts make retries idempotent; a success acknowledgement means DO persistence, not D1 insertion. Heartbeats refresh liveness only and never append inventory. Whole-snapshot D1 history remains paused; AI daily reports are archived in D1.

Reports stay on disk in the 0600 spool until acknowledged or explicitly quarantined. Network, 429, 5xx and authentication failures preserve the queue for an idempotent retry with the same report ID and body; do not delete unacknowledged data to make the queue look healthy. Malformed bodies and reused-ID conflicts move to `spool/rejected/` and raise a heartbeat warning. Only a newer valid complete report clears that warning.

After setup, verify actual all-session Space/live-Pane counts, the latest capture time in Eagle and an empty pending spool. A running process or a green service state alone does not prove reporting works.
