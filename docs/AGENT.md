# Reporting from another machine

The collector is read-only toward Herdr/Git. It never prompts agents, presses keys, runs repository tests, or changes workspaces. Use a management agent (Cherry or equivalent) to interpret outcomes and supply structured receipts.

## Secure config

Create `~/.config/eagle/agent.json`, directory mode 0700 and file mode 0600:

```json
{
  "url": "https://eagle-ingest.hexly.ai",
  "machineId": "your-machine",
  "machineName": "Your machine",
  "token": "REPLACE_WITH_MACHINE_SECRET",
  "intervalSeconds": 30,
  "watchPorts": [{ "name": "Raven", "port": 7024 }],
  "evidenceFile": "/absolute/private/path/evidence.json"
}
```

The matching platform secret is `AGENT_TOKENS`, a JSON map of machine IDs to random tokens of at least 32 characters. Keep the existing map when adding a machine. Upload via `wrangler secret bulk` from an owner-readable file, and deliver each machine only its own token. Website viewing uses Cloudflare Access; it has no Eagle viewing token. Revoke one machine by removing its entry and deploying the updated secret. Tokens never belong in reports, documentation, Git, shell history or D1.

Clone/install Eagle (`npm ci`), then:

```sh
node agent/cli.ts collect /private/path/report.json
node agent/cli.ts upload /private/path/report.json
node agent/cli.ts once
node agent/cli.ts watch
node agent/cli.ts heartbeat
```

`EAGLE_CONFIG` selects another 0600 config. `once` collects, atomically writes a 0600 spool entry, then drains pending reports. Network/429/5xx failures retry with backoff using the same report body and ID; 400/409/413/415 或损坏 JSON 会移入 `spool/rejected/` 保留，并在心跳中提示；后续有效快照继续发送。401/403 和网络故障保留整个待发送队列等待修复。Reports remain on disk until acknowledged or explicitly quarantined. At 1000 pending entries the spool first attempts to drain before collecting more; it never deletes unacknowledged data. An explicit auth/schema failure requires operator correction; do not discard old reports to make the queue green. `watch` repeats after the configured interval. Alternatively run `once` with launchd/systemd at the same interval; prevent overlapping invocations.

Automatic collection covers **every running local Herdr session** and every Space/tab/pane, not just the active tab. A whole-session error preserves the previous inventory. Stopped sessions retain cached Spaces with `availability:unavailable`; they cannot count as live or verified. The last validated report is cached as a 0600 file alongside the spool. The optional local Codex adapter uses `state_5.sqlite` and `goals_1.sqlite` in `codexDir` (default `~/.codex`), reads bounded transcript tails, and records native final replies and explicit activity. Unknown/changed store schemas fall back to terminal evidence. Raw command arguments and reasoning are never extracted. All outbound strings redact known credentials, common token formats, secret assignments and private-key blocks.

## Machine resources and watched ports

Collector 0.2.0 adds optional `machine.telemetry` to v1 snapshots. It samples CPU utilization across all logical cores over approximately 250 ms, CPU model/core count, 1/5/15-minute load average, total/free RAM, home-filesystem total/available space and system uptime. Memory usage is total minus free, which may include caches; it is not a memory-pressure measurement. Missing resources or disk measurements remain unknown. Values and their observation times are kept in the existing D1 report payload and returned by overview/history; no table migration is needed.

`watchPorts` is optional and defaults to an empty list. Each entry has `name`, `port` and optional `host` (`127.0.0.1` by default; `::1` is also supported). At most 32 unique host/port pairs can be configured. For Raven, 7023 is the dashboard and 7024 is the proxy; configure either or both. Checks run concurrently, each bounded to one second, and send no application data or credentials. Results distinguish TCP connect success, connection refusal, timeout and check error. A listening port does not prove business health or successful task deployment. The UI marks observations older than 90 seconds as historical.

Restart the collector after editing its configuration. For an upgrade, deploy the compatible Worker **before** restarting production collectors: old strict v1 servers reject the newly added telemetry field. Older agent reports without telemetry continue to work on the new server. The current preview is configured in `.local/agent-dev.json`; its Raven port check and resource snapshots go to the independent local D1.

## Manager evidence

`evidenceFile` is an atomically replaced JSON object keyed by `session:paneId`. Omit the config field if no file is provided. Each entry has a task and an evidence list; all data is validated with the same report schema:

```json
{
  "default:w1:p1": {
    "task": { "id": "release-123", "title": "Publish release 123", "requiresDeployment": true },
    "evidence": [
      { "kind": "goal", "status": "running", "summary": "Implementation complete; checking production", "source": "cherry:review", "observedAt": "2026-09-19T06:00:00.000Z", "taskId": "release-123" }
    ]
  }
}
```

First collect the live report and copy its pane.task.id into the manager entry. For Codex it is derived from the native session/turn; Grok and Pi use the latest native user prompt when available. A manager cannot replace this identity: stale IDs are ignored. Unsupported harnesses fall back to the session/title identity and require the manager to verify task continuity. Retain actual evidence timestamps; never renew old tests merely because the collector ran. Test and deployment receipts include the **tested/deployed full Git SHA**. `requiresDeployment:false` is valid for tasks that actually do not require publication. A terminal's final answer alone remains an unverified claim until the independent receipts agree.

Prefer a short human outcome: what changed, what remains, what needs a decision. Do not send entire scrollback, internal reasoning, environment dumps, or credentials. The UI defaults to this summary and allows inspecting evidence underneath.

## Installed on MBPM5MSFT

The production machine ID is `mbpm5msft`. Its macOS LaunchAgent at `~/Library/LaunchAgents/com.hexly.eagle-agent.plist` runs this checkout's `agent/cli.ts watch` every 30 seconds and restarts on failure. Configuration, the manager evidence file, durable spool, and `agent.stdout.log` / `agent.stderr.log` are under `~/.config/eagle/`. The website uses Cloudflare Access; the former viewer-token file has been removed. Machine Bearer credentials remain required for reporting.

```sh
# Restart after updating collector code:
launchctl kickstart -k gui/501/com.hexly.eagle-agent
# Stop reporting:
launchctl bootout gui/501 ~/Library/LaunchAgents/com.hexly.eagle-agent.plist
# Resume reporting:
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.hexly.eagle-agent.plist
```

These commands are for this machine's user ID 501. Other machines need their own token, identity, checkout path and service configuration. A valid success acknowledgement is required before a queued report is removed; malformed responses preserve the report for an idempotent retry.

On this Mac, launchd follows the existing macOS HTTPS proxy through `HTTPS_PROXY` and Node’s `NODE_USE_ENV_PROXY=1`. Other machines do not require a proxy. This avoids the OS resolver retaining a negative answer after a new reporting hostname is provisioned.
