import SwiftUI

struct InspectorTaskTree: Shape {
  let depths: [Int]

  static func parents(for depths: [Int]) -> [Int?] {
    var ancestors: [Int: Int] = [:]
    return depths.enumerated().map { index, rawDepth in
      let depth = max(0, rawDepth)
      ancestors = ancestors.filter { $0.key < depth }
      let parent = ancestors[depth - 1]
      ancestors[depth] = index
      return parent
    }
  }

  func path(in rect: CGRect) -> Path {
    let parents = Self.parents(for: depths)
    var children: [Int: [Int]] = [:]
    for (child, parent) in parents.enumerated() {
      if let parent { children[parent, default: []].append(child) }
    }
    let stride = Theme.Metric.panelTaskRowHeight + Theme.Metric.panelTaskRowGap
    let center = Theme.Metric.panelTaskRowHeight / 2
    let clearance = Theme.Metric.panelTaskGuideClearance
    let radius = Theme.Metric.panelTaskGuideRadius
    var path = Path()
    for parent in children.keys.sorted() {
      guard let rows = children[parent], let last = rows.last else { continue }
      let x =
        CGFloat(max(0, depths[parent])) * Theme.Metric.panelTaskIndent
        + Theme.Metric.panelSectionGlyphWidth / 2
      let startY =
        CGFloat(parent) * stride + center
        + Theme.Metric.panelSectionGlyph / 2 + clearance
      let lastY = CGFloat(last) * stride + center
      let endX = CGFloat(depths[last]) * Theme.Metric.panelTaskIndent - clearance
      path.move(to: CGPoint(x: x, y: startY))
      path.addLine(to: CGPoint(x: x, y: lastY - radius))
      path.addQuadCurve(
        to: CGPoint(x: x + radius, y: lastY), control: CGPoint(x: x, y: lastY))
      path.addLine(to: CGPoint(x: endX, y: lastY))
      for child in rows.dropLast() {
        let y = CGFloat(child) * stride + center
        path.move(to: CGPoint(x: x, y: y))
        path.addLine(to: CGPoint(x: endX, y: y))
      }
    }
    return path
  }
}
