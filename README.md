# Eagle

Private, evidence-led overview of every Herdr Space on every reporting machine.

**Production:** https://eagle.hexly.ai · **Local:** https://eagle.dev.hexly.ai

Vite + React 19 + **@nocoo/basalt 2.1.8**, TypeScript **7.0.2**, Biome. Cloudflare Worker serves the SPA and authenticated API; D1 keeps full snapshots and history. The Node management agent runs locally on each machine. No remote terminal control is exposed.

## Run

Requires Node 24+ (native TypeScript and SQLite), npm, Herdr 0.9.1+, and Cloudflare credentials for deployment.

```sh
npm ci
# Add AGENT_TOKENS and VIEWER_TOKEN to ignored .dev.vars (chmod 600).
# AGENT_TOKENS='{"your-machine":"a-random-token-of-at-least-32-characters"}'
# VIEWER_TOKEN='a-separate-random-token-of-at-least-32-characters'
npm run db:local
npm run dev:api
# A second terminal:
npm run dev
```

Local Vite is **127.0.0.1:6001**, Worker is **127.0.0.1:36001**, inspector is **46001**. Caddy's existing `eagle.dev.hexly.ai` block proxies 6001 with the machine's mkcert certificate. Browser tests use **26001**. The **16001** suffix is reserved for standalone API E2E. Restart Wrangler after changing secrets.

```sh
npm run check
npm run test:browser
# Actual machine → authenticated upload → D1 → Chromium, no mocked requests:
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node scripts/verify-live.ts
```

`verify-live.ts` reads credentials from `.local/dev-secrets.json` and `.local/agent-dev.json` by default. Override `EAGLE_VERIFY_ORIGIN`, `EAGLE_VERIFY_SECRETS`, and `EAGLE_CONFIG` for production. Screenshots and a sanitized verification receipt stay under ignored `.local/`. It checks anonymous rejection, duplicate upload, every real Space, automatic updates, history, and mobile layout.

## Machine agents

Copy [the reporting Skill](skills/eagle-report/SKILL.md) to Cherry or any other local management agent. See [the agent contract](docs/AGENT.md) for credentials, periodic execution, structured evidence, retries and deployment receipts. The checked-in [v1 JSON Schema](public/report-v1.schema.json) is generated from the TypeScript validator; cross-object uniqueness checks additionally run on the server.

Agents use **per-machine Bearer tokens** stored only in their 0600 config and the Worker's `AGENT_TOKENS` secret. The separate `VIEWER_TOKEN` signs a 12-hour Secure, HttpOnly, SameSite=Strict browser session. Browser storage and D1 contain no authentication tokens. Rotating the viewer secret invalidates all existing sessions. The private API never supports CORS.

## Interpretation

Herdr `idle`, `done` and `blocked` are weak hints. A verified task requires matching current-task final summary, Goal, Git revision and test evidence; deployment evidence is also required when the task says so. A running Goal or actual tool-execution event takes priority over apparent completion. Conflicting or missing evidence remains visible. An agent process merely being present does not prove activity. Old task evidence, stale evidence and mismatched revisions never certify completion.

Codex's local thread/goal stores are optional adapters; only final replies and lifecycle events are extracted. Reasoning and tool arguments are excluded. Other harnesses use a bounded terminal excerpt and manager-supplied structured evidence. Text evidence is redacted before spool/upload. Heuristics cannot guarantee redaction of arbitrary secrets: managers should send concise summaries, and use the Skill to provide verified test/deployment receipts instead of raw terminal dumps.

The dashboard refreshes every **5 seconds** while visible and refreshes immediately on return. After 90 seconds without heartbeat or 5 minutes without a snapshot, current-state cards explicitly show stale inventory. A failed refresh preserves the last snapshot with a connection warning. This is bounded polling, with no WebSocket/DO infrastructure.

## Release

```sh
npm run check
npm run test:browser
npm run db:remote
# Never put secret values on the command line or in source.
npx wrangler secret bulk /secure/path/platform-secrets.json
npm run deploy
```

The Worker owns `eagle.hexly.ai` as a custom domain. `/api/live` publicly checks D1 connectivity and returns no inventory. The read-only reviewers are advisory; the integrator commits on `main`. See [checkpoints](docs/CHECKPOINTS.md) for real data verification and [API](docs/API.md) for ingestion/query semantics.
