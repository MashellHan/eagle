# Space realtime mode

Open a machine, open a Space, then select **实时模式**. Eagle mirrors the current terminal text and tab/pane layout. **接管输入** grants one browser control of that Space; other browsers can watch. Select a pane, send text with or without Enter, or use the common key buttons. The local Herdr client remains able to operate concurrently. This release mirrors text screens; terminal colors, mouse reporting, pixel graphics and arbitrary PTY resize are not implemented.

Run a separate user service with the same secure config:

```sh
eagle-agent realtime-watch
```

Use absolute executable paths and a PATH containing Herdr, as with `watch`. Keep only one realtime bridge per machine configuration. This service is independent of the read-only collector and semantic Manager; it enables authenticated remote input. Deploy the compatible Worker before starting upgraded bridges. Agents older than v0.5.0 continue ordinary reporting but cannot provide realtime mode.

## Transport and lifecycle

- Browser: same-origin `/api/v1/realtime?machine=M&space=S`, authenticated by the verified Access JWT. Upgrade requires the exact Origin. No machine token enters the browser or a URL.
- Bridge: outbound `/api/v1/realtime-agent`, authenticated with the machine Bearer in the handshake header. Each machine's existing DO relays between the connections. No inbound machine port is exposed.
- The bridge resolves the session's local socket using `herdr session list --json`. Requests are bounded newline-delimited JSON. Only `session.snapshot`, `pane.read`, and `pane.send_input` are used.
- One polling loop per subscribed Space samples at 350 ms after the previous cycle. Pane revision numbers suppress unchanged reads; up to four pane reads run together. Every subscription change refreshes its initial topology/screens. Actual latency includes socket work and network round trips.
- Closing the sheet, navigating away, changing mode/Space, hiding the page or leaving it closes the browser socket and clears retry/heartbeat timers. Resuming the page obtains a fresh subscription. The last viewer's departure cancels the Space loop, pending socket reads and timers. Old subscription IDs cannot update a replacement subscription.
- Connections heartbeat and expire after 35 seconds without messages. Bridges terminate unresponsive transport after 30 seconds and reconnect with bounded backoff; 401/403 authentication failures stop the bridge. Connections have a maximum 15-minute authorization lease; the browser can reconnect through Access. Credential rotation/revocation closes existing connections.
- Bounds: 12 viewers, four distinct subscribed Spaces per machine; 32 panes/16 tabs per Space, 32,000 characters per screen, 8,000 characters per submitted input. Excess topology closes that live view rather than showing an incomplete control surface. Slow bridge connections are disconnected at a bounded outgoing queue.

## Input and evidence

Input requires a controller lease and a pane/terminal pair from the live topology. The bridge rechecks the Space and terminal against Herdr before writing. Only one input per browser may await acknowledgement; monotonically increasing sequences reject duplicates. A lost acknowledgement means **unknown**, and input is never automatically replayed after reconnect. Herdr's current API does not offer an atomic expected-terminal precondition; validation and input are separate socket requests.

Screens redact known machine credentials, common token formats, assignments and private keys. Input containing known credentials/recognized secret patterns is rejected by the bridge. Terminal text and input are not stored in D1, DO storage/attachments, report spools, browser storage or application logs. DO attachments retain only routing, public identity, lease and sequence metadata. A delivery receipt confirms Herdr accepted input, not that a command succeeded or an Agent completed its task.

## Verification

API tests use real isolated Miniflare/DO/D1. Bridge tests use a disposable Unix socket. Browser tests cover viewing, control and cleanup on desktop/mobile.

With a realtime bridge running, `scripts/verify-realtime.ts` creates a temporary sibling shell, sends a harmless marker command through the real web page, checks shell output and exercises four enter/leave cycles. It closes only the pane it created and saves a sanitized receipt and screenshot of that pane under `.local/`. Use the same local/public origin and Access-file environment as `scripts/verify-live.ts`.
