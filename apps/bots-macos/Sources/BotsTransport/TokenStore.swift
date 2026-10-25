import BotsCore
import Foundation

/// The bearer token lives in `<root>/token`, mode 0600 (docs/bots/PROTOCOL.md,
/// "Transport"). The client reads it; it never writes it and never logs it.
public struct TokenStore: Sendable {
  public let root: URL
  private let environment: [String: String]

  public init(
    root: URL = TokenStore.defaultRoot,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.root = root
    self.environment = environment
  }

  public static var defaultRoot: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".local/share/eagle-bots", isDirectory: true)
  }

  public var tokenURL: URL { root.appendingPathComponent("token") }

  public func read() throws -> String {
    // An explicit environment token wins, which is how a supervised test or a second
    // root can point the app at its own daemon without touching the default file.
    if let override = environment["BOTS_TOKEN"], !override.isEmpty {
      return override.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let data: Data
    do {
      data = try Data(contentsOf: tokenURL)
    } catch {
      throw ClientError(
        "no daemon token at \(tokenURL.path); start the daemon with `npm start` first"
      )
    }
    let token = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard token.count >= 32 else {
      throw ClientError("the daemon token at \(tokenURL.path) is not usable")
    }
    return token
  }
}

/// Where the app keeps its settings and its outbox. Application Support, not the daemon
/// root: the client owns this data.
public enum AppPaths {
  public static var supportDirectory: URL {
    let base =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first ?? FileManager.default.homeDirectoryForCurrentUser
    return base.appendingPathComponent("ai.hexly.bots", isDirectory: true)
  }

  public static func ensureSupportDirectory() throws -> URL {
    let directory = supportDirectory
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    return directory
  }
}
