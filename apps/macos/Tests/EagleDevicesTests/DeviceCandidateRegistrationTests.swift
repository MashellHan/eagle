import Darwin
import Foundation
import Testing

@testable import EagleDevices

@Suite("Candidate bundle registration")
struct DeviceCandidateRegistrationTests {
  @Test("forced registration waits for the exact App refresh to complete")
  func refreshBundle() throws {
    let root = try fixture("printf '%s\\n' \"$@\" > \"$0.arguments\"\n")
    defer { try? FileManager.default.removeItem(at: root) }
    let bundle = root.appendingPathComponent("App with spaces.app")
    try DeviceCandidateRegistration(executable: root.appendingPathComponent("registrar"))
      .refresh(bundle)
    let arguments = try String(
      contentsOf: root.appendingPathComponent("registrar.arguments"), encoding: .utf8)
    #expect(arguments == "-f\n\(bundle.path)\n")
  }

  @Test("an unsuccessful refresh does not report registration success")
  func failedRefresh() throws {
    let root = try fixture("exit 17\n")
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      try DeviceCandidateRegistration(executable: root.appendingPathComponent("registrar"))
        .refresh(root.appendingPathComponent("Candidate.app"))
      Issue.record("a failed registrar must reject startup")
    } catch let error as DevicePortError {
      #expect(error.code == "background_registration_failed")
    }
  }

  @Test("a stalled registrar is bounded and its owned process is stopped")
  func stalledRefresh() throws {
    let root = try fixture("exec /bin/sleep 10\n")
    defer { try? FileManager.default.removeItem(at: root) }
    let started = ContinuousClock.now
    let process = Process()
    do {
      try DeviceCandidateRegistration(
        executable: root.appendingPathComponent("registrar"), timeout: 0.1
      ).refresh(root.appendingPathComponent("Candidate.app"), process: process)
      Issue.record("a stalled registrar must reject startup")
    } catch let error as DevicePortError {
      #expect(error.code == "background_registration_failed")
    }
    #expect(started.duration(to: .now) < .seconds(2))
    #expect(!process.isRunning)
    #expect(kill(process.processIdentifier, 0) == -1)
    #expect(errno == ESRCH)
  }

  @Test("forced termination finishes before another refresh can start")
  func forcedTermination() throws {
    let root = try fixture("trap '' TERM\nexec /bin/sleep 10\n")
    defer { try? FileManager.default.removeItem(at: root) }
    let process = Process()
    let registrar = DeviceCandidateRegistration(
      executable: root.appendingPathComponent("registrar"), timeout: 1)
    do {
      try registrar.refresh(root.appendingPathComponent("Candidate.app"), process: process)
      Issue.record("a stalled registrar must reject startup")
    } catch let error as DevicePortError {
      #expect(error.code == "background_registration_failed")
    }
    #expect(!process.isRunning)
    #expect(kill(process.processIdentifier, 0) == -1)
    #expect(errno == ESRCH)
    try "#!/bin/sh\nexit 0\n".write(
      to: root.appendingPathComponent("registrar"), atomically: false, encoding: .utf8)
    try registrar.refresh(root.appendingPathComponent("Candidate.app"))
  }

  private func fixture(_ script: String) throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-registrar-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let executable = root.appendingPathComponent("registrar")
    try ("#!/bin/sh\n" + script).write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    return root
  }
}
