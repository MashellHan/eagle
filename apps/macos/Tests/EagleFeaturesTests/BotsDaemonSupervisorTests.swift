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
  func nodeResolution() {
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/bin/sh"]) == "/bin/sh")
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/nope"]) == nil)
    // Without an explicit path the machine's node is found (Homebrew or /usr/bin).
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["PATH": "/bin"]) != nil)
  }
}
