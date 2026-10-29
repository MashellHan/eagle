# Machine execution

The execution service is independent of Herdr and the read-only collector. It is
an explicit machine capability, not terminal input. Native machine management and
the Bot remote-tool adapter must use the same authenticated machine/operation
identity. Local transport/provider evidence is recorded in
[CHECKPOINTS.md](CHECKPOINTS.md); full Worker/Access and two physical Macs still
require separate acceptance.

## Durable admission

Each machine owns a private SQLite operation journal outside its exposed file
roots. The service holds an exclusive database connection; a second service must
fail rather than claim unfinished work from a live owner. The parent directory is
0700 and the database is 0600. The primary thread owns the journal; worker threads
cannot open it. A process-wide path/inode guard rejects a second instance before
opening any file descriptor, including hard-link aliases. On POSIX, closing an
unrelated descriptor for the same database can release the owner's locks, so other
code in the service must not open the database directly while it is owned.
Operation IDs are opaque; the normalized request's
SHA-256 fingerprint binds an ID to one operation on this machine.

- Admission is persisted before execution. The first request returns a new
  running record; an identical retry returns that record without executing again.
  Reusing an ID with different content is a conflict.
- Final results distinguish succeeded, failed, cancelled and unknown. Exit code
  is nullable; an unknown outcome never becomes successful or cancelled by guess.
- On service restart, unfinished records become unknown. Querying or retrying
  their IDs does not replay execution. This is not an exactly-once guarantee for
  arbitrary external effects.
- Final records are immutable. The initial journal keeps at most 10,000 records
  and refuses new admissions at capacity; it never deletes deduplication evidence
  to make a retry appear new. A later retention/migration policy requires its own
  contract and tests.
- Results are bounded to 64 KiB of UTF-8 stdout/stderr together. They stay in the
  machine's private journal, never application logs, telemetry, D1 or model
  configuration. Credentials must not be part of operation arguments or results.

## Explicit command capability

The bounded command runner is a separate machine capability, disabled unless the
machine enables it. Commands use the Agent account's OS permissions, with an
explicit program/argv and working directory. A working directory does not isolate
commands or constrain their file access. Directory grants apply only to file
tools. This delivery adds no sandbox runtime.

The runner admits one new operation at a time, before spawning; same-ID retries
return the original operation and changed content conflicts. Requests bind the
machine, program, arguments, working directory and timeout (at most 120 seconds).
No implicit shell, inherited credentials or Herdr environment is supplied. Known
credentials and common secret patterns are filtered before results are persisted;
incomplete output from truncation or interruption also removes a trailing known
credential prefix. Admission storage failures latch the service off until restart;
ordinary conflict/capacity rejections do not mark healthy storage as failed.
arguments containing known credentials are refused. Outputs are never logged.

The root typecheck also covers independent Node processes. Worker bindings remain
required in `Env`, while Node child environments retain the standard optional
key/value shape. After `wrangler types`, remove only the generated global
`NodeJS.ProcessEnv` augmentation and its `StringifyValues` helper, as recorded in
the declaration file. Runtime compatibility flags and child environment allowlists
are unchanged; the Worker binding list does not belong in an Agent process.

Success/failure requires the real child exit code and closed output pipes. Output
capture is limited to 64 KiB combined, including notices, while excess pipe data
is drained. Spawn failure is failed with no exit code. Cancellation before spawn
is cancelled; after spawn it sends TERM then bounded KILL to the created process
group and returns unknown, since arbitrary commands can detach descendants or
have already applied effects. Timeout or lost exit evidence is also unknown.
Cancellation does not roll back effects. Network loss alone does not cancel or
replay commands. A journal write failure stops further admission.

These local process semantics do not establish authenticated remote routing,
file-provider grants, Bot integration or network reconnection. Those still require
separate integration tests and are not certified by the journal/runner slice.

## Execution transport v1

The independent `serve` process uses the selected private Agent configuration and
an outbound `/api/v1/execution-agent` WebSocket. Its machine Bearer and explicit
X-Eagle-Machine must agree. Native/Bot callers use an owner-authenticated
`/api/v1/execution?machine=<id>` socket; `/api/v1/execution/status?machine=<id>`
reports observed capabilities and online state. Neither channel needs Herdr or a
prior Herdr report. Existing registration, rotation and revocation remain the
machine identity authority. The ingestion host accepts only the Agent endpoint.

Messages use the strict v1 schemas in `packages/contracts/src/execution.ts`.
`run` binds an operation ID to its command; `get` queries the journal and `cancel`
requests cancellation. Each request has a connection-local request ID. A
duplicate pending request ID closes the viewer for reconciliation; a
duplicate never emits an ambiguous rejection for the original running request.
Initialization failure releases journal ownership before returning to its caller.
A lost reply is unknown; clients reconnect and query the original operation ID, never
generate another ID to replay an uncertain command. Results stay on the machine;
Temporary connection occupancy (HTTP 409) backs off and retries with the same
service/journal; only 401/403 are terminal handshake authentication failures.
the relay persists only routing/lease metadata and the last capability observation.
Offline targets reject execution and never fall back to the caller's machine.

