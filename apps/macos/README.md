# Eagle for macOS

Pure SwiftUI client that mirrors one Herdr Space as one conversation. No
third-party dependencies: Foundation, SwiftUI, AppKit only.

Status: **Bots and device services are integrated**. The App connects to the local
Bots daemon (`apps/bots`) and bundled device service, with real settings for device
readiness, execution policy and pairing. Local command execution and a physical
MacMini-2 → MacMini 1 command with original-ID result retrieval have been verified.
Fresh-Mac installation and reverse-direction acceptance remain unverified.
Other overview and inspector content still includes demos.

## Build the pairing candidate on another Mac

Requires **macOS 15+**, Xcode or Command Line Tools, and an **official standalone
Node 24+** distribution matching the Mac's CPU. Download/extract it from
[nodejs.org](https://nodejs.org/en/download); Homebrew Node with non-system dynamic
library dependencies is rejected by the portable-runtime check. Adjust the example
Node path below (shown for arm64 Node 26.9.0; use the x64 distribution on Intel).

From the `device-groups/eagle` branch of `https://github.com/MashellHan/eagle.git`,
run in the repository root. Keep the machine's approved npm registry and both locks:

```sh
export EAGLE_NODE_BINARY="$HOME/Downloads/node-v26.9.0-darwin-arm64/bin/node"
export PATH="$(dirname "$EAGLE_NODE_BINARY"):$PATH"
umask 077
mkdir -p .local
EAGLE_PAIRING_CACHE="$(mktemp -d "$(pwd)/.local/pairing-npm.XXXXXX")"
export EAGLE_AGENT_NPM_CACHE="$EAGLE_PAIRING_CACHE/root"
export EAGLE_BOTS_NPM_CACHE="$EAGLE_PAIRING_CACHE/bots"
npm ci --cache "$EAGLE_AGENT_NPM_CACHE"
npm --prefix apps/bots ci --cache "$EAGLE_BOTS_NPM_CACHE"
export EAGLE_DEVICE_PROFILE=device-candidate
export EAGLE_DEVICE_SERVICE_URL=https://eagle-devices.hexly.ai
export EAGLE_CODESIGN_IDENTITY=-
apps/macos/Scripts/build-app.sh debug
node apps/macos/Scripts/install-device-app.ts \
  "apps/macos/.build/device-candidate/Eagle Device Candidate.app"
```

The two normal installs populate task-private caches; assembly verifies locked
package bytes and installs the bundled Agent/Bots runtime offline. The output is
`apps/macos/.build/device-candidate/Eagle Device Candidate.app`. The installer
verifies it, quits the installed UI, and waits for the old device service to
unregister before replacing the **whole bundle** in `~/Applications` and opening
the new App. It verifies that the old job and process are gone and retains the
previous signed bundle at the backup path it prints. A failed preparation leaves
the existing bundle in place. Use this installer for upgrades; do not edit or
re-sign an installed bundle in place. This is an ad-hoc candidate, not a notarized release.

Automatic upgrades are verified between candidates with update-preparation support.
Earlier preview builds that cannot confirm their old service has stopped are left
in place; migration across service names is not guaranteed for those builds.

Omitting the service URL defaults to localhost for local development. **Both Macs
must explicitly build with the HTTPS origin above for pairing**, including later UI
updates. Each Mac creates its own identity; do not copy credentials, sessions or
old localhost state. Bot command checks need a working model configuration on the
Mac initiating them; credentials are not part of these instructions or the bundle.

1. On both Macs, open `⌘,` → **设备**. The service starts automatically; allow the
   background item if macOS requests it. Wait for **本机可用** and **云端已连接**.
2. On B, generate a one-hour pairing code; enter it once on A. If the result is
   uncertain, use **查询配对结果** to recover the original request.
3. Refresh both device lists: both Macs should appear online, with distinct device
   IDs and the correct **本机** label on each. Record each Mac's local `/bin/hostname`.
4. Ask a Bot on A to read the device list and run `/bin/hostname` explicitly on B's
   device ID; compare its actual output with B's local result. Repeat B → A. Check
   the returned target/operation IDs; a local fallback or model-only answer is not a pass.

These steps cover fresh pairing and both execution directions; the observed
physical A-to-B command does not establish every step on a clean machine.

## Development commands

```sh
cd apps/macos
swift run EagleApp          # same shell without a bundle; ⌘⇧G opens the gallery
swift test                 # Swift Testing suites for the logic layer
./Scripts/coverage.sh      # same tests plus a 90% logic-coverage gate
swift run SnapshotRenderer ../../.local/macos-snapshots   # PNGs for review
swift run SnapshotRenderer ../../.local/macos-inspector --inspector-only   # static inspector fixtures only
swift run SnapshotRenderer ../../.local/macos-services --services-only   # isolated search-provider fixtures only
```

Packaged candidates use their bundled Node/Bots and isolated candidate profile;
the development overrides below do not select their runtime or data directories.
For source-only development, the app walks up from the executable for
`apps/bots/scripts/serve.ts` (or uses `BOTS_DAEMON_DIR`), starts it with the
machine's Node (`BOTS_NODE`, then Homebrew/`/usr/bin`), shows its state in
Settings → `模型`, and terminates only the daemon it started when the app
quits. A daemon started outside the app is reported as external and left alone.
`BOTS_ROOT`/`BOTS_PORT` move both the app and the daemon together.

`swift build` and `swift run` work with Command Line Tools only. Two toolchain
limits shape the code:

- Swift Testing and the SwiftUI macros need the Xcode toolchain. The scripts
  export `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` when Xcode
  is installed; with Command Line Tools only, `swift build` still works but the
  test targets do not. View models use `ObservableObject` and views keep the
  Xcode toolchain for tests; `swift build` also works with Command Line
  Tools alone.
- `SnapshotRenderer` hosts each view in an offscreen `NSWindow` because
  `ImageRenderer` cannot draw AppKit-backed views such as `ScrollView` and
  `TextField`.

## Layout

```text
Package.swift
Sources/
  EagleDesign/       tokens and components, no feature state
    Theme.swift        palette, metrics, type scale sampled from the reference
    Primitives/        Avatar, Tag, SectionLabel, IconButton, ChevronRow,
                       ToggleRow, SwitchToggle, SpinnerArc, SegmentedTabs,
                       EdgeFade, ResizeHandle
    Chat/              AssistantTurn, UserBubble, SenderChip, DeliveryNote,
                       TypingIndicator, Composer
    Panels/            SidebarPanel, ConversationColumn, InspectorColumn,
                       ThreeColumnShell
    Gallery/           TemplateGallery
  EagleFeatures/     ObservableObject view models and mock data
  EagleApp/          AppKit delegate, window, gallery window
  SnapshotRenderer/  offscreen PNG renderer
  Scripts/           build-app, make-icon, coverage
```

Design rules: one component per file, colors and spacing only from `Theme`, no
global state inside components, no elevation except the sender chip and the
unread pill, monochrome plus one green, and scroll edges fade instead of
clipping. Groups expand and collapse with animation; right-clicking a group or a
conversation offers rename/delete, and the header menu creates groups. Column
widths are draggable and both side columns collapse. See [DESIGN.md](DESIGN.md).

The inspector's task hierarchy uses fine dashed gutter lines and rounded final
elbows, rather than indentation alone. Each parent has one continuous trunk that
ends at its last visible child; independent roots are never joined. Row height,
task ordering, status and retry/stop controls remain unchanged. Guides are purely
decorative and never intercept pointer or accessibility interaction.

## Template library

The sidebar's grid button and File -> Template Library open the same reusable
gallery window (Command-Shift-G). The gallery has category navigation, a local
light/dark preview switch and interactive identity/composer examples; it never
submits preview text to a model. Footer utilities are separate from the account
button. Circular icon controls use the shared hover and border treatment.

## Next

Wire `WorkspaceListViewModel` to `GET /api/v1/overview` (one Space per
conversation), then replace the mock transcript with pane activity. Input
control stays out of scope until the realtime take-over semantics are reviewed.
