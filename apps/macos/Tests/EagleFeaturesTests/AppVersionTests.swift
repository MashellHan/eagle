import Foundation
import Testing

@testable import EagleFeatures

@Suite("App version and update check")
struct AppVersionTests {
  private func version(
    _ short: String, build: String = "1", identifier: String? = nil
  ) -> AppVersion {
    AppVersion(
      short: short, build: build,
      isRelease: identifier == AppVersion.releaseIdentifier && short != "dev")
  }

  @Test("a dotted version is compared segment by segment")
  func newer() {
    #expect(AppVersion.isNewer("0.16.0", than: "0.15.0"))
    #expect(AppVersion.isNewer("0.15.1", than: "0.15.0"))
    #expect(AppVersion.isNewer("1.0", than: "0.99.99"))
    #expect(!AppVersion.isNewer("0.15.0", than: "0.15.0"))
    #expect(!AppVersion.isNewer("0.15.0", than: "0.15.1"))
    // A pre-release suffix never makes a build newer than the release it precedes.
    #expect(!AppVersion.isNewer("0.16.0-beta.2", than: "0.16.0"))
  }

  @Test("only a signed product build with a real number is a release")
  func releaseIdentity() {
    let info: [String: Any] = [
      "CFBundleShortVersionString": "0.15.0",
      "CFBundleVersion": "1761000000",
      "CFBundleIdentifier": AppVersion.releaseIdentifier,
    ]
    let release = AppVersion.current(bundle: StubBundle(info: info))
    #expect(release.isRelease)
    #expect(release.display == "0.15.0 (1761000000)")

    var candidate = info
    candidate["CFBundleIdentifier"] = "ai.hexly.eagle.macos.device-candidate"
    #expect(!AppVersion.current(bundle: StubBundle(info: candidate)).isRelease)

    var placeholder = info
    placeholder["CFBundleShortVersionString"] = "0.0.0"
    #expect(!AppVersion.current(bundle: StubBundle(info: placeholder)).isRelease)

    let sourceRun = AppVersion.current(bundle: StubBundle(info: nil))
    #expect(!sourceRun.isRelease)
    #expect(sourceRun.display == "开发版")
  }

  @Test("the live answer is read as the app version, and nothing else matters")
  func parsePublished() {
    let data = Data(
      #"{"status":"ok","macos":{"latest":"0.16.0","releaseUrl":"https://github.com/nocoo/eagle/releases/tag/v0.16.0"}}"#
        .utf8)
    let published = PublishedAppVersion.parse(data)
    #expect(published?.latest == "0.16.0")
    #expect(published?.releaseURL?.lastPathComponent == "v0.16.0")

    #expect(PublishedAppVersion.parse(Data(#"{"status":"ok"}"#.utf8)) == nil)
    #expect(PublishedAppVersion.parse(Data(#"{"macos":{"latest":""}}"#.utf8)) == nil)
    #expect(PublishedAppVersion.parse(Data("not json".utf8)) == nil)
  }

  @Test("a product link is only used when it is a real https address")
  func links() {
    let info: [String: Any] = [
      "EagleGitHubURL": "https://github.com/nocoo/eagle",
      "EagleReleaseURL": "https://github.com/nocoo/eagle/releases/latest",
      "EagleUpdatesURL": "http://insecure.example.com/api/live",
    ]
    let links = ProductLinks.current(bundle: StubBundle(info: info))
    #expect(links.github?.host == "github.com")
    #expect(links.release?.lastPathComponent == "latest")
    #expect(links.updates == nil, "a plain-http check endpoint is not used")
  }
}

/// A bundle stand-in: the tests read the same keys the assembled app carries.
private final class StubBundle: Bundle, @unchecked Sendable {
  private let info: [String: Any]?
  init(info: [String: Any]?) {
    self.info = info
    super.init()
  }
  override var infoDictionary: [String: Any]? { info }
}
