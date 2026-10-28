import Foundation
import Testing

@testable import EagleFeatures

@Suite("Bots daemon supervisor")
@MainActor
struct BotsDaemonSupervisorTests {
  private func tree() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-daemon-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("apps/bots/scripts"),
      withIntermediateDirectories: true
    )
    try Data().write(to: root.appendingPathComponent("apps/bots/scripts/serve.ts"))
    return root
  }

  @Test("the daemon is found from a built app's ancestry")
  func resolvesFromAncestry() throws {
    let root = try tree()
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent(
      "apps/macos/.build/Eagle.app/Contents/MacOS/EagleApp"
    )
    let resolved = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: nil,
      executable: executable
    )
    #expect(
      resolved?.standardizedFileURL.path
        == root.appendingPathComponent("apps/bots").standardizedFileURL.path)
  }

  @Test("an explicit directory must actually contain the daemon")
  func explicitDirectory() throws {
    let root = try tree()
    defer { try? FileManager.default.removeItem(at: root) }
    let good = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: root.appendingPathComponent("apps/bots").path,
      executable: nil
    )
    #expect(good != nil)
    let bad = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: root.appendingPathComponent("nope").path,
      executable: nil
    )
    #expect(bad == nil)
  }

  @Test("an explicit node path is used or refused, never silently replaced")
  func nodeResolution() throws {
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/bin/sh"]) == "/bin/sh")
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/nope"]) == nil)
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eagle-node-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let node = root.appendingPathComponent("node")
    try "#!/bin/sh\nexit 0\n".write(to: node, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": node.path]) == node.path)
    // PATH has an actual fixture executable even on hosts without Homebrew Node.
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["PATH": root.path]) != nil)
  }

  @Test func anInstalledAppFindsItsOwnDaemonBeforeRepositoryAncestry() throws {
    let root = try tree()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("Eagle.app")
    let bundled = app.appendingPathComponent("Contents/Resources/Bots")
    try FileManager.default.createDirectory(
      at: bundled.appendingPathComponent("scripts"), withIntermediateDirectories: true)
    try Data().write(to: bundled.appendingPathComponent("scripts/serve.ts"))
    let found = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: nil,
      executable: app.appendingPathComponent("Contents/MacOS/EagleApp"))
    #expect(found?.standardizedFileURL == bundled.standardizedFileURL)
  }

  @Test func savedNodeSelectionWorksWithFinderPathAndExplicitOverrideStillWins() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let node = root.appendingPathComponent("chosen-node")
    try "#!/bin/sh\nexit 0\n".write(to: node, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    let finder = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
    #expect(
      BotsDaemonSupervisor.resolveNode(environment: finder, preference: node.path) == node.path)
    #expect(
      BotsDaemonSupervisor.resolveNode(environment: finder, preference: "/missing-node") == nil)
    #expect(
      BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/bin/sh"], preference: node.path)
        == "/bin/sh")
    #expect(
      BotsDaemonSupervisor.resolveNode(
        environment: ["BOTS_NODE": "relative-node"], preference: node.path) == nil)
  }
}
