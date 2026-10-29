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
  reserialization). The exact seven newline-separated fields, without a trailing
  newline, are `eagle-device-register-v1`, HTTPS service origin (scheme + host +
  optional port), deviceId, publicKey, challengeId, 32 random bytes base64url,
  expiresAt (Unix milliseconds). The helper checks all seven fields against its
  own configured service/identity, UUIDs, nonce size and a future expiry <=60s;
  it must never blindly sign arbitrary stdout.
- `POST /register/complete` `{challengeId,signature}` returns
  `{device,sessionToken,expiresAt}`. The same flow refreshes a session for an
  existing key, never replaces an existing identity. Challenges expire in 60s
  and are single-use. Sessions expire in 15 minutes; only their hash is stored.
- Other HTTPS calls use `Authorization: Bearer <sessionToken>`; credentials are
  memory only. Registration and redemption have bounded server rate limits.
- `GET /directory` returns `{localDeviceId,groupId,revision,devices}`. Device:
  `{deviceId,publicKey,name,platform,arch,groupId,membershipEpoch,credentialVersion,
  online,lastSeenAt,capabilities,policy}`. `online` is true/false/null (unknown);
  lastSeenAt is Unix milliseconds/null; capabilities is an observed list of
  operation kinds/null; policy is observed policy/null. Only an authenticated
  Agent handshake/heartbeat supplies observations. Missing observation stays
  unknown, never inferred from registration or pairing.
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
sourceBotId?:string,operation?:{kind:"command",command,cwd?,timeoutMs?}|{kind:"file.read",path}|
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
does not prevent local readiness. The independent Keychain helper owns the Node lifecycle (SMAppService);
closing the App window does not end this pipe. Helper EOF stops the child cleanly.

Unix socket is JSONL request/response, one response per request:
`{requestId,method,params?}` → `{requestId,result}` or `{requestId,error}`.
Bot port read/execute methods: `status`, `directory`, `execute` (OperationRequest),
`operation.get`, `operation.cancel` (OperationRequest), `local.begin` and
`local.complete` and `local.heartbeat`. It rejects all management writes, including `policy.set`,
`pairing.create/revoke/redeem` and `member.remove`; 0600 alone does not distinguish
same-UID Bots from the App. `pairing.result` is App management only as well.
`local.begin` takes OperationRequest with `operation:{kind:"native",tool,args,cwd?}`
(native CodingTools only); it returns `{accepted:boolean,result,leaseId?,expiresAt?}`. Only accepted
true permits invoking the native tool. Duplicate begin always accepted false,
including a running prior admission. `local.complete` takes
`{operationId,leaseId,result}` and durably finalizes/releases the same device lock.
The initiating Bot keeps the same Unix socket open from begin through complete.
`local.heartbeat` `{operationId,leaseId}` on that socket renews a 30-second lease
and returns `{expiresAt}`; renew every 10 seconds. Socket closure or lease expiry
durably marks the native operation unknown and keeps device admission blocked.
A missing heartbeat never proves that the underlying native tool stopped. This
block survives service restart. Only the original owning lease can settle its
own operation with explicit completed/failed/cancelled evidence; a late completion
on the original socket is allowed. Disconnected-owner recovery needs a trusted
management evidence flow; until then the device stays blocked. Unknown completion
does not clear the block. A new random
leaseId is bound to the owning socket; stale/other-socket complete or heartbeat
is rejected and cannot release another admission. No native request is rerun.
Only the initiating local device may complete its native admission. Native and
remote tools share policy/journal/serial admission; interrupted native operations
recover unknown. Native is rejected by remote execute/relay. args is a JSON object;
the complete native operation participates in the same canonical parameter digest.

Management uses only the trusted helper's parent stdin:
`{type:"manage",requestId,method,params?}` → stdout
`{type:"managed",requestId,result}` or `{type:"managed",requestId,error}`.
Methods: `pairing.create` (`ttlSeconds?`), `pairing.revoke` (`code`),
`pairing.redeem` (`requestId,code`), `pairing.result` (`requestId`),
`member.remove` (`deviceId`), `policy.get`, `policy.set` (`mode`).
The Swift helper verifies its App requester code identity; it never exposes a
management credential or stdin handle to a Bot.

Approval is a distinct typed message, never an arbitrary `sign` payload.
Node stdout: `{type:"approve",requestId,operationId,sourceDeviceId,targetDeviceId,
operation,digest,policyVersion,expiresAt}`. Helper recomputes canonical digest,
checks its configured source identity and all bindings, asks the initiating App
to show the complete operation/target and confirm, then replies stdin
`{type:"approval",requestId,approval:<signed envelope>}` or
`{type:"approval",requestId,error}`. A Bot can only propose an approval through
`approval.request` (OperationRequest plus policyVersion/expiry), never approve.
No unattended/timeout fallback. The `sign` bridge accepts registration purpose
only; it rejects approval payloads and all other purposes.
Local directory always includes self;
remote entries are fetched live before remote execution. Multiple Bots share
this port and never copy device secrets. `status` returns
`{deviceId,localReady,cloudStatus,policy}`. App may open the same port for settings.
The local execution port accepts only operation-bound signed approval envelopes,
not a boolean or reusable approval token; all approval creation uses typed approve.

Local Node development can inject an in-memory signer; production App must use
Keychain. No npm publication, deployment or installation is implied by this
contract. Herdr is an optional provider, never needed for file/command tools.

Agent authentication frame includes `capabilities:[operation kinds],policy`;
`{type:"heartbeat",capabilities,policy}` refreshes actual observations every 10s.
Online observations expire after 30s without a heartbeat. sourceBotId is bounded
to 120 characters and is provenance only, never a permission boundary.

All command/file/native outcomes pass the same credential/PEM redactor before
journal persistence. stdout is bounded to 60 KiB and stderr to 4 KiB in UTF-8
bytes, without splitting characters; truncated known-secret fragments are masked.
A valid oversized native completion is sanitized and bounded, then committed.
Journal/storage failure returns unknown and preserves admission; it never reports
an admitted side effect as an unaccepted denial. Admission rechecks policy version,
service closure and approval expiry after asynchronous signature verification.
