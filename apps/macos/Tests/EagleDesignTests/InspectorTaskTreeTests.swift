import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Inspector task tree guides")
struct InspectorTaskTreeTests {
  @Test("guide parents follow the visible hierarchy and never cross independent roots")
  func parents() {
    #expect(InspectorTaskTree.parents(for: [0, 1, 2, 1, 2, 0, 1]) == [nil, 0, 1, 0, 3, nil, 5])
    #expect(InspectorTaskTree.parents(for: [0, 2, 0, 1]) == [nil, nil, nil, 2])
    #expect(InspectorTaskTree.parents(for: []).isEmpty)
  }

  @Test("each parent has one rounded trunk ending at its last child")
  func geometry() {
    let rect = CGRect(x: 0, y: 0, width: 280, height: 148)
    let path = InspectorTaskTree(depths: [0, 1, 2, 1, 0]).path(in: rect)
    var elbows = 0
    var starts = 0
    path.cgPath.applyWithBlock { element in
      switch element.pointee.type {
      case .addQuadCurveToPoint: elbows += 1
      case .moveToPoint: starts += 1
      default: break
      }
    }
    #expect(elbows == 2)
    #expect(starts == 3, "two shared trunks and one intermediate sibling branch")
    let stride = Theme.Metric.panelTaskRowHeight + Theme.Metric.panelTaskRowGap
    #expect(path.boundingRect.maxY == stride * 3 + Theme.Metric.panelTaskRowHeight / 2)
    #expect(
      path.boundingRect.maxX == Theme.Metric.panelTaskIndent * 2
        - Theme.Metric.panelTaskGuideClearance)
    #expect(InspectorTaskTree(depths: [0, 0]).path(in: rect).isEmpty)
    #expect(InspectorTaskTree(depths: []).path(in: rect).isEmpty)
  }

  @Test("nested task rows draw dashed guides and stop before the next root")
  func visibleGuides() throws {
    let tasks = [0, 1, 1, 0].enumerated().map { index, depth in
      InspectorTaskRow(
        id: "t_\(index)", title: "Task \(index)", symbolName: "circle", status: "Waiting",
        depth: depth, isRunning: false, isBlocked: false)
    }
    let section = InspectorSections.detail(artifacts: [], jobs: [], tasks: tasks, usage: [])[3]
    for scheme in [ColorScheme.light, .dark] {
      let renderer = ImageRenderer(
        content: InspectorSectionView(section: section)
          .frame(width: 280)
          .background(Theme.Palette.surface)
          .preferredColorScheme(scheme))
      renderer.scale = 2
      let image = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
      let background = try #require(
        image.colorAt(x: 0, y: image.pixelsHigh - 1)?.usingColorSpace(.sRGB))
      let x = Int(Theme.Metric.panelSectionGlyphWidth)
      let bodyTop = Theme.Metric.sectionHeaderHeight + Theme.Metric.panelSectionBodyGap
      let stride = Theme.Metric.panelTaskRowHeight + Theme.Metric.panelTaskRowGap
      func hasInk(_ y: Int) -> Bool {
        guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return false }
        return abs(color.redComponent - background.redComponent) > 0.05
      }
      let trunk =
        Int((bodyTop + Theme.Metric.panelTaskRowHeight) * 2)..<Int((bodyTop + stride * 2 + 8) * 2)
      let ink = trunk.filter(hasInk).count
      #expect(ink > 8, "the hierarchy must have visible guide segments")
      #expect(trunk.count - ink > 8, "the guide is dashed, not a solid rule")
      let afterBranch = Int((bodyTop + stride * 2 + 20) * 2)..<Int((bodyTop + stride * 3 + 4) * 2)
      #expect(afterBranch.filter(hasInk).isEmpty, "a completed branch must not join the next root")
    }
  }
}
