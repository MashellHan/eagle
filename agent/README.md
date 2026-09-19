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

## Continuous Pane summaries (Cherry / Manager)

Run `eagle-agent manager-once` to validate one semantic cycle, then supervise `eagle-agent manager-watch` as a separate process alongside `watch`. A configured Cherry CLI must be on PATH. It uses the existing profile/model with tools disabled; the daemon never waits for the LLM. Stable inputs only refresh heartbeats; changed inputs have a persistent 120-second minimum per Pane/task. Each structured summary describes task, phase, progress, outcomes, blocker, next step and rationale with daemon evidence references.

Optional config: `"manager": {"id":"cherry","minIntervalSeconds":120,"batchSize":8}`. Other management Agents can use a `command` argv array reading the instruction on stdin and returning JSON. Preserve `manager-MACHINE_ID/` beside the secure config across upgrades. Pending uploads, sequence and cooldowns survive restarts. Never run multiple writers for one machine.

Eagle shows current semantics plus expandable UTC hourly history from each machine DO. Multiple changes per hour are retained with task ID, sequence, observation time, source and content hash. Late old-task updates stay historical. DO keeps 30 days / 10,000 changes; D1 retains the archive. Snapshot and semantic streams never overwrite each other. Tests/deployment claims from a terminal remain unverified until independent facts support them.

Protocol, conflict/retention rules and Cherry Cron alternative: https://github.com/nocoo/eagle/blob/main/docs/PANE-SUMMARIES.md
Reusable Skill: https://github.com/nocoo/eagle/blob/main/skills/eagle-report/SKILL.md
