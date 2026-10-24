# macOS client — design alignment (proposal)

Status: **proposal, awaiting decisions**. Nothing in this document is
implemented yet. Goal is a pure SwiftUI template library that mirrors one Herdr
Space as one conversation, in the visual language of Grok Bot's desktop app
rather than Basalt.

## Evidence used

- `~/Desktop/grokbot.png`, 3680 × 2392 px, Display P3, captured at 2×: the
  window measures **1840 × 1196 pt**.
- `/Applications/Grok Bot.app` (Electron, `com.anysphere.sand` 0.75.5). Its
  renderer ships two custom families, `X-VF` (UI sans) and `XMono-VF` (mono),
  so Grok Bot does **not** use SF Pro. No public SwiftUI design tokens exist to
  reuse; all values below were sampled from the screenshot.
- A `cua` computer-use CLI/skill is not installed on this machine, so live
  driving of the app was not possible. Measurements come from pixel sampling
  (sRGB-converted) and bundle inspection.

## Layout metrics (points)

```
window 1840 × 1196
┌──────────────┬──────────────────────────────┬─────────────┐
│ sidebar 411  │ conversation 996             │ inspector 319│
└──────────────┴──────────────────────────────┴─────────────┘
```

- Sidebar: header (search, compose) 44, profile block ~120, list rows 44 each,
  section headers 28, footer banner 52, current-user row 56.
- Conversation: message column starts 32 from the divider and is capped near
  700 wide; assistant turns are plain full-width text, user turns are right
  aligned pills (measured **128 × 35 pt** for a single short line, so radius =
  height / 2). Vertical rhythm: 22–28 between turns.
- Composer: 48 high, 24 inset, fully rounded, sits 20 above the bottom edge.
- Inspector: 320 wide, 64 avatar, 24 inset, cards 10 radius with 1 px border,
  row height 34, section gap 20.

## Color tokens (sampled, sRGB)

| Token | Value | Where it came from |
| --- | --- | --- |
| `canvas` | `#F4F4F4` | sidebar fill |
| `surface` | `#FCFCFC` | conversation and inspector fill |
| `card` | `#FFFFFF` | list cards, composer |
| `line` | `#EEEEEE` | dividers, card borders |
| `textPrimary` | `#252525` | message and row text |
| `textSecondary` | `#757575` | subtitles, section labels |
| `accent` | `#3B7DCD` | inline links |
| `accentFill` | `#55A471` | user bubble fill |
| `accentStrong` | `#5DB57B` | toggles, typing indicator |

Notes: the palette is effectively monochrome plus one green. There is no
gradient, no shadow heavier than a 1 px line, and no colored chrome. Avatars are
the only saturated elements besides the bubble and switches.

## Typography (proposal, since SF differs from X-VF)

| Role | Size / weight |
| --- | --- |
| Row title | 13 semibold, one line, tail truncation |
| Row subtitle | 12 regular, secondary, tail truncation |
| Section label | 11 medium, secondary, tracking +0.2 |
| Message body | 13 regular, line spacing 4, `textPrimary` |
| Bubble text | 13 regular, white |
| Delivery note | 11 regular, secondary, centered |
| Composer placeholder | 13 regular, secondary |
| Inspector title | 15 semibold |
| Inspector subtitle | 12 regular, secondary |
| Card title | 12 medium |
| Monospaced tokens | 12 regular `SF Mono` |

## Component inventory from the screenshot

Sidebar: window drag region with traffic lights, search icon button, compose
button, organization header (56 avatar, name, plan label), section header with
count, conversation row (30 avatar, title, subtitle, optional `Personal` tag),
unread banner (inline link), current-user footer row.

Conversation: sender attachment card (avatar + name, 10 radius), assistant turn
(plain text, no bubble, bulleted lists), delivery note with mini avatars
("已发送给 … 8 个智能体"), user turn (green pill, right aligned), typing row
(spinner + `正在输入...`), composer (attach button, placeholder that names the
recipient, mic and waveform buttons).

