import AppKit
import Testing

@testable import EagleFeatures

@Suite("Device approval window", .serialized)
@MainActor
struct DeviceApprovalWindowTests {
  @Test("a settings-only App shows a confirmation window and closing it denies the request")
  func settingsOnlyApproval() async throws {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let settings = SettingsWindowController()
    let settingsModel = SettingsViewModel()
    settingsModel.selection = .machines
    settings.show(model: settingsModel, devices: model)
    settings.window?.setFrameOrigin(NSPoint(x: -10000, y: -10000))
    defer {
      model.denyPendingApproval()
      DeviceApprovalWindowController.shared.stopObserving()
      settings.window?.close()
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
