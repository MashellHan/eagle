# Native machine access

Native connection and local-service logic is delivered first; machine-page and
Bot/plugin UI composition follow in their own commits. This contract defines the
owner identity, observable state and independent Agent control they consume.

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

Recorded local checks and unresolved release gates are in [CHECKPOINTS.md](CHECKPOINTS.md).
The complete candidate App, Access edge and a second physical Mac remain unverified.
