# @nocoo/eagle-agent

Read-only Herdr inventory, task evidence, machine resources and named TCP port checks for Eagle. Requires Node.js 24+ and the Herdr CLI on macOS or Linux.

```sh
npm install -g @nocoo/eagle-agent
eagle-agent --help
```

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

The machine's Durable Object maintains current state. Unacknowledged reports remain in a private local spool; retries preserve their IDs. Older reports cannot roll back current state. Hourly summaries and new D1 archive writes are paused.

Optional `watchPorts`: `[{ "name": "Raven", "port": 7024 }]`. Only loopback TCP checks are supported; a listening port does not prove service or task health. CPU, RAM, disk and uptime are sampled automatically. Task status combines terminal summaries, goals, Git, tests, processes and deployment evidence; pane lifecycle badges are weak hints.

Detailed configuration and manager evidence format: https://github.com/nocoo/eagle/blob/main/docs/AGENT.md
