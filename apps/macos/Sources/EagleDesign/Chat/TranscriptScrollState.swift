import Foundation

struct TranscriptScrollMetrics: Equatable {
  let contentHeight: CGFloat
  let visibleBottom: CGFloat
}

struct TranscriptScrollState {
  private(set) var followsBottom = true
  private var contentHeight: CGFloat = 0
  private var visibleBottom: CGFloat?
  private var pendingFollow = false

  mutating func update(_ metrics: TranscriptScrollMetrics, userIsScrolling: Bool) -> Bool {
    let resized = metrics.contentHeight != contentHeight
    let movedUp = visibleBottom.map { metrics.visibleBottom < $0 } ?? false
    let moved = visibleBottom != metrics.visibleBottom
    let first = visibleBottom == nil
    contentHeight = metrics.contentHeight
    visibleBottom = metrics.visibleBottom
    if userIsScrolling {
      if first || movedUp || (!resized && moved) {
        followsBottom = metrics.visibleBottom >= metrics.contentHeight - 20
      }
      pendingFollow = followsBottom && (pendingFollow || resized)
      return false
    }
    let shouldFollow = followsBottom && (resized || pendingFollow)
    pendingFollow = false
    return shouldFollow
  }

  mutating func endUserScroll() -> Bool {
    defer { pendingFollow = false }
    return followsBottom && pendingFollow
  }
}
