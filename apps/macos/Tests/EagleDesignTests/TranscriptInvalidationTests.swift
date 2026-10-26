import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Transcript scroll invalidation")
struct TranscriptInvalidationTests {
  @Test("scroll bookkeeping does not rebuild the transcript body")
  func geometryUpdates() async throws {
    let probe = ScrollProbe()
    let host = NSHostingView(rootView: ScrollProbeView(probe: probe))
    host.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    defer { window.contentView = nil }
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(for: .milliseconds(30))
    let update = try #require(probe.update)
    let baseline = probe.bodies
    for offset in 0..<30 {
      update(CGFloat(1_000 - offset * 10))
      try await Task.sleep(for: .milliseconds(5))
      host.layoutSubtreeIfNeeded()
    }
    #expect(probe.bodies == baseline)
  }
}

@MainActor
private final class ScrollProbe {
  var bodies = 0
  var update: ((CGFloat) -> Void)?
}

private struct ScrollProbeView: View {
  let probe: ScrollProbe
  @State private var scrollState = TranscriptScrollState()

  var body: some View {
    probe.bodies += 1
    return Text("Transcript")
      .onAppear {
        probe.update = { bottom in
          _ = scrollState.update(
            .init(contentHeight: 1_000, visibleBottom: bottom), userIsScrolling: true)
        }
      }
  }
}
