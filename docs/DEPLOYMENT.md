# Deployment and live verification

Commands run from the repository root. Deployment configuration is never tracked: the
repository carries `apps/web/wrangler.example.jsonc` and
`apps/web/wrangler.devices.example.jsonc`, and both real files are ignored. A new machine
creates them from the examples, and CI supplies `EAGLE_WRANGLER_CONFIG` (the JSON config as a
secret) with `EAGLE_INGEST_ORIGIN` (a repository variable) for the post-deploy check.
Website commands use `apps/web/wrangler.jsonc`.
The independent device service uses `apps/web/wrangler.devices.jsonc` and the separate
procedure below; `npm run deploy` is not its deployment command. See
[local setup](../README.md#开发) before verifying the development origin.

## Local frontend, Local or Prod backend

`npm run dev` exposes a Local / Prod segment in the header at
`<your dev origin>`. Local is the default; it uses the local Worker
on port 37053. Prod keeps the local frontend and proxies viewer API requests
and realtime WebSockets to `<your production origin>`. **Prod has full production
read/write access**, including settings, machine credentials and terminal input.
It is not a preview or a read-only mode. Automated checks use synthetic upstreams.

Before selecting Prod, authenticate the local proxy in your terminal:

```sh
cloudflared access login --quiet <your production origin>
```

The proxy retrieves the cached application token using `cloudflared access token`;
it never sends it to the frontend. Missing or expired authentication fails closed
with a login instruction, without falling back to Local. Browser logout is
disabled for this local proxy identity, which is managed by cloudflared.

The selection is per-tab session storage. Switching reloads the home page,
discards unsaved forms and closes existing realtime connections. Terminal drafts
are separated by environment and are never sent automatically. Previously
submitted production operations may still finish; switching does not undo them.
Each request has a fixed environment path, so another tab cannot retarget it.
Production onboarding uses `<your ingest origin>`; Local uses the local origin.
The gateway is dev-server-only and does not add a production Worker route.

## Verify the live path

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node scripts/verify-live.ts
```

`verify-live.ts` reads `.local/agent-dev.json` by default; local viewing needs no credentials. For production, set `EAGLE_VERIFY_ORIGIN=<your production origin>`, `EAGLE_CONFIG` to the production agent configuration and `EAGLE_ACCESS_JWT_FILE` to a mode-0600 file containing a genuine Access application JWT. Obtain it through `cloudflared access login --quiet <your production origin>`; never paste credentials into commands or logs. Screenshots and sanitized receipts remain in ignored `.local/`. The script checks anonymous Access redirection, authenticated viewing, idempotency, every real Space, automatic updates, history and mobile layout.

## Website-only releases

The root manifest owns the website/Worker version and
`config.publishedAgentVersion` owns its verified npm onboarding pin. An
unpublished Agent source version is not an installation target. A website-only
release may leave `packages/agent/package.json` unchanged and use the existing published
Agent; do not publish npm, restart collectors, or change real machine configs.

The current GitHub workflow runs checks on main/PR only; it has no npm/tag/release
publication trigger. `npm run deploy` builds the website and deploys only the
Eagle Worker with `BUILD_REVISION` from a clean, committed HEAD. Inspect these
triggers again for every release before pushing a tag. Use an ordinary version
tag and GitHub Release only after exact-SHA CI and the authorized deployment.

Run `wrangler d1 migrations list eagle --remote --config apps/web/wrangler.jsonc` first. Apply only genuinely
pending required migrations; the resource-history table is initialized inside
each existing machine DO, with no new D1 migration. Preserve Worker secrets.

`verify-live.ts` actively collects and uploads a real machine report. When the
release explicitly excludes collection, use a separate read-only verifier:
check the real local origin and production health/version/revision, anonymous
Access redirects, authenticated viewer/overview/resource reads and actual
Chromium rendering. Reuse a genuine application JWT in a private file, never
an Agent token as viewer auth. Do not modify machines, issue tokens, ingest
fixtures, send realtime input, or trigger daily jobs. Record actual existing
collector versions, sample timestamps and empty history instead of treating
synthetic validation as production evidence. Missing Access login blocks
protected-page verification, not permission to disable authentication.

## Deploy

For realtime changes, also run `node scripts/verify-realtime.ts` against both origins with their realtime bridges running. See [Space realtime mode](REALTIME.md). On this Mac the production realtime bridge is supervised separately as `com.hexly.eagle-realtime`.

```sh
npm run check
npm run test:browser
npm run db:remote
# Never put secret values on the command line or in source.
npx wrangler secret bulk /secure/path/platform-secrets.json --config apps/web/wrangler.jsonc
npm run deploy
```

`npm run deploy` stays the manual path; `.github/workflows/deploy.yml` also
deploys every green `Check` on main through the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets, then polls `/api/live` for the exact revision
and skips with a notice when the secrets are absent.

The Worker owns `<your production origin>` as a custom domain. `<your ingest origin>/api/live` publicly probes the first configured machine DO and returns no inventory. The read-only reviewers are advisory; the integrator commits on `main`. See [checkpoints](CHECKPOINTS.md) for real data verification and [API](API.md) for ingestion/query semantics.

## AI daily reports

Migration `0004_daily_reports.sql` creates the daily archive and drops the old
hourly archive; apply it immediately before deploying the matching Worker. The
new Worker installs only `59 15 * * *` (Beijing 23:59). Each machine DO drops old
hourly jobs/steps and the retired semantic tables when initialized, retaining raw snapshots. The
existing AI connection and encrypted credential are preserved. Set `AI_ENCRYPTION_KEY` once using a cryptographically random value of at least 32 characters (`npx wrangler secret put AI_ENCRYPTION_KEY --config apps/web/wrangler.jsonc`, interactive input or secure file stdin). Do not overwrite an existing wrapping key. Local development uses the same binding in gitignored `apps/web/.dev.vars`.

Users save provider/model and API keys in `/settings`. The directory DO stores authenticated ciphertext in the separate `ai-credential` record; API responses never return the key. Blank input keeps the existing credential, explicit clearing removes it, and changing provider/endpoint/protocol/authentication requires a new key. Without a complete AI configuration the schedule is a no-op.

Run `scripts/verify-daily.ts` with the same origin/Access settings as `verify-live.ts` to verify settings, no secret exposure, unconfigured skip, D1 query, report UI and mobile layout. The detailed generation/storage contract is in [DAILY-REPORTS.md](DAILY-REPORTS.md).

## Independent device service

The independent `/api/devices/v1` contract is in [DEVICES.md](DEVICES.md).
The product target is one `eagle-devices` Worker on its own custom domain. The repository
carries **only** `apps/web/wrangler.devices.example.jsonc`: copy it to
`apps/web/wrangler.devices.jsonc` (ignored) and put your hostname in `routes`. No
`workers.dev` hostname is served and the config carries no `account_id`, so `wrangler`
deploys into the account it is logged into.
A second-level host such as `eagle-devices.worker.hexly.ai` is outside the zone's Universal
SSL wildcard and answers a TLS handshake failure until the zone enables Total TLS.
This is a persistent product service, not a remote test fixture. The existing personal
`eagle`/`eagle-ingest` deployments and upstream hexly.ai services are outside this deployment.

Root deployed `28f4aefb92106e8299d7269fb4b0e2fb7bbb289a` on 2026-10-29, after the
235-test root check, types/lint/build, absolute-path dry-run and incremental review passed.
Cloudflare version: `51174415-6140-4347-8f88-584ec7cff0b8`. Public Node requests verified
`GET /api/live` 200 with that exact revision and anonymous device directory 401
`session_required`, both `no-store`. Receipts are in `.local/device-evidence/own-device-release/`.
Those initial health checks did not establish App registration or physical pairing;
later installed and cross-Mac evidence is tracked in `docs/bots/PLAN.md`.

`apps/web/wrangler.devices.jsonc` binds only `DEVICE_REGISTRY` → `DeviceRegistry` and
`DEVICE_EXECUTION` → `DeviceExecution`, with a new service's SQLite migration `v1`.
It reuses the existing implementations: Registry uses `getByName("registry")` and
execution uses the normalized device ID. It has no D1, assets, cron, old machine DOs
or custom-domain routes. The website configuration keeps only its machine/directory
bindings and migrations; device routes and SQLite classes belong solely to this
standalone service. Do not route device identities through owner tokens or copy
localhost Registry data into the product service.

After confirming the account and service name, use a clean committed revision and
portable Node on PATH. Dry-run output belongs under the root ignored `.local/`:

```sh
test -z "$(git status --porcelain)"
node_modules/.bin/wrangler deploy --config apps/web/wrangler.devices.jsonc \
  --var "BUILD_REVISION:$(git rev-parse HEAD)" \
  --dry-run --outdir "$(pwd)/.local/device-worker-dry-run"
# Only after authorization for this product deployment:
node_modules/.bin/wrangler deploy --config apps/web/wrangler.devices.jsonc \
  --var "BUILD_REVISION:$(git rev-parse HEAD)"
```

No D1 apply, shared-secret upload, website build or npm publication is required.
`scripts/deploy.ts` also publishes the app version: it reads
`apps/macos/Support/Version.json` into `MACOS_VERSION` and the release link from the root
`package.json` `config.macosReleaseUrl`, so `/api/live` answers `macos.latest` without the
site and the app sharing a number.

After deployment, verify the exact `/api/live` revision and anonymous device directory
401 response, then build the isolated candidate with
`EAGLE_DEVICE_SERVICE_URL=<your device origin>`. There is no address
form in the App; both Macs must use the same origin for registration, pairing and WSS.
Use the complete signed bundle and candidate installer described in
`apps/macos/README.md`; the installer prepares the old service before replacing it.
An uncertain operation is recovered by its original ID, never by resubmission with
a new ID. New DO state is persistent; do not delete classes or migration state as a rollback shortcut.

Local registry evidence uses `node --test tests/device-api.test.ts` with a unique
ignored worker bundle and isolated real Miniflare/SQLite state. Bundles must be
under the repository: this pinned Miniflare/workerd fails to load an otherwise
identical bundle with an absolute entrypoint outside its module root. The test
never seeds a remote resource or the daily development database.
