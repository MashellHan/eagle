# Native machine access

Native connection/local-service logic and the Herdr execution/panel components
are delivered independently; machine-page and Bot UI composition follow in their
own commits. This contract defines their owner identity, observable state and
independent Agent control. Complete candidate delivery still requires its gates.

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

After a complete candidate is available, create a separate profile on each Mac
and choose an unused non-default Bots port. From the checkout root, this example
opens only the UI; it does not automatically start or connect Bots:

```sh
umask 077
eagle_profile_root="$(mktemp -d "${TMPDIR:-/tmp}/eagle-app-verification.XXXXXX")"
EAGLE_APP_VERIFICATION_ROOT="$eagle_profile_root" BOTS_PORT=52117 \
  ./apps/macos/.build/Eagle.app/Contents/MacOS/EagleApp
```

Record the profile root for reopening. To test A Bot → B, reopen A with that same
root and port plus `EAGLE_APP_VERIFICATION_CONNECT_BOTS=1`, then configure Raven
and create its test Bot normally. Machine management and Herdr on B do not require
that switch or a model key. These launch commands still require runtime validation
of the assembled candidate; the component gates do not certify it.

Recorded local checks and unresolved release gates are in [CHECKPOINTS.md](CHECKPOINTS.md).
The complete candidate App, Access edge and a second physical Mac remain unverified.
