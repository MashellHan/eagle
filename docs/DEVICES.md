# Shared devices — wire v1

Status: implementation contract, 2026-10-29. Independent of owner/v1 and Bots wire.
Base path `/api/devices/v1`; JSON UTF-8, strict objects, camelCase. All responses
use `Cache-Control: no-store`; errors `{error: code}`. Credentials never use URLs.

## Identity and HTTPS

Device identity is an Ed25519 key persisted only by the App Keychain helper.
`deviceId` is a UUID generated once by the App; `publicKey` is base64url DER SPKI.
Signatures are base64url raw Ed25519. Node and Bots never receive the private key.

- `POST /register/challenge` `{deviceId,publicKey,name,platform,arch}` returns
  `{challengeId,payload,expiresAt}`. Sign the exact UTF-8 `payload` (no JSON
  reserialization); challenge binds purpose, device ID, key and random nonce.
- `POST /register/complete` `{challengeId,signature}` returns
  `{device,sessionToken,expiresAt}`. The same flow refreshes a session for an
  existing key, never replaces an existing identity. Challenges expire in 60s
  and are single-use. Sessions expire in 15 minutes; only their hash is stored.
- Other HTTPS calls use `Authorization: Bearer <sessionToken>`; credentials are
  memory only. Registration and redemption have bounded server rate limits.
- `GET /directory` returns `{localDeviceId,groupId,revision,devices}`. Device:
  `{deviceId,name,platform,arch,groupId,membershipEpoch,credentialVersion}`.
  Ungrouped devices see themselves; group members see all current members.
- `POST /pairings` `{ttlSeconds?:3600}` returns `{code,expiresAt}`; code is 32
  random bytes base64url, maximum TTL 86400 seconds. Only its SHA-256 is stored.
- `POST /pairings/revoke` `{code}` invalidates an unused invitation of this device.
- `POST /pairings/redeem` `{requestId,code}` returns `{requestId,groupId,directory}`.
  Persist requestId before sending. Same requestId with another code conflicts.
- `GET /pairings/results/<requestId>` returns the original committed result plus
  current `directory`, or 404. Same redeemer and same code recover the first
  committed result even with a new requestId. Another redeemer cannot reuse it.
- `POST /members/remove` `{deviceId}` removes self or another current same-group
  member; increments that member's epoch and credential version. Old sessions,
  sockets and invitations fail closed. Removed devices can authenticate again
  with their existing key and pair again; historical results never rejoin them.

Registry SQLite in one deployment-wide DO is the sole authority. Redemption
validates and changes membership, consumes the invitation and stores the result
in one synchronous transaction without network awaits. Two ungrouped devices
create a group; exactly one grouped device retains its group regardless of code
input direction; same group is idempotent; different groups conflict without
consumption. Invitation issuance epoch must still match. Results retain 7 days.

## Execution

Agent opens one outbound WSS `/execution/<targetDeviceId>/agent` and sends
`{type:"authenticate",sessionToken}`; server returns `{type:"ready"}`. Caller
opens one WSS `/execution/<targetDeviceId>/request`, sends
`{type:"request",sessionToken,request:<OperationRequest>}` and receives exactly
one `{type:"response",requestId,operationId,targetDeviceId,result}` then closes.
Every run/get/cancel rechecks live Registry source and target membership.

OperationRequest: `{requestId,operationId,targetDeviceId,action:"run"|"get"|"cancel",
operation?:{kind:"command",command,cwd?,timeoutMs?}|{kind:"file.read",path}|
{kind:"file.write",path,content}|{kind:"file.list",path},digest?,approval?}`.
IDs are UUIDs. `digest` is lowercase SHA-256 of recursively key-sorted compact
JSON of `operation` (UTF-8; omitted optional fields omitted). Target and digest
are immutable for an operation ID. Source is derived from session, never trusted
from caller. Relay sends `{type:"operation",sourceDeviceId,sourcePublicKey,request}`;
agent responds `{type:"result",requestId,operationId,targetDeviceId,result}`.
Result: `{status:"running"|"completed"|"failed"|"cancelled"|"unknown"|"busy"|
"denied",output?,error?,exitCode?}`. busy means unaccepted, never queued.
A lost response means query the same ID; never automatically run again or switch
target. Journal admission precedes side effects; interrupted running entries
recover as unknown, never rerun. get/cancel remain usable during a running job.
A target's local operations use the same journal and policy, without cloud.

Policy `{mode:"all-approve"|"always-ask"|"paused",version:positive integer}` is
persisted by target. Default all-approve. Always ask is confirmed in the initiating
App. Approval envelope `{operationId,sourceDeviceId,targetDeviceId,digest,
policyVersion,expiresAt,signature}` signs exact UTF-8
`eagle-device-approval-v1\n<operationId>\n<sourceDeviceId>\n<targetDeviceId>\n<digest>\n<policyVersion>\n<expiresAt>`.
Expiry is Unix milliseconds, at most 5 minutes ahead. Registry relay and target
verify the initiating device public key and all bindings; `approved=true` is
invalid. Unconfirmed requests are denied, never automatically approved.

## Private App helper and local port

App bundles Node + Agent and launches `dist/agent/device-service.js` with no
credentials in argv or environment. Parent-child stdin/stdout is private JSONL.
App first writes `{type:"configure",version:1,baseUrl,deviceId,publicKey,name,
platform,arch,stateDirectory,socketPath}`. stateDirectory is App-private 0700;
socketPath is an App-private Unix socket (0600), not a public TCP port. Public key
and IDs may be persisted there; private key and session tokens may not.

Node requests Keychain signatures through stdout
`{type:"sign",requestId,payload}`; App/helper replies through stdin
`{type:"signature",requestId,signature}` or `{type:"signature",requestId,error}`.
Only exact requested payloads are signed; helper validates identity/purpose.
Node emits `{type:"ready",socketPath,deviceId}` after local tools/port are ready,
and `{type:"cloud",status:"online"|"offline",error?}` separately. Cloud failure
does not prevent local readiness. App EOF stops the child cleanly.

Unix socket is JSONL request/response, one response per request:
`{requestId,method,params?}` → `{requestId,result}` or `{requestId,error}`.
Methods: `status`, `directory`, `pairing.create` (`ttlSeconds?`),
`pairing.revoke` (`code`), `pairing.redeem` (`requestId,code`),
`pairing.result` (`requestId`), `member.remove` (`deviceId`), `policy.get`,
`policy.set` (`mode`), `execute` (OperationRequest), `operation.get`
and `operation.cancel` (OperationRequest). Local directory always includes self;
remote entries are fetched live before remote execution. Multiple Bots share
this port and never copy device secrets. `status` returns
`{deviceId,localReady,cloudStatus,policy}`. App may open the same port for settings.
The parent signing bridge also serves operation-bound approvals; the local port
accepts only signed approval envelopes, not a boolean or reusable approval token.

Local Node development can inject an in-memory signer; production App must use
Keychain. No npm publication, deployment or installation is implied by this
contract. Herdr is an optional provider, never needed for file/command tools.
