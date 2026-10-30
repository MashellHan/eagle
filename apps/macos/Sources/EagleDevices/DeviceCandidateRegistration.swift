import Darwin
import Foundation
import OSLog

/// Ad-hoc updates need the Apple registrar's forced bundle refresh before SM registration.
/// This touches only the complete current App; it never resets an LS or BTM database.
final class DeviceCandidateRegistration {
  static let systemExecutable = URL(
    fileURLWithPath:
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  )
  private let executable: URL
  private let timeout: TimeInterval
  private var ownedProcess: Process?

  init(executable: URL = systemExecutable, timeout: TimeInterval = 3) {
    self.executable = executable
    self.timeout = timeout
  }

  /// Called by the background service actor, never the App's main actor.
  func refresh(_ bundle: URL, process: Process = Process()) throws {
    try Task.checkCancellation()
    guard ownedProcess?.isRunning != true else {
      throw DevicePortError("background_registration_failed")
    }
    ownedProcess = process
    defer { if !process.isRunning { ownedProcess = nil } }
    process.executableURL = executable
    process.arguments = ["-f", bundle.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    let log = Logger(subsystem: "ai.hexly.eagle.devices", category: "background")
    do { try process.run() } catch {
      log.error("candidate bundle registrar could not start")
      throw DevicePortError("background_registration_failed")
    }
    guard finished.wait(timeout: .now() + timeout) == .success else {
      if process.isRunning { process.terminate() }
      if finished.wait(timeout: .now() + 0.25) != .success, process.isRunning {
        // Only this owned short-lived registrar process may be terminated.
        kill(process.processIdentifier, SIGKILL)
        _ = finished.wait(timeout: .now() + 0.25)
      }
      // An unconfirmed exit retains ownership and blocks a later registration attempt.
      log.error("candidate bundle registrar timed out")
      throw DevicePortError("background_registration_failed")
    }
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
      log.error("candidate bundle registrar failed: \(process.terminationStatus, privacy: .public)")
      throw DevicePortError("background_registration_failed")
    }
    try Task.checkCancellation()
  }
}
