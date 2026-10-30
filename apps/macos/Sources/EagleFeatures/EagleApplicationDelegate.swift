import AppKit
import Foundation

@MainActor public final class EagleApplicationDelegate: NSObject, NSApplicationDelegate {
  private let supervisor: BotsDaemonSupervisor
  private let reply: @MainActor () -> Void
  private var quitting = false
  private var replied = false

  public override convenience init() {
    self.init(
      supervisor: .shared, reply: { NSApplication.shared.reply(toApplicationShouldTerminate: true) }
    )
  }

  public init(supervisor: BotsDaemonSupervisor, reply: @escaping @MainActor () -> Void) {
    self.supervisor = supervisor
    self.reply = reply
    super.init()
  }

  public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if replied { return .terminateNow }
    guard !quitting else { return .terminateLater }
    quitting = true
    Task {
      await supervisor.prepareForApplicationQuit()
      guard !replied else { return }
      replied = true
      reply()
    }
    return .terminateLater
  }

  public func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    DeviceApprovalWindowController.shared.observe(DeviceSettingsViewModel.shared)
    Task { @MainActor in await DeviceSettingsViewModel.shared.startIfNeeded() }
  }

  public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  /// The daemon is a child of the app: quitting the app must not leave it running.
  public func applicationWillTerminate(_ notification: Notification) {
    supervisor.terminateOwnedDaemonFallback()
  }
}
