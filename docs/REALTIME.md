# Space realtime mode

Open a machine, open a Space, then select **实时模式**. Eagle mirrors the current terminal text and tab/pane layout. **接管输入** grants one browser control of that Space; other browsers can watch. Select a pane, send text with or without Enter, or use the common key buttons. The local Herdr client remains able to operate concurrently. This release mirrors text screens; terminal colors, mouse reporting, pixel graphics and arbitrary PTY resize are not implemented.

The Basalt workspace sheet overlays the dashboard and widens for realtime mode. Pick a tab and a target pane in the controls above the black terminal canvas. Desktop retains the selected tab's pane layout; mobile shows the selected pane. Terminal output scrolls internally while the composer remains visible, including when the visual viewport shrinks for the keyboard. Enter submits the draft; switching targets clears the draft and releases input control. Reduced-motion preferences disable the sheet motion.

**设置 → 显示时区** controls all structured timestamps, calendar dates and hourly filters. It defaults to UTC+08:00 and stores only the fixed UTC offset in this browser; it does not follow daylight-saving changes or modify source timestamps/UTC archive boundaries. Half-hour and quarter-hour offsets show the corresponding local archive minutes. A blocked browser store keeps the preference in memory and reports that it cannot persist.

Run a separate user service with the same secure config:

```sh
eagle-agent realtime-watch
```

