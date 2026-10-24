# Eagle for macOS

Pure SwiftUI client that mirrors one Herdr Space as one conversation. No
third-party dependencies: Foundation, SwiftUI, AppKit only.

Status: **template library and three-column shell with mock data**. No daemon or
network access yet; `EagleFeatures` view models hold static demo content.

## Run

```sh
cd apps/macos
swift run EagleApp          # three-column window; ⌘⇧G opens the template gallery
swift run EagleChecks       # dependency-free assertions, exits non-zero on failure
swift run SnapshotRenderer ../../.local/macos-snapshots   # PNGs for review
```

`swift build` and `swift run` work with Command Line Tools only. Two toolchain
limits shape the code:

- SwiftUI's macros (`@State`, `@Observable`, `#Preview`) and Swift Testing's
  macros are unavailable without full Xcode, and XCTest ships only with Xcode.
  `LocalState` in `EagleDesign` is a `StateObject`-backed replacement for
  `@State`, view models use `ObservableObject`, and checks run as the
  `EagleChecks` executable instead of a test framework.
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
                       ToggleRow, SwitchToggle, SpinnerArc, SegmentedTabs
    Chat/              AssistantTurn, UserBubble, DeliveryNote, TypingIndicator,
                       Composer
    Panels/            SidebarPanel, ConversationColumn, InspectorColumn,
                       ThreeColumnShell
    Gallery/           TemplateGallery
  EagleFeatures/     ObservableObject view models and mock data
  EagleApp/          AppKit delegate, window, gallery window
  SnapshotRenderer/  offscreen PNG renderer
  EagleChecks/       assertions
```

Design rules: one component per file, colors and spacing only from `Theme`, no
global state inside components, no elevation or gradients, monochrome plus one
green. See [DESIGN.md](DESIGN.md) for the measurements and the decisions taken.

## Next

Wire `WorkspaceListViewModel` to `GET /api/v1/overview` (one Space per
conversation), then replace the mock transcript with pane activity. Input
control stays out of scope until the realtime take-over semantics are reviewed.
