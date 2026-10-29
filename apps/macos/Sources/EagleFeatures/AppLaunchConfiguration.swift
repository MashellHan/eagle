import BotsFeatures
import BotsTransport
import CryptoKit
import Foundation

public enum AppLaunchError: Error, Equatable { case invalidVerification }

/// One explicit composition for the App, its windows and termination cleanup.
/// Verification redirects owned state; it is not an OS execution sandbox.
@MainActor public final class AppLaunchConfiguration {
  public static let current: AppLaunchConfiguration = {
    do { return try AppLaunchConfiguration(environment: ProcessInfo.processInfo.environment) } catch
    {
      FileHandle.standardError.write(Data("Invalid Eagle App verification configuration\n".utf8))
      exit(64)
    }
  }()

  public let environment: [String: String]
  public let defaults: UserDefaults
  public let botsSettings: BotsSettings
  public let verificationRoot: URL?
  public let preferencesDomain: String?
  public let credentialsService: String
  public let outboxDirectory: URL
  public let refusalFallback: URL?
  public let loadsDaemonEnvironment: Bool
  let coordinator: BotRemoteAccessCoordinator
  private let connectsAutomatically: Bool

  public init(environment input: [String: String]) throws {
    guard let path = input["EAGLE_APP_VERIFICATION_ROOT"] else {
      guard input["EAGLE_APP_VERIFICATION_CONNECT_BOTS"] == nil else {
        throw AppLaunchError.invalidVerification
      }
      environment = input
      defaults = .standard
      botsSettings = BotsSettings(environment: input)
      verificationRoot = nil
      preferencesDomain = nil
      credentialsService = "ai.hexly.eagle.machine-access"
      outboxDirectory = AppPaths.supportDirectory
      refusalFallback = nil
      loadsDaemonEnvironment = true
      connectsAutomatically = true
      coordinator = .shared
      return
    }
    let connect = input["EAGLE_APP_VERIFICATION_CONNECT_BOTS"] ?? "0"
    guard path.hasPrefix("/"), !path.contains("\0"),
      let port = input["BOTS_PORT"], let number = Int(port), String(number) == port,
      (1024...65535).contains(number), number != 43117,
      ["0", "1"].contains(connect), Self.privateDirectory(path),
      let resolved = realpath(path, nil)
    else { throw AppLaunchError.invalidVerification }
    defer { free(resolved) }
    let root = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    for name in ["bots", "agent", "config", "outbox", "refusals"] {
      let child = root.appendingPathComponent(name)
      do {
        if !FileManager.default.fileExists(atPath: child.path) {
          try FileManager.default.createDirectory(
            at: child, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
      } catch { throw AppLaunchError.invalidVerification }
      guard Self.privateDirectory(child.path) else { throw AppLaunchError.invalidVerification }
    }
    let digest = SHA256.hash(data: Data(root.path.utf8)).map { String(format: "%02x", $0) }.joined()
    let domain = "ai.hexly.eagle.verification.\(digest)"
    guard let preferences = UserDefaults(suiteName: domain) else {
      throw AppLaunchError.invalidVerification
    }
    let allowed = [
      "PATH", "LANG", "LC_ALL", "TMPDIR", "BOTS_NODE", "BOTS_DAEMON_DIR", "BOTS_CREDENTIAL_HELPER",
      "EAGLE_AGENT_NODE", "EAGLE_AGENT_CLI",
    ]
    var isolated = input.filter { allowed.contains($0.key) }
    isolated["BOTS_ROOT"] = root.appendingPathComponent("bots").path
    isolated["BOTS_PORT"] = port
    isolated["EAGLE_CONFIG"] = root.appendingPathComponent("agent/agent.json").path
    isolated["XDG_CONFIG_HOME"] = root.appendingPathComponent("config").path
    environment = isolated
    defaults = preferences
    botsSettings = BotsSettings(environment: isolated)
    verificationRoot = root
    preferencesDomain = domain
    credentialsService = domain
    outboxDirectory = root.appendingPathComponent("outbox")
    refusalFallback = root.appendingPathComponent("refusals")
    loadsDaemonEnvironment = false
    connectsAutomatically = connect == "1"
    coordinator = BotRemoteAccessCoordinator()
  }

  private static func privateDirectory(_ path: String) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
      return false
    }
    return attributes[.type] as? FileAttributeType == .typeDirectory
      && (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid()
      && (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700
  }

  public func runAutomaticConnection(_ start: @MainActor () async -> Void) async {
    if connectsAutomatically { await start() }
  }

  func makeOutbox() -> OutboxStore {
    OutboxStore(directory: outboxDirectory, refusalFallback: refusalFallback)
  }
}
