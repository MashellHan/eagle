import Foundation

/// The app's own version: releases of the website, the Agent and this App are independent, so
/// the bundle carries its own number and nothing compares it with theirs.
public struct AppVersion: Equatable, Sendable {
  public let short: String
  public let build: String
  /// Only a signed product build asks about newer versions; a source run and a candidate
  /// build are development artifacts and stay quiet.
  public let isRelease: Bool

  public init(short: String, build: String, isRelease: Bool) {
    self.short = short
    self.build = build
    self.isRelease = isRelease
  }

  public static let releaseIdentifier = "ai.hexly.eagle.macos"

  public static func current(bundle: Bundle = .main) -> AppVersion {
    let info = bundle.infoDictionary
    let short = (info?["CFBundleShortVersionString"] as? String) ?? "dev"
    let build = (info?["CFBundleVersion"] as? String) ?? "dev"
    let identifier = (info?["CFBundleIdentifier"] as? String) ?? ""
    let usable = short != "dev" && short != "0.0.0" && !short.isEmpty
    return AppVersion(
      short: short, build: build, isRelease: usable && identifier == releaseIdentifier)
  }

  /// `0.15.0`, with the build number only when it is not the version itself.
  public var display: String {
    guard short != "dev" else { return "开发版" }
    return build == short || build == "dev" ? short : "\(short) (\(build))"
  }

  /// Two dotted numbers compared segment by segment; a build suffix never makes it newer.
  public static func isNewer(_ candidate: String, than current: String) -> Bool {
    func parts(_ value: String) -> [Int] {
      value
        .split(separator: "-", maxSplits: 1)
        .first
        .map { String($0).split(separator: ".").map { Int($0) ?? 0 } } ?? []
    }
    let left = parts(candidate)
    let right = parts(current)
    for index in 0..<max(left.count, right.count) {
      let one = index < left.count ? left[index] : 0
      let two = index < right.count ? right[index] : 0
      if one != two { return one > two }
    }
    return false
  }
}

/// Where the app sends a person who wants a newer build, and where it asks what is published.
/// Both come from the bundle, so a source run of the app carries no address at all.
public struct ProductLinks: Equatable, Sendable {
  public let github: URL?
  public let release: URL?
  public let updates: URL?

  public init(github: URL?, release: URL?, updates: URL?) {
    self.github = github
    self.release = release
    self.updates = updates
  }

  public static func current(bundle: Bundle = .main) -> ProductLinks {
    let info = bundle.infoDictionary
    func url(_ key: String) -> URL? {
      guard let value = info?[key] as? String, value.hasPrefix("https://") else { return nil }
      return URL(string: value)
    }
    return ProductLinks(
      github: url("EagleGitHubURL"),
      release: url("EagleReleaseURL"),
      updates: url("EagleUpdatesURL")
    )
  }
}

/// What the live endpoint says, as one small answer: only the macOS app version matters here.
public struct PublishedAppVersion: Sendable, Equatable {
  public let latest: String
  public let releaseURL: URL?

  public init(latest: String, releaseURL: URL?) {
    self.latest = latest
    self.releaseURL = releaseURL
  }

  /// Reads `macos.latest` from the live payload, ignoring everything else it carries.
  public static func parse(_ data: Data) -> PublishedAppVersion? {
    guard
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let macos = object["macos"] as? [String: Any],
      let latest = macos["latest"] as? String,
      !latest.isEmpty
    else { return nil }
    let url = (macos["releaseUrl"] as? String).flatMap {
      $0.hasPrefix("https://") ? URL(string: $0) : nil
    }
    return PublishedAppVersion(latest: latest, releaseURL: url)
  }
}
