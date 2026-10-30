import AppKit
import EagleDesign
import SwiftUI

/// One resizable settings window retains edits and its size across openings.
@MainActor
public final class SettingsWindowController {
  public static let shared = SettingsWindowController()
  private(set) var window: NSWindow?
  private var model: SettingsViewModel?

  public init() {}

  public func show(
    model: SettingsViewModel, daemon: BotsDaemonSupervisor? = nil,
    devices: DeviceSettingsViewModel = .shared
  ) {
    DeviceApprovalWindowController.shared.observe(devices)
    if let window {
      self.model?.selection = model.selection
      window.makeKeyAndOrderFront(nil)
      return
    }
    let window = NSWindow(
      contentRect: NSRect(
        x: 0, y: 0, width: Theme.Metric.settingsWidth, height: Theme.Metric.settingsHeight),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.title = "Eagle 设置"
    window.titlebarAppearsTransparent = true
    window.contentMinSize = NSSize(width: 900, height: 620)
    window.contentView = NSHostingView(
      rootView: SettingsView(
        model: model, onClose: { [weak window] in window?.close() },
        daemon: daemon, devices: devices, showsCloseButton: false))
    if !window.setFrameUsingName("EagleSettings") { window.center() }
    window.setFrameAutosaveName("EagleSettings")
    self.model = model
    self.window = window
    window.makeKeyAndOrderFront(nil)
  }
}
