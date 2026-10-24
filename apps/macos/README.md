# macOS client (placeholder)

Nothing is implemented here yet. This directory reserves the location and
records the constraints a macOS client must satisfy, so the repository
structure and CI can absorb it without another reorganization.

## Planned layout

```text
apps/macos/
  Package.swift          Swift package; `swift test` runs in CI without signing
  Sources/EagleKit/      API client, models, polling, WebSocket reconnection
  Sources/EagleApp/      SwiftUI menu-bar app, thin target over EagleKit
  Tests/EagleKitTests/   decoding regressions against the exported contracts
  README.md
```

`EagleKit` holds everything testable and platform-light; `EagleApp` only wires
SwiftUI views and scene lifecycle. Distribution stays unsigned first, with
`xattr -dr com.apple.quarantine` instructions in the GitHub Release, until a
Developer ID and notarization are explicitly authorized.

## First scope

Read-only monitoring: menu-bar fleet state from `GET /api/v1/overview`, a pane
list per machine, a read-only realtime view and `GET /api/v1/resources` charts.
Remote input control is deliberately out of scope: it needs the take-over
semantics in `docs/REALTIME.md` and a separate security review.

## Contracts and authentication

- Decode against generated contract data, not hand-copied field lists. The web
  and Worker consume the same schemas from `packages/contracts/src`; this
  directory should grow `packages/contracts/scripts/export.ts` producing a JSON
  contract file that both Swift tests and the browser can read.
- Viewer reads authenticate with a Cloudflare Access JWT in
  `Cf-Access-Jwt-Assertion`. A native client obtains it through an embedded
  `ASWebAuthenticationSession` against the Access login, or a future Access
  service token — that server-side branch does not exist yet and needs its own
  review.
- The realtime viewer socket requires `Origin: https://eagle.hexly.ai`
  (`apps/web/src/worker/index.ts`); a native client must set that header
  explicitly or the upgrade fails with 403.
- Private APIs send no CORS headers, so browser cookies are not reusable from a
  native context.

## CI

`check.yml` runs on Linux only. A macOS job (`swift build`, `swift test`) is
added together with the first Swift source, not before: an empty job would
report success without testing anything.