There is one execution Agent connection per machine, at most 12 viewers and eight
pending requests per viewer. Requests are at most 16 KiB, messages 512 KiB and
results retain the journal's 64 KiB limit. Heartbeats expire after 35 seconds;
each get/cancel reply has a five-second deadline; run replies add five seconds
to the requested execution timeout. Expiry closes the caller with an unknown
outcome and never replays or cancels the operation. Pending routing binds the
request kind and Agent connection as well as IDs, including across hibernation.
authenticated leases last at most 15 minutes and require reconnection. Machine
revocation/rotation closes its channels. Unknown capabilities remain unknown
until a validated Agent hello. Commands default to disabled in `execution` config.
No arguments, output or credentials enter cloud storage or application logs.

## Independent macOS service

The candidate CLI manages only its configuration's user LaunchAgent through
`service install/start/stop/status`. Installation remains disabled until explicitly
started. A private receipt binds the canonical configuration, installed CLI and
Node paths to one exact launchd label. Its separate service-control lock serializes
changes; status is read-only and never opens the operation journal. Stop persists
the disabled state and remains usable even if configuration contents are damaged.
Journal recovery preserves unfinished outcomes as unknown. Launchd uses
`KeepAlive.Crashed` for its documented crash signals, not every termination:
ordinary authentication exit(1) does not trigger automatic restart, and SIGKILL
automatic restart is not promised. Service running and cloud connected remain distinct.
The owner's dashboard/API origin is separate from the Agent's ingestion origin.
Only the issued machine credential reaches Agent stdin/configuration; owner and
Access credentials remain in the native Keychain. Existing App/Bots/collector
services are never reused or stopped. One configuration owns one private directory.
The explicit `identity` setup command reserves a stable machine ID in that private
directory before cloud registration. Retries retain the ID, and `init` cannot
replace an existing configuration or contradict its reserved identity. If cloud
registration succeeded but local initialization failed, recovery explicitly rotates
that ID; a retry never silently registers another machine.

## File-provider reuse decision

The file provider stays a thin Node fs adapter. The approved-registry
`@modelcontextprotocol/server-filesystem@2026.8.31` tarball was inspected, not run:
its read/head/tail and directory listing lack the required byte/entry bounds;
realpath validation is separate from opening, without final no-follow, regular-file,
hard-link or grant-generation checks. Its complete stdio server also exposes write
and move operations and does not supply our revocation semantics. Importing that
server would still require replacing these boundaries. Its package references a
LICENSE absent from the tarball, so no license clearance is claimed. This decision
does not replace the reusable pi registry, official Herdr installer, ws/jose/Zod
or system launchd.

The file slice uses only `file.read` and `file.list`, with an explicit grant ID,
grant generation and relative path. The machine is the sole grant authority.
Reads and directory results are limited to 32 KiB; listing scans at most 2,000
entries. Symlinks, hard-linked files, special files and the Agent's private state
are excluded. Cancellation is checked during bounded work. Credential-like entry
names are omitted before JSON encoding rather than renamed to an inaccessible
path. A file operation has
no process exit code. Grant identity is rechecked at admission, retry, query and
before exposing a result; revocation also hides previously cached file output.
The Node adapter validates path components and opened file identity. These checks
are not OS isolation against a malicious process running as the same account.
The private state directory's identity is pinned for the provider lifetime and
rechecked before authorization and delivery; moving or replacing it fails closed.
Each authority read rechecks the owned 0700 directory and an owned 0600 regular
file without blocking on special files. Grant changes sync the file and directory
before success is reported.

## Optional Herdr provider

`herdr.setup` uses the same operation admission, query and cancellation as file
and command work. Its fixed actions are probe, install, configure, create_session,
verify and disable; commands need not be enabled. Installation first checks for an existing
CLI and never reinstalls it. A missing CLI downloads the installer from the fixed
official `https://herdr.dev/install.sh` URL into a fresh private staging directory.
No installer is copied into the Agent tarball. The official installer downloads
the current release and checks its published SHA-256; Eagle does not implement
another downloader/updater. Failed/interrupted candidates are retained, and
installation never overwrites an existing binary. Success is followed by real
probing, not a ready badge. The upstream source is
[herdrdev/herdr](https://github.com/herdrdev/herdr); its
[Apache-2.0 license](https://github.com/herdrdev/herdr/blob/master/LICENSE) was
independently retrieved on 2026-10-28 (SHA-256
`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`).
An explicit create_session starts a fresh named headless session, after refusing
any existing name, and verifies the new service. It does not stop, upgrade or
replace any existing Herdr server/session. The new server survives Agent exit;
interrupted creation is unknown and is reconciled by the original operation ID
and explicit name, without automatic retry or cleanup of a possibly running session.

The execution machine is fixed by the authenticated operation. Configuration
requires an explicit Herdr session name; every session API call passes
that name. CLI, server compatibility, session and the agent-list tool are probed
separately. Agent/Bot processes need not run inside Herdr and no HERDR_ENV is
invented. First-run UI steps remain local when no running session exists.
Missing/stopped selections can be corrected by selecting an existing session or
explicitly creating a new named session; nothing falls back to default. Actual OS
interaction or failed headless startup can still require local setup.
Configure/disable compare the observed configuration revision before saving;
inspect also binds that revision and the explicit session. Checks happen after
durable admission so retrying a completed setup returns its original evidence.
`herdr.inspect` exposes only agents/workspaces/panes of that selected session;
disable stops new plugin calls, retaining historical operation evidence. Status
refresh uses a new probe operation; get does not pretend cached output is fresh.
One deadline covers download, installation and verification (at most 120 seconds,
15 seconds by default for non-install actions). Cancellation after an installation
starts is unknown; a new operation is required after checking the preserved state.
