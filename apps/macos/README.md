# Eagle for macOS

Pure SwiftUI client that mirrors one Herdr Space as one conversation. No
third-party dependencies: Foundation, SwiftUI, AppKit only.

Status: **template library and three-column shell with mock data**. No daemon or
network access yet; `EagleFeatures` view models hold static demo content.

## Run

```sh
cd apps/macos
./Scripts/build-app.sh && open .build/Eagle.app   # normal app window, Dock icon
swift run EagleApp          # same shell without a bundle; ⌘⇧G opens the gallery
swift test                 # Swift Testing suites for the logic layer
./Scripts/coverage.sh      # same tests plus a 90% logic-coverage gate
swift run SnapshotRenderer ../../.local/macos-snapshots   # PNGs for review
```

`swift build` and `swift run` work with Command Line Tools only. Two toolchain
limits shape the code:

- Swift Testing and the SwiftUI macros need the Xcode toolchain. The scripts
  export `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` when Xcode
  is installed; with Command Line Tools only, `swift build` still works but the
  test targets do not. View models use `ObservableObject` and views keep the
  `LocalState` shim so the app itself builds either way.
- `SnapshotRenderer` hosts each view in an offscreen `NSWindow` because
  `ImageRenderer` cannot draw AppKit-backed views such as `ScrollView` and
  `TextField`.

## Layout

```text
Package.swift
Sources/
  EagleDesign/       tokens and components, no feature state
    Theme.swift        palette, metrics, type scale sampled from the reference
    LocalState.swift   macro-free @State replacement
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

## Next

Wire `WorkspaceListViewModel` to `GET /api/v1/overview` (one Space per
conversation), then replace the mock transcript with pane activity. Input
control stays out of scope until the realtime take-over semantics are reviewed.
