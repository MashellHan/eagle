<p align="center"><img src="assets/brand/readme.png" width="128" height="128" alt="Eagle golden eagle Logo" /></p>

# Eagle

[简体中文](README.zh-CN.md)

Private, evidence-led overview of every Herdr Space on every reporting machine.

**Production:** https://eagle.hexly.ai · **Local:** https://eagle.dev.hexly.ai · **[Hexly](https://hexly.ai/projects/eagle)** · **[Status](https://status.hexly.ai)**

Vite + React 19 + **@nocoo/basalt 2.1.8**, TypeScript **7.0.2**, Biome. Cloudflare Worker serves the SPA and authenticated API; one SQLite-backed Durable Object per machine maintains current state. Each DO independently retains deterministic current snapshots and semantic Pane changes in UTC hourly buckets. D1 archives semantic changes; whole-report history and hourly AI aggregation remain paused. The Node management agent runs locally on each machine. No remote terminal control is exposed.

## Run

Requires Node 24+ (native TypeScript and SQLite), npm, Herdr 0.9.1+, and Cloudflare credentials for deployment.

```sh
npm ci
# Add a random AGENT_SIGNING_KEY (32+ characters) to ignored .dev.vars (chmod 600).
# Optional AGENT_TOKENS retains existing legacy machine credentials.
# LOCAL_DEV="true"  # Local website requires no login token.
# LOCAL_USER_EMAIL="you@example.com"  # Optional avatar-service preview identity.
npm run db:local
npm run dev:api
# A second terminal:
npm run dev
```

Local Vite is **127.0.0.1:7053**, Worker is **127.0.0.1:37053**, inspector is **38053**. Caddy's existing `eagle.dev.hexly.ai` block proxies 7053 with the machine's mkcert certificate. Browser tests use **27053**. The **17053** suffix is reserved for standalone API E2E. Restart Wrangler after changing secrets.

These ports follow the nmem allocation after Zeppelin (7052); 6001 belonged to the legacy eagle-webui and is no longer this project's development port.

```sh
npm run check
npm run test:browser
# Actual machine → authenticated upload → machine DO → Chromium, no mocked requests:
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node scripts/verify-live.ts
```

`verify-live.ts` reads `.local/agent-dev.json` by default; local viewing needs no credentials. For production, set `EAGLE_VERIFY_ORIGIN=https://eagle.hexly.ai`, `EAGLE_CONFIG` to the production agent configuration and `EAGLE_ACCESS_JWT_FILE` to a mode-0600 file containing a genuine Access application JWT. Obtain it through `cloudflared access login --quiet https://eagle.hexly.ai`; never paste credentials into commands or logs. Screenshots and sanitized receipts remain in ignored `.local/`. The script checks anonymous Access redirection, authenticated viewing, idempotency, every real Space, automatic updates, history and mobile layout.

## Machine agents

Install the independent Agent package from npm (Node 24+ and Herdr required):

```sh
npm install -g @nocoo/eagle-agent@0.4.0 --registry=https://registry.npmjs.org
# If npm is unreachable, prefer the Tencent Cloud mirror:
npm install -g @nocoo/eagle-agent@0.4.0 --registry=https://mirrors.cloud.tencent.com/npm/
eagle-agent --version # expected: 0.4.0
```

Choose one install command. New releases may take time to reach mirrors; on `404` / `ETARGET`, retry later or use the official registry when reachable. [Full installation and configuration](agent/README.md). **The website's Connect and visualization changes remain local; they have not been deployed.** Package builds run from the complete repository after `npm ci`; `npm pack ./agent --pack-destination .local` creates a preview tarball.

Copy [the reporting Skill](skills/eagle-report/SKILL.md) to Cherry or any other local management agent. See [the agent contract](docs/AGENT.md) for credentials, periodic execution, structured evidence, retries and deployment receipts. The checked-in [v1 JSON Schema](public/report-v1.schema.json) is generated from the TypeScript validator; cross-object uniqueness checks additionally run on the server.

The website uses **Cloudflare Access** with team `nocoo`. The Worker verifies RS256 signatures against the team's rotating JWKS, issuer, application audience, expiry and required claims. The audience is configured in `wrangler.jsonc`. Eagle has no viewer token, password field, custom session endpoint or custom session cookie. Local viewing bypasses Access only with `LOCAL_DEV="true"` and an explicit loopback/development hostname; production sets the flag to `false`.

