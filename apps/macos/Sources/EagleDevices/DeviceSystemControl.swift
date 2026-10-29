import Foundation
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
  private var client: DeviceXPCClient?
  public var socketPath: String? { configuration?.socketPath }
  public init(bundle: URL = Bundle.main.bundleURL) {
    self.bundle = bundle
    configuration = try? DeviceHostConfiguration.load(bundle: bundle)
  }
  public func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    guard let configuration else { throw DeviceHostError.invalidConfiguration }
    let helper = bundle.appendingPathComponent("Contents/Library/LaunchServices/EagleDeviceHelper")
    let requirement = try DeviceCodeIdentity.requirement(at: helper)
    let service = SMAppService.agent(plistName: configuration.launchAgentPlist)
    if service.status == .notRegistered { try service.register() }
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
    client?.invalidate()
    client = nil
    try await SMAppService.agent(plistName: configuration.launchAgentPlist).unregister()
  }
  public func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}
