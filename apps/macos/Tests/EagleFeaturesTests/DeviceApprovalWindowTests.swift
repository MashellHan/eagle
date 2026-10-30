import AppKit
import Testing

@testable import EagleFeatures

@Suite("Device approval window", .serialized)
@MainActor
struct DeviceApprovalWindowTests {
  @Test("a confirmation window opens by itself and closing it denies the request")
  func independentApproval() async throws {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    // The confirmation belongs to the App, not to any workspace or settings surface.
    DeviceApprovalWindowController.shared.observe(model)
    defer {
      model.denyPendingApproval()
      DeviceApprovalWindowController.shared.stopObserving()
    }
    let request = try deviceApproval(
      expiresAt: Int64(Date().timeIntervalSince1970 * 1000) + 60000)
    let answer = Task { await control.confirm?(request) }
    for _ in 0..<40 {
      if NSApplication.shared.windows.contains(where: { $0.title == "确认设备操作" && $0.isVisible }) {
        break
      }
      try await Task.sleep(for: .milliseconds(5))
    }
    let approval = try #require(
      NSApplication.shared.windows.first { $0.title == "确认设备操作" && $0.isVisible })
    #expect(model.pendingApproval?.id == request.id)
    approval.performClose(nil)
    #expect(await answer.value == false)
  }
}