The desktop sidebar starts expanded and keeps the Eagle mark fixed when toggled. Its footer shows the verified Access account, author-service avatar and Access logout. Only a SHA-256 hash of the normalized email is sent to `lizheng.blog`; profile lookup failures fall back to the account name and initial. Local preview may set `LOCAL_USER_EMAIL` in `.dev.vars` without a token; logout is disabled and marked as local.

The **Connect** page manages machines, creates one-time onboarding prompts, rotates tokens and disables reporting. Agents use **machine-scoped signed Bearer tokens** stored only in their 0600 configuration. `AGENT_SIGNING_KEY` remains a Worker secret; DOs store public credential versions and machine metadata, never tokens. Existing `AGENT_TOKENS` credentials remain supported until rotated or disabled. They upload to **https://eagle-ingest.hexly.ai** so browser SSO never interrupts reporting. That host serves reports, heartbeats, semantic uploads, the authenticated machine’s own snapshot and public `/api/live`; dashboard assets, overview and history all return 404 there. The private API never supports CORS. Browser storage and D1 contain no authentication tokens.

The global overview uses Basalt charts to summarize every machine, with state distributions and compact resource graphics. Open a machine to see resources, ports and Spaces without repeating fleet summary cards. Compact machine groups preserve real pane geometry; state filters, evidence coverage, agent distribution and change timelines expose useful details immediately. Skeletons keep loading geometry stable, refreshes retain content, and entrance/refresh motion respects reduced-motion preferences.

Each machine also reports CPU, RAM, home-filesystem disk capacity and uptime. Add `"watchPorts":[{"name":"Raven","port":7024}]` to the agent's secure configuration to track named local TCP endpoints. Resource and port snapshots live in each machine DO with the current Space inventory, and stale observations are labelled explicitly. See [agent configuration](docs/AGENT.md) for measurement semantics and upgrade order.

## Interpretation

Herdr `idle`, `done` and `blocked` are weak hints. A verified task requires matching current-task final summary, Goal, Git revision and test evidence; deployment evidence is also required when the task says so. A running Goal or actual tool-execution event takes priority over apparent completion. Conflicting or missing evidence remains visible. An agent process merely being present does not prove activity. Old task evidence, stale evidence and mismatched revisions never certify completion.

Codex's local thread/goal stores are optional adapters; only final replies and lifecycle events are extracted. Reasoning and tool arguments are excluded. Other harnesses use a bounded terminal excerpt and manager-supplied structured evidence. Text evidence is redacted before spool/upload. Heuristics cannot guarantee redaction of arbitrary secrets: managers should send concise summaries, and use the Skill to provide verified test/deployment receipts instead of raw terminal dumps.

The dashboard refreshes every **5 seconds** while visible and refreshes immediately on return. After 90 seconds without heartbeat or 5 minutes without a snapshot, current-state cards explicitly show stale inventory. A failed refresh preserves the last snapshot with a connection warning. The overview reads machine DOs directly; it never polls D1. Latest changes retain their original capture time; The Pane hourly view reads DO semantic records; D1 is queried only for archive history.

## Release

```sh
npm run check
npm run test:browser
npm run db:remote
# Never put secret values on the command line or in source.
npx wrangler secret bulk /secure/path/platform-secrets.json
npm run deploy
```

The Worker owns `eagle.hexly.ai` as a custom domain. `https://eagle-ingest.hexly.ai/api/live` publicly probes the first configured machine DO and returns no inventory. The read-only reviewers are advisory; the integrator commits on `main`. See [checkpoints](docs/CHECKPOINTS.md) for real data verification and [API](docs/API.md) for ingestion/query semantics.

## Identity

The golden eagle belongs to the fragmented animal family. README uses the rounded presentation; the expanded/collapsed sidebar, loading and Access entry marks use the transparent foreground without a background or corner mask. Root `logo.png` is the unchanged 2048px foreground; [brand provenance](assets/brand/provenance.json) records the exact master, generation and consumer roles. The Basalt application palette remains independent.

Live Pane summary protocol, hourly DO indexes/API, retention and continuous Cherry integration: [docs/PANE-SUMMARIES.md](docs/PANE-SUMMARIES.md). Run `eagle-agent manager-watch` alongside the deterministic `watch` daemon.
