import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Design tokens")
struct ThemeTests {
  @Test("layout metrics follow the measured reference grid")
  func metrics() {
    #expect(Theme.Metric.windowWidth == 1728)
    #expect(Theme.Metric.windowHeight == 1082)
    #expect(Theme.Metric.sidebarWidth == 374)
    #expect(Theme.Metric.inspectorWidth == 319)
    #expect(Theme.Metric.contentInset == 20)
    #expect(Theme.Metric.rowHeight == 58)
    #expect(Theme.Metric.avatarRow == 34)
    #expect(Theme.Metric.sectionHeaderHeight == 24)
    #expect(Theme.Metric.sectionGap == 22)
    #expect(Theme.Metric.profileAvatar == 55)
    #expect(Theme.Metric.toolbarHeight == 36)
    #expect(Theme.Metric.unreadPillHeight == 28)
    #expect(Theme.Metric.inspectorRowHeight == 40)
    #expect(Theme.Metric.composerHeight == 54)
    #expect(Theme.Metric.cardRadius == 12)
    #expect(Theme.Metric.pinnedHeaderHeight == 70)
  }

  @Test("column clamps stay ordered")
  func clamps() {
    #expect(Theme.Metric.sidebarMinWidth < Theme.Metric.sidebarWidth)
    #expect(Theme.Metric.sidebarWidth < Theme.Metric.sidebarMaxWidth)
    #expect(Theme.Metric.inspectorMinWidth < Theme.Metric.inspectorWidth)
    #expect(Theme.Metric.inspectorWidth < Theme.Metric.inspectorMaxWidth)
  }

  @Test("palette keeps the sampled values")
  func palette() {
    expectColor(Theme.Palette.canvas, 0xF7F7F5)
    expectColor(Theme.Palette.surface, 0xFFFFFF)
    expectColor(Theme.Palette.card, 0xFFFFFF)
    expectColor(Theme.Palette.line, 0xECECEA)
    expectColor(Theme.Palette.textPrimary, 0x252525)
    expectColor(Theme.Palette.textSecondary, 0x757575)
    expectColor(Theme.Palette.textMuted, 0xA7A7A7)
    expectColor(Theme.Palette.accent, 0x3B7DCD)
    expectColor(Theme.Palette.accentFill, 0x4FA46A)
    expectColor(Theme.Palette.accentStrong, 0x58B378)
  }

  @Test("avatar tints wrap and treat negatives by magnitude")
  func avatarTints() {
    #expect(Theme.Palette.avatarTints.count == 7)
    expectColor(Theme.Palette.avatarTint(0), 0xEC5858)
    expectColor(Theme.Palette.avatarTint(7), 0xEC5858)
    expectColor(Theme.Palette.avatarTint(6), 0x68C488)
    // Negative indices use the magnitude, matching the avatar helper contract.
    expectColor(Theme.Palette.avatarTint(-1), 0x5098F4)
  }
}

@Suite("Sidebar data")
struct SidebarDataTests {
  @Test("items keep identity and optional tags")
  func items() {
    let plain = SidebarItem(id: "a", title: "A", subtitle: "b")
    let tagged = SidebarItem(id: "a", title: "A", subtitle: "b")
    #expect(plain == tagged)
    #expect(plain.tag == nil)
    #expect(SidebarItem(id: "a", title: "A", subtitle: "b", tag: "Personal").tag == "Personal")
  }

  @Test("sections carry expansion state")
  func sections() {
    let collapsed = SidebarSection(id: "s", title: "S", count: 3, isExpanded: false, items: [])
    #expect(collapsed.isExpanded == false)
    #expect(collapsed.count == 3)
    #expect(SidebarSection(id: "s", title: "S", items: []).isExpanded)
  }
}

@Suite("Transcript rows")
struct TranscriptTests {
  @Test("every row exposes a stable identifier")
  func identifiers() {
    let rows: [TranscriptEntry] = [
      .assistant(id: "a1", blocks: [.paragraph("x")]),
      .user(id: "u1", text: "y"),
      .note(id: "n1", text: "z", tintIndices: [0]),
      .typing(id: "t1"),
    ]
    #expect(rows.map(\.id) == ["a1", "u1", "n1", "t1"])
    #expect(Set(rows.map(\.id)).count == rows.count)
  }

  @Test("sender is plain value data")
  func sender() {
    #expect(TranscriptSender(name: "A", tintIndex: 2) == TranscriptSender(name: "A", tintIndex: 2))
    #expect(TranscriptSender(name: "A", tintIndex: 2) != TranscriptSender(name: "B", tintIndex: 2))
  }

  @Test("assistant blocks compare by content")
  func blocks() {
    #expect(AssistantTurn.Block.paragraph("x") == .paragraph("x"))
    #expect(AssistantTurn.Block.bullets(["a"]) != .bullets(["b"]))
  }
}

@Suite("Local state")
struct LocalStateTests {
  @Test("binding writes through to the value")
  func writesThrough() {
    let state = LocalStateStorage(1)
    #expect(state.value == 1)
    state.value = 7
    #expect(state.value == 7)
  }

  @Test("collections keep reference semantics")
  func collections() {
    let state = LocalStateStorage(["a"])
    state.value.append("b")
    #expect(state.value == ["a", "b"])
  }
}

private func expectColor(
  _ color: Color,
  _ hex: UInt32,
  sourceLocation: SourceLocation = #_sourceLocation
) {
  guard let actual = NSColor(color).usingColorSpace(.sRGB) else {
    Issue.record("colour is not convertible to sRGB", sourceLocation: sourceLocation)
    return
  }
  let red = CGFloat((hex >> 16) & 0xFF) / 255
  let green = CGFloat((hex >> 8) & 0xFF) / 255
  let blue = CGFloat(hex & 0xFF) / 255
  #expect(abs(actual.redComponent - red) < 0.004, "red", sourceLocation: sourceLocation)
  #expect(abs(actual.greenComponent - green) < 0.004, "green", sourceLocation: sourceLocation)
  #expect(abs(actual.blueComponent - blue) < 0.004, "blue", sourceLocation: sourceLocation)
}
