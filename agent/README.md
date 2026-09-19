# @nocoo/eagle-agent

Read-only Herdr inventory, task evidence, machine resources and named TCP port checks for Eagle. Requires Node.js 24+ and the Herdr CLI on macOS or Linux.

## Download and install

Check `node --version`, `npm --version` and `herdr --version` first. Install Node.js 24+ from https://nodejs.org/en/download if needed, and have Herdr installed and running. No Eagle repository checkout, TypeScript compiler or npm login is required to install this public package.

Download and install the pinned release from the official npm registry:

```sh
npm install -g @nocoo/eagle-agent@0.4.0 --registry=https://registry.npmjs.org
```

**If npm is unreachable or times out, use the Tencent Cloud mirror first / npm 连不上时首选腾讯云镜像：**

```sh
npm install -g @nocoo/eagle-agent@0.4.0 --registry=https://mirrors.cloud.tencent.com/npm/
```

`--registry` applies only to this installation; it does not change your global npm configuration. Mirrors may take time to synchronize a new release: for `404` / `ETARGET`, retry later or use the official registry once reachable. Keep the pinned version, HTTPS and certificate verification. Eagle credentials are unrelated to npm and must never be sent to a registry.

Verify the installation before configuring the agent:

```sh
eagle-agent --version # expected: 0.4.0
eagle-agent --help
```

If the command is missing, ensure npm's global `bin` directory is on your PATH. Use a user-owned Node/npm installation if global installation fails with `EACCES`.

## Connect a machine

Open Eagle's **Connect** page, create a machine and copy its onboarding prompt. Give the prompt to the management agent on that machine. It contains a machine-scoped credential shown only once.

Store configuration at `~/.config/eagle/agent.json` (directory 0700, file 0600). `EAGLE_CONFIG` selects another file. `eagle-agent init` reads JSON from stdin and creates this file securely; it refuses to overwrite an existing file. Never pass a token in command arguments, commit it, print it, or include it in reports. Rotation requires updating the token in the existing secure configuration.

```sh
eagle-agent once
eagle-agent watch
eagle-agent collect /private/path/report.json
eagle-agent upload /private/path/report.json
eagle-agent heartbeat
```

`once` collects all running Herdr sessions and sends a complete snapshot. `watch` repeats every 30 seconds by default. Set up a user launchd or systemd service to keep it running across restarts, with the correct absolute executable paths and PATH for Node and Herdr. Do not run overlapping collectors for one configuration.

The machine's Durable Object maintains current state. Unacknowledged reports remain in a private local spool; retries preserve their IDs. Older reports cannot roll back current state. Semantic changes are retained independently in DO UTC hourly buckets and replicated to D1; whole-report archives and hourly AI aggregation remain paused.

Optional `watchPorts`: `[{ "name": "Raven", "port": 7024 }]`. Only loopback TCP checks are supported; a listening port does not prove service or task health. CPU, RAM, disk and uptime are sampled automatically. Task status combines terminal summaries, goals, Git, tests, processes and deployment evidence; pane lifecycle badges are weak hints.

Detailed configuration and manager evidence format: https://github.com/nocoo/eagle/blob/main/docs/AGENT.md

## Continuous Pane summaries

Eagle is agent-neutral. Reuse the machine's existing management Agent; **Hermes Agent is recommended, not required**. Cherry is one machine's local Hermes profile/alias, not a product or dependency to install. Do not search for or install an unrelated Cherry package. If no suitable Agent is configured yet, keep `eagle-agent watch` running and report that semantic setup is pending.

Set `manager.command` explicitly in the existing secure config, preserving its other fields. The command is an argv array, executed without a shell: it receives a UTF-8 instruction followed by bounded input JSON on stdin and must return the requested JSON array on stdout. Use the existing model/provider/profile, disable tools and avoid interactive prompts. A small adapter script can normalize another Agent's input/output. Eagle does not install an Agent or change its model configuration.

For an already configured Hermes, inspect `hermes chat --help`, locate its executable and replace the example path below. Only use flags supported by that installed version. The official project is https://github.com/NousResearch/hermes-agent; follow its installation instructions only if Hermes is actually needed. A working alternative Agent needs no Hermes installation.

```json
{
  "manager": {
    "id": "manager",
    "command": ["/absolute/path/to/hermes", "chat", "--query-file", "-", "--oneshot", "--quiet", "--toolsets", "none", "--ignore-rules", "--source", "tool", "--max-turns", "1", "--run-budget", "55"],
    "minIntervalSeconds": 120,
    "batchSize": 8
  }
}
```

This is a config fragment, not a replacement for `agent.json`. For a named Hermes profile, use its existing launcher/wrapper or documented profile selection; retain the same provider credentials and service environment. The example does not pass model/provider overrides or `--ignore-user-config`. For another Agent, replace the entire `command` array with its verified stdin/noninteractive invocation or adapter; do not reuse Hermes flags blindly. Keep credentials out of argv and model input.

Run `eagle-agent manager-once`, verify actual summaries, then supervise `eagle-agent manager-watch` separately from `watch` using absolute paths and the required PATH/profile environment. Alternatively schedule `manager-once` with the machine's existing cron/scheduler; verify that scheduler's syntax and do not run both schedulers. A single successful cycle does not provide continuous coverage.

Manager has a 65-second subprocess deadline and a persistent 120-second minimum per Pane/task. It interprets changed inputs only; stable inputs refresh freshness without another model call or history entry. Each summary describes task, phase, progress, outcomes, blocker, next step and rationale with deterministic evidence references. Neither Agent output nor a terminal completion claim certifies tests or deployment.

Preserve the existing `manager.id` and `manager-MACHINE_ID/` directory across upgrades, even if its old ID is `cherry`: IDs are durable writer identities, not executable names. Keep sequence, pending batches and cached summaries. When upgrading from 0.4.0's implicit Cherry default, explicitly configure the already working command and keep ID `cherry`; do not reset identity or install a different Agent.

Protocol, independent DO streams, hourly history and retention: https://github.com/nocoo/eagle/blob/main/docs/PANE-SUMMARIES.md
Reusable Skill: https://github.com/nocoo/eagle/blob/main/skills/eagle-report/SKILL.md
