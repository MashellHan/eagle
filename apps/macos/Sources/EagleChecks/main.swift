import AppKit
import EagleDesign
import EagleFeatures
import SwiftUI

/// Dependency-free checks. XCTest ships only with full Xcode, and Swift
/// Testing's macro plugin does not load with a Command Line Tools toolchain,
/// so this executable asserts and exits non-zero on the first failure.
///
///     swift run EagleChecks
@main
struct EagleChecks {
  @MainActor
  static func main() {
    var failures = 0
    func check(_ name: String, _ condition: @autoclosure () -> Bool, _ detail: String = "") {
      if condition() {
        print("  ok   \(name)")
        return
      }
      failures += 1
      print("  FAIL \(name)\(detail.isEmpty ? "" : " — \(detail)")")
    }

    func expectColor(_ name: String, _ color: Color, _ hex: UInt32) {
      guard let actual = NSColor(color).usingColorSpace(.sRGB) else {
        failures += 1
        print("  FAIL \(name) — not convertible to sRGB")
        return
      }
      let red = CGFloat((hex >> 16) & 0xFF) / 255
      let green = CGFloat((hex >> 8) & 0xFF) / 255
      let blue = CGFloat(hex & 0xFF) / 255
      let close =
        abs(actual.redComponent - red) < 0.004
        && abs(actual.greenComponent - green) < 0.004
        && abs(actual.blueComponent - blue) < 0.004
      check("\(name) = #\(String(hex, radix: 16, uppercase: true))", close)
    }

    print("design tokens")
    check("sidebar width 411", Theme.Metric.sidebarWidth == 411)
    check("inspector width 330", Theme.Metric.inspectorWidth == 330)
    check("row height 48", Theme.Metric.rowHeight == 48)
    check("composer height 52", Theme.Metric.composerHeight == 52)
    check("inspector row height 38", Theme.Metric.inspectorRowHeight == 38)
    check("card radius 12", Theme.Metric.cardRadius == 12)
    check("row avatar 32", Theme.Metric.avatarRow == 32)
    check("inspector avatar 72", Theme.Metric.avatarInspector == 72)
    check("content width 720", Theme.Metric.conversationMaxContentWidth == 720)

    print("palette")
    expectColor("canvas", Theme.Palette.canvas, 0xF7F7F5)
    expectColor("surface", Theme.Palette.surface, 0xFFFFFF)
    expectColor("card", Theme.Palette.card, 0xFFFFFF)
    expectColor("line", Theme.Palette.line, 0xECECEA)
    expectColor("textPrimary", Theme.Palette.textPrimary, 0x1F1F1D)
    expectColor("textSecondary", Theme.Palette.textSecondary, 0x84847F)
    expectColor("accent", Theme.Palette.accent, 0x3B7DCD)
    expectColor("accentFill", Theme.Palette.accentFill, 0x4FA46A)
    expectColor("accentStrong", Theme.Palette.accentStrong, 0x58B378)
    check("avatar tints rotate", Theme.Palette.avatarTints.count == 8)

    // LocalState wraps a StateObject, which SwiftUI only installs inside a view
    // graph. The box itself is what carries the value, so exercise it directly.
    print("local state shim")
    let box = LocalStateStorage(1)
    check("reads initial value", box.value == 1)
    box.value = 7
    check("writes propagate", box.value == 7)
    let list = LocalStateStorage(["a"])
    list.value.append("b")
    check("collections mutate in place", list.value == ["a", "b"])

    print("workspace list")
    let workspace = WorkspaceListViewModel()
    workspace.select("knowledge")
    check("selection stored", workspace.selection == "knowledge")
    check("selection resolves item", workspace.selectedItem?.title == "知识库")
    workspace.select("missing")
    check("unknown selection has no item", workspace.selectedItem == nil)
    check("mock groups are populated", workspace.groups.allSatisfy { !$0.items.isEmpty })

    print("chat")
    let chat = ChatViewModel(entries: [])
    chat.draft = "  今天 eagle 会修吗  "
    chat.send()
    check("send appends two rows", chat.entries.count == 2)
    if case .user(let id, let text) = chat.entries.first {
      check("user turn identifier", id == "local-0")
      check("draft trimmed", text == "今天 eagle 会修吗")
    } else {
      failures += 1
      print("  FAIL first entry is a user turn")
    }
    check("typing row follows", chat.entries.last?.id == "typing-0")
    check("draft cleared", chat.draft.isEmpty)
    check("send counter", chat.sentCount == 1)

    let blank = ChatViewModel(entries: [])
    blank.draft = "  \n "
    blank.send()
    check("blank draft ignored", blank.entries.isEmpty)

    print("inspector")
    let inspector = InspectorViewModel()
    let first = inspector.jobs[0]
    inspector.setJob(first.id, isOn: !first.isOn)
    check("job toggled", inspector.jobs[0].isOn == !first.isOn)
    check("job detail preserved", inspector.jobs[0].detail == first.detail)
    let before = inspector.jobs
    inspector.setJob("nope", isOn: true)
    check("unknown job ignored", inspector.jobs == before)
    check("default tab", inspector.tab == .detail)

    print("")
    if failures == 0 {
      print("EagleChecks: all checks passed")
      return
    }
    print("EagleChecks: \(failures) check(s) failed")
    exit(1)
  }
}
