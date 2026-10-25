import Foundation

/// Detects a missing revision. The transport owns this so the reducer never sees a gap: a
/// gap drops the events that follow and asks for one resync (PROTOCOL I2).
public struct RevisionGap: Sendable {
  public private(set) var lastRev: Int?

  public init(lastRev: Int? = nil) {
    self.lastRev = lastRev
  }

  /// True when `rev` is exactly the next revision.
  public mutating func accept(_ rev: Int) -> Bool {
    defer { lastRev = rev }
    guard let last = lastRev else { return true }
    return rev == last + 1
  }

  /// A snapshot resets the baseline; its revision is the new last one.
  public mutating func reset(to rev: Int?) {
    lastRev = rev
  }

  /// True when an event arrived behind the baseline (a duplicate or a replay).
  public func isStale(_ rev: Int) -> Bool {
    guard let last = lastRev else { return false }
    return rev <= last
  }
}
