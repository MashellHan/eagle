# Eagle for macOS

Pure SwiftUI client that mirrors one Herdr Space as one conversation. No
third-party dependencies: Foundation, SwiftUI, AppKit only.

Status: **Bots is live, the rest is mock**. The shell connects to the local Bots
daemon (`apps/bots`), starts it on launch when it can find it, and stops it on
quit; the sidebar groups, inspector artifacts and settings pages other than the
Bots ones are still demo content.

## Run

```sh
cd apps/macos
./Scripts/build-app.sh && open .build/Eagle.app   # normal app window, Dock icon
swift run EagleApp          # same shell without a bundle; ⌘⇧G opens the gallery
swift test                 # Swift Testing suites for the logic layer
./Scripts/coverage.sh      # same tests plus a 90% logic-coverage gate
swift run SnapshotRenderer ../../.local/macos-snapshots   # PNGs for review
swift run SnapshotRenderer ../../.local/macos-inspector --inspector-only   # static inspector fixtures only
```

The app supervises the daemon: it walks up from the executable for
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
