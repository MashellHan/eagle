import AppKit
import EagleDevices
import SwiftUI
import Testing

@testable import EagleFeatures

@Suite("Device settings layout", .serialized)
@MainActor
struct DeviceSettingsLayoutTests {
  @Test("the local machine remains listed before its service starts", arguments: [true, false])
  func unavailableLocalDevice(disabled: Bool) async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set(disabled, forKey: DeviceSettingsViewModel.disabledKey)
    control.startError = DevicePortError("background_approval_required")
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    #expect(titles.contains { $0.contains(name) && $0.contains("本机") })
    let status = disabled ? "设备服务已关闭" : "本机未就绪"
    #expect(titles.contains { $0.contains(name) && $0.contains(status) })
    #expect(!model.localReady)
  }

  @Test("a known local machine stays visible with its disabled service state")
  func disabledKnownLocalDevice() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let name = try #require(model.directory?.devices.first?.name)
    await model.setEnabled(false)
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    #expect(titles.contains { $0.contains(name) && $0.contains("设备服务已关闭") })
  }

  @Test("pairing inputs stay out of the default device overview")
  func pairingStartsCollapsed() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    #expect(titles.contains("启用设备服务"))
    #expect(titles.contains("配对设备"))
    #expect(!titles.contains("生成本机配对码"))
    #expect(!titles.contains("另一台设备的配对码"))
  }

  @Test("an unresolved pairing stays visible without expanding the pairing section")
  func pendingPairingStaysVisible() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set(UUID().uuidString.lowercased(), forKey: DeviceSettingsViewModel.pendingRedeemKey)
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    await model.startIfNeeded()
    #expect(model.pendingRedeemRequestId != nil)
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    #expect(titles.contains("查询配对结果"))
    #expect(titles.contains("用原请求重试"))
  }

  private func makeHost(
    _ model: DeviceSettingsViewModel
  ) -> (
    NSHostingView<DeviceSettingsView>, NSWindow
  ) {
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: DeviceSettingsView(model: model))
    host.frame = NSRect(x: 0, y: 0, width: 660, height: 1100)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 660, height: 1100),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    return (host, window)
  }

  private func title(_ node: NSObject) -> String? {
    for name in ["AXTitle", "AXDescription", "AXValue"] {
      if let value = attribute(node, name) as? String, !value.isEmpty { return value }
    }
    return nil
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXChildren": "accessibilityChildren", "AXValue": "accessibilityValue",
      ][name] ?? name)
    if node.responds(to: selector) { return node.perform(selector)?.takeUnretainedValue() }
    let legacy = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: legacy) else { return nil }
    return node.perform(legacy, with: name)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
