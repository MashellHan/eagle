# Native machine access

This branch provides native machine management, optional Herdr setup and per-Bot
remote execution. Start with the compatible backend below: the existing production
service has not received this branch's owner/execution routes. Production Access
policy and physical two-Mac behavior require separate acceptance.

## Quick A/B start

Use the supplied **Eagle 0.14.2 candidate zip**, or build this branch. The supplied
App is **arm64 (Apple silicon), macOS 15+**, and requires an external **Node.js 24+**
on each Mac that runs its Agent or Bots daemon. Node 26.9.0 was used for the local
acceptance. Node is not bundled; select its actual absolute executable path.

1. **A: prepare the backend.** Follow [the isolated Worker setup](#prepare-an-isolated-compatible-backend)
   using the locked checkout dependencies. It creates private local D1/state and
   two fresh test secrets. If B uses the documented SSH tunnel, use only an
   already-authorized SSH account; both Apps then use `http://127.0.0.1:17053`.
2. **A and B: open a test profile.** Unzip the candidate without replacing an
   installed App. Follow [the private profile example](#isolated-app-verification-configuration)
   with a separate root and unused Bots port on each Mac. Machine management and
   Herdr need no model key on either Mac.
3. **B: enable execution; A: select B.** In Settings → Machines, save the compatible
   deployment and test owner credential. Enable B's local service, then explicitly
   authorize commands and individual file directories. Refresh A's machine list
   and select B. Optional Herdr setup remains separate from basic execution.
4. **Optional A Bot → B.** In A's isolated profile, configure Raven normally and
   create a test Bot. Enable Remote machine tools and grant that Bot the specific
   B capabilities it needs. Do not copy a daily Bot database or credentials. B
   still needs no model key. Continue with the [seven-step acceptance](#two-mac-setup-guide).

The App includes the locally packed Agent, independent Bots daemon and signed
credential helper. Release assembly is complete; the current runtime verdict is
recorded in [the verification record](#verification-record). A complete local
fixture run does not certify physical A/B or the production Access edge.

## Prepare an isolated compatible backend

At 07:53, an isolated complete production Worker, all five local D1 migrations and
two foreground local Agents passed 20 check groups with exact root dependencies.
Evidence is `/tmp/eagle-root-two-local-20261029-Qd3m9c/evidence.json`, source
`f7c58a729c…` (81 inputs). Owner rejection, real execution WS, per-machine command/
file authority, idempotency, DO reports and revocation were exercised; legacy D1
history stays empty because `historyWrites=false`. All owned processes and state
were cleaned up. This does not verify the following physical two-Mac SSH steps
or complete App runtime. Use the complete
`apps/web/src/worker/index.ts`, including its AI SDK imports, rather than an
execution-only test fixture. Mac A needs the current checkout, Node.js 24+ and its
locked Wrangler 4.152.0. Neither machine needs a model key for machine management.
For a locked dependency download or cache failure, follow [NPM recovery](NPM-RECOVERY.md)
under that machine's current source authorization.

From the checkout root on A, create private test state without reading the daily
`.dev.vars`:

```sh
umask 077
eagle_repo="$PWD"
eagle_test_root="$(mktemp -d "${TMPDIR:-/tmp}/eagle-two-mac.XXXXXX")"
EAGLE_TEST_REPO="$eagle_repo" EAGLE_TEST_ROOT="$eagle_test_root" \
  node --input-type=module <<'JS'
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const repo = process.env.EAGLE_TEST_REPO;
const root = process.env.EAGLE_TEST_ROOT;
const put = (name, value) =>
  writeFileSync(join(root, name), value, { mode: 0o600, flag: "wx" });
mkdirSync(join(root, "assets"), { mode: 0o700 });
put("assets/index.html", "<!doctype html><title>Isolated Eagle API</title>");
put(".dev.vars",
  `OWNER_TOKEN="${randomBytes(32).toString("hex")}"\n` +
  `AGENT_SIGNING_KEY="${randomBytes(32).toString("hex")}"\n`);
put("wrangler.json", JSON.stringify({
  name: "eagle-two-mac",
  main: join(repo, "apps/web/src/worker/index.ts"),
  compatibility_date: "2026-09-19",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  preview_urls: false,
  durable_objects: { bindings: [
    { name: "MACHINES", class_name: "MachineState" },
    { name: "DIRECTORY", class_name: "MachineDirectory" }
  ] },
  migrations: [
    { tag: "v1", new_sqlite_classes: ["MachineState"] },
    { tag: "v2", new_sqlite_classes: ["MachineDirectory"] }
  ],
  assets: {
    directory: join(root, "assets"), binding: "ASSETS", run_worker_first: true
  },
  d1_databases: [{
    binding: "DB", database_name: "eagle-two-mac",
    database_id: "00000000-0000-0000-0000-000000000001",
    migrations_dir: join(repo, "apps/web/migrations")
  }],
  vars: {
    LOCAL_DEV: "false", AGENT_TOKENS: "{}",
    BUILD_REVISION: "two-mac-isolated", ACCESS_TEAM_URL: "", ACCESS_AUD: ""
  }
}, null, 2));
JS
```

The directory is 0700 and files are 0600. The two independently generated secrets
have different roles. `LOCAL_DEV=false` requires real owner authentication. The
D1 UUID is local configuration only; these commands create no remote resource.
Confirm both A ports below are free and the local Wrangler reports exactly
4.152.0; otherwise stop. Use the same private config and persistence root for
migrations and the foreground server:

```sh
"$eagle_repo/node_modules/.bin/wrangler" --version
cd "$eagle_test_root"
"$eagle_repo/node_modules/.bin/wrangler" d1 migrations apply eagle-two-mac \
  --local --config "$eagle_test_root/wrangler.json" \
  --persist-to "$eagle_test_root/state"
"$eagle_repo/node_modules/.bin/wrangler" dev \
  --local --config "$eagle_test_root/wrangler.json" \
  --ip 127.0.0.1 --port 17053 --inspector-port 18053 \
  --local-protocol http --persist-to "$eagle_test_root/state"
```

Keep that terminal open. Do not substitute the default `db:local` or `dev:api`
scripts, which use daily development configuration. If A already authorizes the
chosen account to log in over SSH, run this foreground tunnel on B, with B's
17053 free and `account@mac-a` replaced by that authorized destination:

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:17053:127.0.0.1:17053 account@mac-a
```

In another B terminal, `curl --fail --silent --show-error
http://127.0.0.1:17053/api/live` checks health only. It does not prove owner
authentication, registration or execution. Both Apps use
`http://127.0.0.1:17053` as dashboard/API origin; use that same loopback origin
for this fixture's Agent ingestion. B reaches A through SSH. Do not enter A's
LAN address as an HTTP origin: the native client permits insecure HTTP only on
loopback. Leave Access fields empty for this local setup.

Provide only the new test `OWNER_TOKEN` to A/B's native clients through their
credential fields. Do not copy the complete `.dev.vars` to B: it also contains
the signing key. Only the registered machine token goes into B's private Agent
configuration. `execution.commands=false` still allows it to connect; file grants
and optional Herdr setup are separate permissions.

After verification, stop any test Agent service with its same Node, CLI and
`EAGLE_CONFIG` before closing the tunnel. A foreground Agent, SSH and Wrangler
can each be ended in its own terminal. Revoke this run's Bot grants and confirm
helper credential cleanup before deleting its private directories. Do not remove
unrelated Keychain items or LaunchAgents. Physical A/B connection, UI-exit survival,
network recovery and real Access policy require separate results.

## Two-Mac setup guide

These seven steps are physical two-Mac acceptance steps for the delivered candidate.
For the UI route, A and B both need macOS 15+, that candidate App and an external
Node.js 24+ installation. Node is not bundled; select its actual absolute path
when Finder's PATH cannot discover it. Local protocol, process and Keychain
evidence is recorded separately in CHECKPOINTS.md.

1. Machine management and Herdr setup need no model key on either Mac. In normal
   use, A can use its existing Bot and model configuration. An isolated App profile
   starts with its own empty Bots root and does not load the checkout `.env`: to
   test A Bot → B, configure Raven through that profile's normal model settings
   and create a test Bot there. Do not copy the daily Bot database or credentials.
   B still needs no model key or Herdr. A CLI-only B can omit the App; use the
   separate route below.
2. On each Mac using the UI, open Settings → Machines and save the compatible dashboard/API deployment and
   owner credential. Supply the Access client ID/secret pair only if this
   deployment requires it. Test and save the connection. The Agent ingestion
   address is a separate field; owner and Access credentials never go there.
3. On B, choose the actual Node executable when Finder cannot discover it, confirm
   the machine name and ingestion address, then enable the local execution service.
   Enable commands only when needed. Authorize individual file directories on B
   using File grants. On A, refresh the real machine list and inspect B's status.
4. On A, select the intended Bot and open its Inspector → Computer → Manage machine
   grants. Select B and explicitly select each permitted operation. The App copies
   the approved saved connection through the private local helper; do not paste
   credentials into chat. The sheet retains the Bot identity it was opened for.
5. Separately enable Remote machine tools in the existing Bots tools settings.
   This switch applies to all Bots, while each Bot still requires its own grants.
   Turning the group off does not revoke stored grants.
6. Herdr is optional. In B's Herdr settings, probe the installed CLI or explicitly
   install it, then select an existing session or create a new named headless
   session. Confirm CLI, server, session and tools independently before enabling
   use. A Bot with Herdr setup permission uses the same Agent operations. Existing
   sessions are preserved; steps requiring OS interaction must be completed locally.
7. Request one permitted operation on B from A and inspect its result. Quit B's
   Eagle UI and confirm the independent Agent remains online. Use Stop service to
   stop it. Revoke a Bot's grant to remove authority; if credential cleanup remains
   pending, retry cleanup. Changing a shared deployment first revokes and cleans
   its old Bot credentials, then saves the replacement connection.

For isolated development, EAGLE_CONFIG changes only the Agent configuration;
it does not isolate App preferences or Keychain. Starting an App from another
directory also shares those stores under the same bundle identity. The integration
fixtures inject their own vaults/preferences or use uniquely named Keychain items
and exact service labels.

## Isolated App verification configuration

The verification entry is an explicit composition of the existing stores and
clients, not an OS sandbox. Component gates do
not validate the complete candidate or an active backend. With
`EAGLE_APP_VERIFICATION_ROOT` set, the App requires an existing directory owned by
the current user with mode 0700, and an explicit `BOTS_PORT` in 1024–65535 other
than the daily default 43117. Invalid or partial verification settings stop
startup; they never fall back to the daily configuration.

This configuration gives preferences and the machine-connection/sharing Keychain
items their own namespace derived from the canonical verification root. Agent
configuration, Bots state, provider configuration, outbox and refusal fallback
use separate children of that root. The private helper's Bot credential accounts
remain scoped to the selected daemon root. Node, Agent CLI and helper executable
overrides may select the prepared candidate's programs; secrets are not passed in
the launch environment. The App-owned daemon does not load a checkout `.env` in
this mode.

Catalog, gateway settings and machine-grant clients use the selected profile's
token source. Verification ignores inherited `BOTS_TOKEN` and `BOTS_OPEN`; the
daemon token is read from its private Bots root. Ordinary launch keeps explicit
token and initial-Bot overrides from its selected environment.

Automatic daemon startup and Bot connection are both off for verification unless
`EAGLE_APP_VERIFICATION_CONNECT_BOTS=1` is explicitly supplied. Ordinary startup
without verification settings retains the existing stores and automatic behavior.
Opening another window and App exit use the same verification preferences and
ownership scope. Verification data is retained for reopening; first revoke this
run's Bot grants and stop its owned services, then clean only its recorded root,
preferences domain and Keychain items.

Create a separate profile on each Mac and choose an unused non-default Bots port.
Set `eagle_app` to the unzipped candidate, and `eagle_node` to that Mac's external
Node executable. This example opens only the UI; it does not automatically start
or connect Bots:

```sh
umask 077
eagle_app="/absolute/path/to/Eagle.app"
eagle_node="/absolute/path/to/node"
eagle_profile_root="$(mktemp -d "${TMPDIR:-/tmp}/eagle-app-verification.XXXXXX")"
EAGLE_APP_VERIFICATION_ROOT="$eagle_profile_root" BOTS_PORT=52117 \
  BOTS_NODE="$eagle_node" EAGLE_AGENT_NODE="$eagle_node" \
  "$eagle_app/Contents/MacOS/EagleApp"
```

Record the profile root for reopening. To test A Bot → B, reopen A with that same
root and port plus `EAGLE_APP_VERIFICATION_CONNECT_BOTS=1`, then configure Raven
and create its test Bot normally. Machine management and Herdr on B do not require
that switch or a model key. The verification record distinguishes actual candidate
startup from the separate backend and physical two-Mac checks.

## Candidate build and CLI-only B

With the locked dependencies installed, build from the repository root. Release
assembly was run in a private snapshot; the output below is a candidate location,
not an installation command:

```sh
apps/macos/Scripts/build-app.sh release
# Use the private-profile command above to launch this candidate.
# eagle_app="$PWD/apps/macos/.build/Eagle.app"
```

The output is `apps/macos/.build/Eagle.app`; the script does not install into
`/Applications`. Its build packs the current Agent source again, so the old
verified tgz cannot certify the newly assembled App. The bundled Agent entry is
`Contents/Resources/Agent/node_modules/@nocoo/eagle-agent/dist/agent/cli.js`.
Its private wrapper pins production dependencies from the root lock. Before
`npm ci`, every resolved dependency must match that lock's version and SRI and
the local Agent tarball must match its actual SHA512. The installed Agent must
resolve those dependencies inside its own bundle at the locked versions. The
repository lock is never rewritten by assembly.
Ordinary startup uses persistent daily settings. For a separate profile use the
explicit verification configuration above; an alternate App path alone does not
provide isolation.

For CLI-only B, use the locked Agent already included in the candidate zip. This
route needs no App process or additional npm install. Keep the extracted candidate
at a stable path and use an explicit executor configuration for every command:

```sh
eagle_app="/absolute/path/to/Eagle.app"
eagle_node="/absolute/path/to/node"
eagle_cli="$eagle_app/Contents/Resources/Agent/node_modules/@nocoo/eagle-agent/dist/agent/cli.js"
eagle_executor_config="$HOME/.config/eagle/executor/agent.json"
EAGLE_CONFIG="$eagle_executor_config" "$eagle_node" "$eagle_cli" identity
```

Register that reserved machine ID through the compatible backend. Its create or
explicit rotate response supplies the machine token. Prepare a private owned
0600 configuration containing that ID/token, ingestion URL and selected execution
capabilities; owner and Access credentials do not belong in it. Pass the
configuration through stdin, then verify the foreground connection:

```sh
EAGLE_CONFIG="$eagle_executor_config" "$eagle_node" "$eagle_cli" init < /path/to/private-machine-config.json
EAGLE_CONFIG="$eagle_executor_config" "$eagle_node" "$eagle_cli" serve
```

After ending the foreground verification, use `service install`, `service start`
and `service status` with the same Node/CLI/EAGLE_CONFIG prefix. Use `service stop`
to stop that exact service. Existing configuration repair uses `reconfigure` on
stdin while stopped; `init` never overwrites it. The CLI's default path remains
`~/.config/eagle/agent.json`, and a bare invocation defaults to the optional Herdr
collector's `once`. Always name `serve` or `service` for the executor route.

The following physical two-Mac checks remain pending independently: basic
execution without Herdr, A Bot receiving B's result, B UI exit with Agent survival,
real network loss/reconnection/cancellation/deduplication, and both native and
Bot-assisted Herdr setup. Local socket, Keychain, Harness and SIGKILL fixtures
prove their stated boundaries only.
The retained SIGKILL fixture gives its held command an independent deadline and
a private process receipt. Both fixture and outer runner confirm its cleanup;
unconfirmed cleanup retains the private state and fails the gate.

## Authentication and lifecycle contract

- `OWNER_TOKEN` is a deployment secret, at least 32 characters. Native clients
  store it in the Keychain and send it only in the HTTPS `Authorization: Bearer`
  header (HTTP loopback is allowed for isolated development). It is distinct from
  each machine's Agent token, a Bot daemon token and Cloudflare Access credentials.
  An explicit invalid Authorization header fails closed, without falling back to
  an Access identity or local-development viewing.
- Native clients use the existing `/api/v1/` viewer API on the configured
  dashboard/API origin. The ingestion host continues to reject viewer APIs.
  Operators must verify their Access policy permits service authentication or an
  explicit native API entry that reaches the Worker. This branch does not modify
  that edge policy. Worker authentication is always required.
- Cloudflare Access service credentials are a separate client ID/secret pair,
  optionally sent by a configured native client in Access headers when required
  by its deployment's edge policy. They are not interpreted as an Eagle Bearer
  token. An Access service assertion alone does not grant Eagle owner access.
- HTTP and realtime use one verified identity, including authentication kind and
  a finite authorization expiry. Native owner WebSockets may omit Origin; any
  supplied Origin must match. Existing browser/Access WebSockets still require
  the exact Origin. No route decodes an unverified JWT to invent a lease.
- Realtime owner authorization lasts at most 15 minutes, after which reconnection
  rechecks the secret. Rotation rejects new connections immediately; existing
  owner connections expire within that lease. Access leases cannot outlive their
  verified JWT. Secrets are excluded from reports, machine names and WS payloads.

The optional command capability runs with the Agent account's OS permissions and
must be explicitly enabled on that machine. Directory grants constrain file
tools; a command's working directory is not isolation. This stage adds no sandbox
runtime or Seatbelt dependency. Herdr remains an optional machine provider.

The macOS machine page reads the protected machine directory and each machine's
execution status. A successful empty directory, failed authentication and an
unreachable status are different states; it never inserts demonstration machines.
For Bot grants, a 401/403 from any machine status invalidates the whole directory
read, even if the list and other statuses succeeded. No new credential reservation
or copy is allowed from that read; existing local Bot grants remain revocable.
Ordinary offline or unreachable observations do not add an online-only grant rule.
Online execution and command permission are separate. Capability timestamps mean
"last capability report", not last seen. Rename/revoke wait for the server reply.
Machine identifiers containing a saved credential are refused before any request.
File grants and Herdr readiness must carry complete, distinct, credential-free
metadata; incomplete ready reports fail closed instead of enabling a capability.
Deployment origin and credentials are saved together in one Keychain item; changing
origin requires new credentials. Redirects are refused and old deployment requests
cannot replace the current directory. Access headers, when required, remain separate
from the Eagle owner Bearer. Quitting the UI does not own the Agent service lifetime.
Leaving the machine page invalidates its pending work before a late response can
save credentials or replace newer state. Snapshot rendering uses an isolated vault.

Local setup uses the dashboard/API origin to register or explicitly rotate a
machine credential, then sends only that credential and the separately selected
ingestion origin to the installed Agent on stdin. Local service controls invoke
the bundled candidate CLI with an explicit Node/configuration path, never a shell
or the Bots supervisor. A service action has bounded output and a deadline; raw
child diagnostics are not presented as credential-safe UI text.
The App build bundles a locally packed candidate under Resources/Agent, including
its dependencies. It never installs an unpublished version by npm version number.
The native client probes Node.js 24+ and uses its own default configuration at
`~/.config/eagle/executor/agent.json`; existing collector configuration is preserved.
Local setup validates the working directory before registering a machine. A saved
configuration binds its machine identity to the owner and ingestion origins;
switching the viewed deployment must not silently reuse that service. Repair or
credential rotation is explicit, retains the machine ID and requires the owned
service to be stopped before an atomic configuration update.
Direct Start also checks the saved owner binding; status and explicit Stop remain
available for foreign or unbound configurations. An installed manual configuration
without an owner binding can enter local settings, but requires explicit rotation
and confirmation of its ingestion address before it can start under this deployment.
Explicit EAGLE_AGENT_NODE/EAGLE_AGENT_CLI/EAGLE_CONFIG overrides support isolated
tests. Snapshot models receive no local service adapter and make no service calls.

Directory grants are managed only on the target Mac through the bundled CLI.
Choosing a folder authorizes bounded file read/list; revocation takes effect on
in-flight delivery and cached results. The remote machine row exposes grant
labels/availability, never absolute roots. This does not restrict command access.
Herdr settings on each machine use the same owner-authenticated execution socket
as a Bot's remote setup. The target machine is fixed; users choose an existing
session or explicitly create a new named headless session. CLI/service/session/
tools show separate observations. A non-secret operation reference is saved before
sending; reopening queries that ID. Network loss does not create a replacement
operation or cancel remote work. Historical results are labelled separately from
current capabilities, and credentials remain in headers/Keychain only.
An unresolved operation retains its original bookmark and blocks new setup calls;
query/cancel always target that ID. A durable `unknown` result requires explicitly
checking the target before continuing. Its reference remains available in the
panel's saved-operation list, including after reopening; continuing never replays it.

The selected Bot's computer inspector opens a sheet fixed to that Bot. It lists
the saved deployment's real machines and five separate permissions, initially
unselected. The daemon-wide remote tool-group switch is independent and remains
off by default. Authorizing a machine does not turn the group on; turning the
group off does not revoke stored authority.
The native coordination contract covers reservation, private credential copying,
activation, revocation and shared-deployment replacement in
[Remote access](bots/REMOTE-ACCESS.md#原生授权协调组件). Its model/client checks are
separate from the helper executable, Inspector composition and complete App bundle.
The helper is bundled under Contents/Helpers and signed before the host App.
Only its non-secret absolute path is passed to an App-owned Bots daemon. An
already-running external daemon is never restarted to install this capability.
Bots process ownership, shared-window control and App-exit cleanup follow the
[host supervisor contract](bots/ARCHITECTURE.md#host-daemon-lifecycle). A daemon left by a previous
App process is external after reopening, even when preferences retain its PID.
The independent launchd Agent keeps its separate lifetime.

Local API/process evidence is recorded in [CHECKPOINTS.md](CHECKPOINTS.md). Real
Access edge policy, another physical Mac and production deployment require their
own verification; this document does not claim those checks passed.

## Verification record

The release artifact comes from `fece8f0`, tree `2c16555d…`, source hash
`14d2fdfe…` (580 hash/mode-verified inputs). `build-app.sh release` completed in
43.618 seconds, including the exact local Agent/Bots packages and strict signature
verification. Assembly did not alter either repository lock or an installed App.
The local artifact/input manifests are `.local/delivery-release-candidate.json`
and `.local/delivery-release-app-manifest.json`.

On 2026-10-29 the independent v4 acceptance of a copied complete App passed all
12 checks: visible UI-only and connected windows, the actual child daemon from
`Contents/Resources/Bots`, private-token authentication, bundled helper status,
and normal AppKit quit in both phases. Both Apps exited 0; no driver signal, owned
process or token remained, and the port was free. Input and copied bundle manifests
were unchanged. Evidence: `/private/tmp/eagle-candidate-acceptance-a39jqbnq/evidence.json`,
SHA256 `767c0a2bb0cec35fc28962cd41b72928a5b1fc165eedca8bacda5d7254eb66ca`.
This checked local startup and lifecycle, not a physical A/B task or production Access.

The local transfer archive is `Eagle-0.14.2-arm64-fece8f0.zip` (38,108,679 bytes),
SHA256 `a6f703838ef7cf28b8fbafb4d98c9f71f912aa5d5f9dfe25c0a822c1b34e8601`.
Its 14,422 file/symlink entries match the source App's content hashes, modes and
link targets. The accompanying `.zip.sha256` and `provenance.json` preserve this
association; the archive is not checked into Git or installed over an existing App.

The final exact source checks are root 259/259, Bots 534/534, dedicated Bots crash
5/5 and performance 1/1, standalone Bots Swift 127/127 plus real helper Keychain
2/2, native integration 25/25, and App 232 feature + 49 design tests at 93.9%
logic coverage (90% floor), with strict format. Browser automation passed 191
with 11 existing device-condition exclusions. The separate complete local Worker,
five D1 migrations and two local Agents passed 20 check groups at 07:53. Gate
logs, tested trees and unchanged applicable input hashes are in
`.local/delivery-final-gates.json`.

The delivery branch is [MashellHan/eagle:feature/eagle-machines-herdr](https://github.com/MashellHan/eagle/tree/feature/eagle-machines-herdr).
Publication uses the ordinary root/browser/native/Swift push hooks and the shared
scheduler lock. Local delivery metadata records the actual push result; physical
two-Mac acceptance is a follow-up, not a prerequisite for publishing this branch.

Historical failures and component evidence remain in [CHECKPOINTS.md](CHECKPOINTS.md):
exact-dependency outages, the first native performance failure, utility identity
races, the initial on-screen-window timeout, and the post-exit TCP TIME_WAIT
probe failure were retained. The 00:34 raw-executable window and the earlier
`nocoo-eagle-agent-1.1.0-alpha.2.tgz` pack/install/version evidence remain separate
from the complete release App. No public npm release or production deployment
was performed. Physical A/B, real network interruption and Access policy remain
the user's subsequent acceptance steps.