Use absolute executable paths and a PATH containing Herdr, as with `watch`. Default to direct connections; enable a proxy only through the [optional reporting proxy](../agent/README.md#optional-reporting-proxy) settings, with Node.js 24.5+ for WebSocket proxy support. Keep only one realtime bridge per machine configuration. This service is independent of the read-only collector and semantic Manager; it enables authenticated remote input. Deploy the compatible Worker before starting upgraded bridges. Agents older than v0.5.0 continue ordinary reporting but cannot provide realtime mode.

## Upgrade existing machines

Installing a new npm version updates the executable; it does not create or start a realtime service. Each machine needs its own `realtime-watch` process. An existing `watch` or `manager-watch` process does not provide the realtime connection.

1. Verify `eagle-agent --version` reports 0.5.0. Herdr must be running; native input currently requires Herdr 0.9.1 / protocol 22.
2. Reuse the existing collector's secure configuration, including its machine ID, token and ingestion URL. The default is `~/.config/eagle/agent.json`; preserve an existing custom `EAGLE_CONFIG` path. There are no additional realtime fields to add to that file.
3. If no realtime service is running, test `eagle-agent realtime-watch` in the foreground. For a custom config, use `EAGLE_CONFIG=/absolute/path/agent.json eagle-agent realtime-watch`. If authentication fails, correct that existing configuration; do not create a replacement machine or discard Manager state.
4. Stop the foreground test before enabling a separate user service with launchd on macOS or systemd on Linux. Use absolute executable paths and the same configuration/PATH as the working collector so the service can find Node and Herdr. Give it its own label/unit and preserve the collector and Manager services. If a realtime service already exists, restart that service after upgrading instead of adding a duplicate.
5. Reopen the Space in Eagle. `等待本机实时服务` means the machine's realtime bridge is not connected, even when ordinary snapshots are current. Once connected, viewing is available; select `接管输入` separately when input is intended.

## Transport and lifecycle

- Browser: same-origin `/api/v1/realtime?machine=M&space=S`, authenticated by the verified Access JWT. Upgrade requires the exact Origin. No machine token enters the browser or a URL.
- Bridge: outbound `/api/v1/realtime-agent`, authenticated with the machine Bearer in the handshake header. The configured `X-Eagle-Machine` must match the token identity before upgrade. Each machine's existing DO relays between the connections. No inbound machine port is exposed.
- The bridge resolves the session's local socket using `herdr session list --json`. Requests are bounded newline-delimited JSON. Screen collection uses `session.snapshot` and `pane.read`. Input uses the same session’s native client socket, protocol 22 (Herdr 0.9.1), with strict `AttachTerminal` by terminal ID and no takeover or name/pane fallback. Unsupported protocol versions fail closed.
- One polling loop per subscribed Space samples at 350 ms after the previous cycle. Herdr can return revision zero, so the bridge compares redacted screen content; up to four pane reads run together. Each read validates its returned workspace/tab and rechecks terminal identity after capture. Every subscription change refreshes initial topology/screens. Actual latency includes socket work and network round trips.
- Closing the sheet, navigating away, changing mode/Space, hiding the page or leaving it closes the browser socket and clears retry/heartbeat timers. Resuming the page obtains a fresh subscription. The last viewer's departure cancels the Space loop, pending socket reads and timers. Old subscription IDs cannot update a replacement subscription.
- Both clients send an immediate initial heartbeat (also avoiding workerd’s close-handshake edge case before the first application message). Connections continue heartbeating; a DO alarm reclaims leases after 35 seconds without messages, sharing the earliest deadline with the existing D1 outbox alarm. Bridges terminate unresponsive transport after 30 seconds and reconnect with bounded backoff; 401/403 authentication failures stop the bridge. Connections have a maximum 15-minute authorization lease; both ends renew by reconnecting through authentication; browser input control is not restored. Credential rotation/revocation closes existing connections.
- Bounds: 12 viewers, four distinct subscribed Spaces per machine; 32 panes/16 tabs per Space, 32,000 characters per screen, 8,000 characters per submitted input. Excess topology closes that live view rather than showing an incomplete control surface. Slow bridge connections abort polling immediately; viewer screen receipts enforce a 2 MiB / 128-frame outstanding budget. Viewers share a Space subscription. Routing attachments store compact identity hashes and cumulative delivery counters, not screen text.

## Input and evidence

Input requires a controller lease and a pane/terminal pair from the live topology. The bridge rechecks the Space and terminal against Herdr before writing. Only one input per browser may await acknowledgement; monotonically increasing sequences reject duplicates. A lost acknowledgement means **unknown**, and input is never automatically replayed after reconnect. After checking Space membership, the bridge binds the exact terminal ID, waits for its first full frame, rechecks membership and writes only through that bound connection. A replacement terminal cannot receive the old terminal’s input. Target changes clear drafts and control, and reconnects never replay inputs.

Screens redact known machine credentials across line wraps and recognizable viewport-edge fragments, common token formats, assignments and private keys. Truncated PEM blocks are masked; screens also conservatively hide consecutive base64 lines when both PEM boundaries are offscreen, which can hide unrelated encoded output. Pane titles are redacted before length limits. Input containing known credentials/recognized secret patterns is rejected by the bridge. Terminal text and input are not stored in D1, DO storage/attachments, report spools, browser storage or application logs. DO attachments retain only routing, public identity, lease and sequence metadata. A “submitted” receipt means the native control channel completed submission and detach; Herdr provides no per-input PTY acknowledgement. Text and Enter are separate queue entries and can partially fail under load. Check the returned screen; a receipt never certifies command success or Agent completion.

Native attach briefly controls terminal geometry and can resume a pending agent. Layout dimensions are only an estimate; attach/detach can resize the terminal and cause Herdr to reapply other tab geometry. There is no no-resize input API in protocol 22. Text uses a complete bracketed-paste message so Herdr applies the target’s paste mode; embedded escape/control bytes are rejected. Basic keys support legacy, Kitty and modifyOtherKeys modes. Direction keys are deferred because this protocol does not expose application-cursor mode. No terminal mouse/color/graphics/resize emulator is implied. Text containing newlines may execute when the target does not use bracketed paste.

## Verification

API tests use real isolated Miniflare/DO/D1. Bridge tests use a disposable Unix socket. Browser tests cover viewing, control, malformed-message cleanup, timezone conversion, light/dark overlays, reduced motion and viewport-constrained composers on desktop/mobile.

With a realtime bridge running, `scripts/verify-realtime.ts` creates a temporary sibling shell, sends a harmless marker command through the real web page, checks shell output and exercises four enter/leave cycles. It closes only the pane it created and saves a sanitized receipt and screenshot of that pane under `.local/`. Use the same local/public origin and Access-file environment as `scripts/verify-live.ts`.

The first-message close workaround is verified with workerd 1.20260918.1. A custom client that never sends any application message can still trigger that runtime’s delayed TCP-close behavior; Eagle’s browser and bridge always send the initial ping. The DO still removes the closed subscription and stops collection.
