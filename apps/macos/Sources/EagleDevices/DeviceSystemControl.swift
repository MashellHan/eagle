import Foundation
import OSLog
import ServiceManagement

@MainActor public protocol DeviceControl: AnyObject {
  var socketPath: String? { get }
  func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool) async throws
  func call(_ method: String, params: DeviceJSON?) async throws -> DeviceJSON
  func stop() async throws
  func openSystemSettings()
}

/// Uses the signed bundle's release configuration. No server or runtime path is user input.
@MainActor public final class DeviceSystemControl: DeviceControl {
  private let bundle: URL
  private let configuration: DeviceHostConfiguration?
  private let defaults: UserDefaults
  private var registration: DeviceServiceRegistration?
  private var client: DeviceXPCClient?
  private let log = Logger(subsystem: "ai.hexly.eagle.devices", category: "background")
  public var socketPath: String? { configuration?.socketPath }
  public init(bundle: URL = Bundle.main.bundleURL, defaults: UserDefaults = .standard) {
    self.bundle = bundle
    self.defaults = defaults
    configuration = try? DeviceHostConfiguration.load(bundle: bundle)
  }
  public func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    guard let configuration else { throw DeviceHostError.invalidConfiguration }
    let helper = bundle.appendingPathComponent("Contents/Library/LaunchServices/EagleDeviceHelper")
    let requirement = try DeviceCodeIdentity.requirement(at: helper)
    let fingerprint = try DeviceServiceRegistration.fingerprint(
      appRequirement: DeviceCodeIdentity.requirement(at: bundle), helperRequirement: requirement,
      executable: Data(contentsOf: helper),
      plist: Data(
        contentsOf: bundle.appendingPathComponent(
          "Contents/Library/LaunchAgents/\(configuration.launchAgentPlist)")))
    let service = SMAppService.agent(plistName: configuration.launchAgentPlist)
    if registration == nil {
      registration = DeviceServiceRegistration(
        service: service, defaults: defaults, profile: configuration.profile)
    }
    guard let registration else { throw DeviceHostError.unavailable }
    log.info("background status before registration: \(service.status.rawValue, privacy: .public)")
    do { try await registration.prepare(fingerprint: fingerprint) } catch {
      let diagnostic = error as NSError
      log.error(
        "background registration failed: \(diagnostic.domain, privacy: .public) \(diagnostic.code, privacy: .public)"
      )
      throw error
    }
    log.info("background status after registration: \(service.status.rawValue, privacy: .public)")
    if service.status == .requiresApproval { throw DevicePortError("background_approval_required") }
    guard service.status == .enabled else { throw DeviceHostError.unavailable }
    client?.invalidate()
    client = DeviceXPCClient(
      connection: NSXPCConnection(machServiceName: configuration.machServiceName),
      requiredPeer: requirement, confirm: confirm)
  }
  public func call(_ method: String, params: DeviceJSON? = nil) async throws -> DeviceJSON {
    guard let client else { throw DeviceHostError.unavailable }
    return try await client.call(method, params: params)
  }
  public func stop() async throws {
    guard let configuration else { throw DeviceHostError.invalidConfiguration }
    if registration == nil {
      registration = DeviceServiceRegistration(
        service: SMAppService.agent(plistName: configuration.launchAgentPlist), defaults: defaults,
        profile: configuration.profile)
    }
    guard let registration else { throw DeviceHostError.unavailable }
    try await registration.stop()
    client?.invalidate()
    client = nil
  }
  public func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}