Inspector: close and share icon buttons, 64 avatar, name, subtitle, segmented
tabs (详情 / 资料库 / 电脑), section label, list card of rows with a code icon,
title and chevron, `展开` action, second section with task rows and green
switches.

## Proposed SwiftUI template library

Target: `apps/macos`, SPM package with three targets, no third-party
dependencies, macOS 14+ for `@Observable`.

```text
Sources/
  EagleDesign/        tokens + primitives, previewable in isolation
    Theme.swift           colors, metrics, typography, radii
    Primitives/           Avatar, Tag, IconButton, SectionLabel, ChevronRow,
                          ToggleRow, SegmentedTabs, Divider
    Chat/                 Transcript, AssistantTurn, UserBubble, DeliveryNote,
                          TypingIndicator, Composer
    Panels/               SidebarList, ConversationColumn, InspectorColumn,
                          ThreeColumnShell
  EagleFeatures/      MVVM
    WorkspaceListViewModel.swift   spaces → conversations (mock for now)
    ChatViewModel.swift            messages, draft, typing state
    InspectorViewModel.swift       token list, scheduled jobs
  EagleApp/           thin AppKit/SwiftUI app target
    EagleApp.swift, MenuCommands, WindowRoot
Tests/
  EagleDesignTests/   token snapshot + layout math
  EagleFeaturesTests/ view-model behaviour against mock spaces
```

Rules for the library: one file per component, every component gets a
`#Preview` with fixed sample data, no component reaches for global state, colors
and spacing come only from `Theme`, and no dependency outside Foundation +
SwiftUI + AppKit.

## MVVM shape and the Herdr mapping

`WorkspaceListViewModel` owns `[Conversation]`. Today `Conversation` is mock
data; later it is built from `/api/v1/overview` — one Herdr Space becomes one
conversation, its panes become participant agents, and the sidebar grouping
follows the existing machine groups.

`ChatViewModel` owns the transcript. Later the daemon's pane activity becomes
assistant turns and terminal input becomes user turns; for now `send()` appends
to a local array so the composer and scroll behaviour can be designed properly.

`InspectorViewModel` owns the detail column: evidence/artifact rows and
scheduled jobs, matching the right panel's 详情 / 资料库 / 电脑 tabs.

## Deliberate differences from Basalt

Basalt is a component library with its own surfaces, meters and color system.
This client follows Grok Bot instead: 13 pt body text, 1 px lines, monochrome
plus one green, near-square 10 pt card radii, and no elevation. Accessibility
still matters: text/background contrast stays above 4.5:1, every icon button
keeps a label and 24 pt hit target, and the green bubble uses white text.

## Decisions taken

1. **Typography**: SF Pro only. No font assets are shipped; the reference uses a
   private grotesque (`X-VF`) that cannot be reproduced without licensing.
2. **Layout**: fixed sidebar 411 and inspector 319, conversation flexible, with
   a `showsInspector` switch ready for a collapse toggle.
3. **Window chrome**: native title bar. The content starts below it instead of
   drawing traffic lights over the sidebar.
4. **Color**: the sampled values are used verbatim, including
   `#55A471`/`#5DB57B`; white text on the bubble stays above 4.5:1.
5. **First slice**: template gallery plus the three-column shell on mock data,
   with a composer that appends locally.
6. **App shell**: SPM package with an `EagleApp` executable. No Xcode project,
   so the tree builds with Command Line Tools; a bundled `.app` and signing are
   a later, separately scoped step.

## Toolchain constraints discovered

Command Line Tools only (no Xcode) means the SwiftUI macro plugin is missing:
`@State`, `@Observable` and `#Preview` do not compile, and neither Swift Testing
macros nor XCTest are available. The package therefore targets `.macOS(.v15)`,
uses `ObservableObject` view models, a `LocalState` property-wrapper shim, and a
plain `EagleChecks` executable for assertions. Installing full Xcode would allow
dropping the shim and restoring previews.
